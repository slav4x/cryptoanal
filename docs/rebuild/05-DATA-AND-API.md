# Данные и API

## 1. Основные принципы

1. Любая пользовательская сущность принадлежит `workspaceId` уже в P0.
2. Identity приходит из `RequestContext`, а не из body/query.
3. Версии стратегии и inputs завершённых runs неизменяемы.
4. Деньги, цены и количества не хранятся как binary float.
5. API schema — источник типов frontend и OpenAPI.
6. Тяжёлые операции асинхронны и имеют job/run status.
7. Секреты и внутренние exchange payload не попадают в обычные DTO.
8. У каждой метрики есть provenance и freshness.

## 2. Модель P0

### Workspace seam

`Workspace` можно создать одной seed-записью `development`. Это не пользовательская фича,
но реальный foreign key для ownership.

Все перечисленные сущности обязаны иметь `workspaceId`:

- strategy, version, validation run;
- deployment, execution run;
- exchange account reference;
- position, order, fill, trade;
- decision, journal entry, playbook;
- notification preference, saved view;
- audit event и workspace settings.

Market candles/reference data могут быть глобальными, если они не содержат account data.

### Strategy

```text
Workspace
Strategy
StrategyVersion
StrategyVersionArtifact
ValidationRun
ValidationWindow
ValidationMetric
Deployment
ExecutionRun
```

Ключевые связи:

- `Strategy.workspaceId`;
- `StrategyVersion.strategyId`, `version`, `config`, `configHash`, `createdBy`;
- `ValidationRun.strategyVersionId`, `datasetId`, `engineVersion`, `status`, `verdict`;
- `Deployment.strategyVersionId`, `environment`, `status`;
- `ExecutionRun.deploymentId`, `strategyVersionId`, `configHash`.

### Trading

```text
Position
PositionEvent
Order
Fill
Trade
Decision
RiskSnapshot
MarketSnapshotRef
```

Позиция и сделка обязаны ссылаться на `workspaceId`, `executionRunId`,
`strategyVersionId`, `environment`, `symbol`. Итоговый PnL раскладывается на gross PnL,
fees, funding, slippage и net PnL.

### Research workflow

```text
JournalEntry
JournalLink
ReviewSession
Playbook
PlaybookVersion   # можно отложить до P1
```

`JournalLink` связывает запись с trade, validation run, strategy version или decision,
не копируя их данные в JSON.

### Reliability

```text
OutboxEvent
AuditEvent
HealthSnapshot
Incident
Job
```

Raw application logs остаются в log storage; не нужно дублировать каждый log line в БД.

## 3. Поля, добавляемые сейчас ради будущего P1

- `workspaceId` — реальный FK и обязательный индекс;
- `createdByActorId`, `updatedByActorId` — пока development/system actor;
- `visibility` только там, где будущая публикация действительно нужна;
- `exchangeAccountId` — ссылка, а не credentials;
- composite unique constraints внутри workspace;
- audit metadata для dangerous actions.

Не добавлять заранее:

- nullable `userId` во все таблицы;
- owner email в предметные сущности;
- фиктивные membership/role tables;
- billing fields;
- public slug у каждой внутренней сущности.

После P1 ownership остаётся workspace-based; user отвечает за identity и membership,
а не заменяет `workspaceId`.

## 4. Типы чисел и времени

- денежные значения/цены/quantity: `Decimal` или integer minor units согласно домену;
- проценты/ratios: Decimal с документированным scale;
- timestamp: UTC `timestamptz`;
- торговый день/календарь: отдельная timezone policy;
- duration: integer milliseconds/seconds с единицей в имени;
- id: UUID/ULID с единым стандартом;
- config/result JSON: schema version + hash.

Запрещены неоднозначные поля `value`, `time`, `profit`, если единица/семантика не следует
из type/schema.

## 5. API modules P0

```text
/api/v1/overview
/api/v1/markets
/api/v1/markets/:symbol
/api/v1/watchlist
/api/v1/positions
/api/v1/trades
/api/v1/strategies
/api/v1/strategy-versions
/api/v1/validations
/api/v1/deployments
/api/v1/execution-runs
/api/v1/analytics
/api/v1/health
/api/v1/activity
/api/v1/journal
/api/v1/playbooks
/api/v1/system/logs
/api/v1/settings
/api/v1/jobs
```

Это private dashboard API. Public API появляется только на landing-этапе как отдельная
sanitized projection.

Реализованный срез этапа 2 использует `GET /api/v1/trades` как единый trading
read-model для summary, открытых позиций и последних завершённых сделок. Watchlist
изменяется идемпотентными командами `PUT /api/v1/watchlist/:symbol` и
`DELETE /api/v1/watchlist/:symbol`; текущее состояние входит в market DTO. Детальный
`GET /api/v1/trades/:tradeId` возвращает финансовый результат, immutable runtime
context, связанные orders и fills. Пагинация торговой истории остаётся следующим
срезом.

## 6. Команды и queries

Чтение и изменение разделяются концептуально, даже без тяжёлого CQRS framework.

Примеры commands:

```text
CreateStrategy
CreateStrategyVersion
QueueValidationRun
ApproveStrategyVersion
CreateDeployment
StartDeployment
PauseDeployment
StopDeployment
ClosePosition
CreateJournalEntry
ArchivePlaybook
```

Dangerous command содержит idempotency key, expected version/state и reason. Сервер
проверяет workspace, transition и policy до постановки операции.

## 7. Общий HTTP-контракт

### Success

```json
{
  "data": {},
  "meta": {
    "requestId": "...",
    "generatedAt": "...",
    "freshness": "fresh"
  }
}
```

### Error

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "...",
    "fields": {},
    "requestId": "..."
  }
}
```

Ошибки имеют стабильный machine code. Пользовательский текст формируется предсказуемо,
а internal stack не возвращается клиенту.

### Lists

- cursor pagination для логов/activity и растущих event streams;
- page/limit либо cursor для trades/runs по выбранной модели;
- server-side sorting/filtering;
- filters отражаются в URL;
- response включает применённые filters и continuation.

## 8. Jobs

Backtest, walk-forward, import/export и тяжёлая регенерация analytics работают так:

1. API валидирует command;
2. создаёт `Job` и immutable input;
3. возвращает `202` + `jobId/runId`;
4. worker забирает job;
5. UI получает статус polling с backoff, SSE или websocket;
6. cancel разрешён только для cancellable state;
7. итог хранит provenance и error summary.

## 9. Временный access API

Если dashboard развёрнут удалённо, минимальный gate может иметь только:

```text
POST /dev-access/login
POST /dev-access/logout
GET  /dev-access/session
```

Сервер сравнивает пароль/hash, rate-limits попытки и выдаёт signed `HttpOnly`, `Secure`,
`SameSite` cookie. Эти endpoints удаляются или заменяются в P1. Credentials никогда не
возвращаются и не сохраняются в localStorage.

Альтернатива ещё проще — Basic Auth на reverse proxy. Она предпочтительна для одного
закрытого стенда, если не нужен экран входа.

## 10. Auth/workspace API P1

Добавляется после dashboard:

```text
/api/v1/auth/*
/api/v1/me
/api/v1/workspaces
/api/v1/workspaces/:id/members
/api/v1/exchange-connections
```

RequestContext начинает строиться из session. Все существующие предметные endpoints
сохраняют contracts, но repository scope теперь проверяется membership/policy.

## 11. Public API P2

Будущий public API не переиспользует private DTO напрямую. Он отдаёт только явно
разрешённые проекции:

- агрегированный/задержанный track record;
- методологию и validation summary;
- публичные strategy profiles без точных edge thresholds;
- system status без account/runtime internals.

## 12. Миграция из старого проекта

1. Зафиксировать read-only snapshot старой схемы.
2. Описать mapping каждого переносимого поля.
3. Создать одну baseline migration новой БД.
4. Импортировать только данные с понятным provenance.
5. Присвоить всё одному `development` workspace.
6. Пересчитать projections новой версией engine и пометить различия.
7. Старые неоднозначные JSON/invalid funding results оставить в archive.

Не переносить 19 старых миграций как историю нового продукта.
