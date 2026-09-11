# Целевая техническая архитектура

> Статус: monorepo, dashboard/API/worker boundaries, contracts, Prisma ownership и auth
> resolver реализованы. Перечни ниже сохраняют также целевые пакеты поздних этапов;
> отсутствие такого пакета в текущем дереве не означает незавершённость базового P1.

## 1. Подход

Новый проект остаётся TypeScript monorepo, но границы определяются приложениями и
предметными пакетами. Dashboard-first не означает frontend-only: данные, contracts и
ownership должны быть правильными с первого этапа, иначе auth потребует второго rebuild.

Фактический стек:

- React + Vite для dashboard;
- React Router для маршрутов;
- TanStack Query для server state;
- shadcn/ui + Tailwind + CSS variables для UI;
- Fastify для HTTP API;
- PostgreSQL + Prisma для persistence;
- отдельный worker/runtime для торговли и validation jobs;
- Zod schemas и общие DTO для контрактов;
- собственные tokenized SVG charts в dashboard.

Не менять dashboard на Next.js только ради будущего лендинга. Marketing app можно позже
добавить отдельно на подходящем SSR/SSG framework.

## 2. Структура репозитория

```text
cryptoanal/
  apps/
    dashboard/          # закрытый React/Vite интерфейс
    api/                # Fastify HTTP boundary
    worker/             # execution, schedules, validation jobs
    marketing/          # добавить только на landing-этапе
  packages/
    contracts/          # schemas, DTO, API error model
    config/             # typed server config
    trading-domain/     # сигналы, риск, позиции, fills, costs
    application/        # use cases и ports
    persistence/        # Prisma repositories и transactions
    exchange-bybit/     # Bybit adapter
    analytics/          # отчёты и breakdowns
    ui/                 # shadcn components, tokens, charts
    observability/      # logs, metrics, tracing helpers
    test-fixtures/      # datasets/clocks/factories, когда начнётся реализация
  tools/
    research/           # Python/одноразовые исследования вне runtime
  docs/
    architecture/
    product/
    operations/
    research-archive/
  prisma/
    schema.prisma
    migrations/
  package.json
  pnpm-workspace.yaml
```

`apps/marketing` не создавать в dashboard-first этапе.

## 3. Зависимости между слоями

```text
dashboard -> contracts + ui
api       -> contracts + application + observability
worker    -> application + trading-domain + observability
application -> trading-domain + ports
persistence -> application ports
exchange-bybit -> application ports
analytics -> trading-domain/contracts
```

Запрещено:

- dashboard импортирует Prisma или domain implementation;
- domain читает env, часы, сеть или БД;
- API напрямую вызывает exchange client;
- worker импортирует HTTP route handlers;
- feature component использует raw colors вместо design tokens;
- application use case получает workspace из request body.

## 4. Приложения

### `apps/dashboard`

Отвечает за маршрутизацию, composition UI, формы и cache. Рекомендуемая feature-структура:

```text
src/
  app/                  # router, providers, shell
  features/
    overview/
    markets/
    trades/
    strategies/
    validation/
    analytics/
    activity/
    journal/
    playbooks/
    settings/
  shared/               # dashboard-specific helpers
```

Каждый feature имеет `api`, `model`, `ui`, `routes`. Route modules lazy-loaded.
Нет глобального hook, который запрашивает весь продукт каждые пять секунд.

### `apps/api`

Тонкий HTTP boundary:

- получает `RequestContext`;
- валидирует params/query/body;
- вызывает один application use case;
- преобразует result в versioned DTO;
- возвращает единый error envelope;
- не содержит расчётов PnL, risk или strategy rules.

Routes делятся по модулям, а не живут в одном `server.ts`.

### `apps/worker`

Выполняет:

- market polling/stream consumption;
- trading cycles;
- reconciliation;
- queued backtest/walk-forward;
- report projections;
- scheduled health checks и notifications.

API создаёт command/job, worker исполняет. Долгий validation run не держит HTTP request.

## 5. RequestContext и подготовка к пользователям

Все application use cases получают context отдельно от пользовательского input:

```ts
type RequestContext = {
  actorId: string;
  workspaceId: string;
  role: "owner" | "member" | "system";
  requestId: string;
};
```

Resolver строится из server-side session и membership. Ни один repository method не
должен иметь скрытый «global scope» для пользовательских сущностей.

System jobs также имеют явный system actor и workspace. Это необходимо для audit trail.

## 6. Runtime design

### Immutable ExecutionContext

Каждый запуск получает immutable snapshot:

```text
workspaceId
deploymentId
executionRunId
strategyVersionId
configHash
engineVersion
environment
exchangeAccountId
startedAt
clock
```

Нельзя накладывать стратегию через `Object.assign` на global config. Открытая позиция
всегда управляется версией, с которой была открыта, либо проходит явную migration policy.

### Единая execution semantics

Signal evaluation, sizing, costs, fill policy и exit rules — чистые доменные функции,
которые используют runtime и validation. Отличия среды передаются через adapters/policies,
а не через копирование большой функции.

Текущая реализация находится в `packages/application/src/execution-engine.ts`: validation
прогоняет через неё последовательность исторических свечей, а worker разделяет исполнение
на два контура. Bar-close loop рассчитывает индикаторы и сигналы только по подтверждённой
закрытой свече. Quote loop раз в секунду читает последнюю ticker-котировку, исполняет
ожидающий вход и проверяет SL, TP и trailing-stop по точной цене; промежуточные mark/PnL
пишутся в БД не чаще одного раза в пять секунд. Оба контура используют общие sizing,
slippage, fees и settlement functions, но получают цену через разные adapters: candle в
validation и realtime quote в runtime.

Public market adapter держит одно WebSocket-соединение к Bybit, каждые 30 секунд
синхронизирует динамический набор ticker/kline subscriptions и переподключается после
разрыва. В базу из stream попадают только kline с `confirm=true`. REST polling сохранён как
fallback и периодически закрывает возможные пробелы в истории. При устаревшей или
недоступной realtime quote сопровождение временно возвращается к консервативной OHLC
семантике завершённой свечи.

Runtime cursor хранит последнюю обработанную свечу, pending signal и диагностическое
состояние отдельно для каждой пары запуска. Уникальный correlation id и transaction-level
advisory lock не допускают повторного решения или исполнения при параллельных циклах и
перезапуске worker.

`signal.family` явно выбирает одну из четырёх независимых семантик: `ema-crossover`,
`breakout`, `mean-reversion` или `momentum`. Breakout сравнивает close с предыдущим
диапазоном без включения текущей свечи, momentum реагирует на пересечение порога
lookback-return, mean-reversion входит только после возврата z-score из экстремальной зоны
при подтверждении RSI и закрывается при достижении средней. Параметры других семейств
остаются совместимыми defaults, но не участвуют в решении выбранного алгоритма.

Pause блокирует только новые входы: открытые позиции продолжают получать mark, trailing
и автоматические exits. Stop разрешён только без открытых позиций. Ручной exit проходит
через ту же settlement semantics, после чего одной транзакцией создаются exit order,
fill, trade, decision, audit event и idempotency receipt.

### State machines

Для `Deployment`, `ExecutionRun`, `ValidationRun`, `Position` использовать явные допустимые
переходы. Команда с неверным состоянием отклоняется детерминированно и фиксируется в audit.

### Transactional persistence

Не хранить всю торговую историю как memory snapshot с полной перезаписью. Каждая бизнес-
операция выполняет точечную транзакцию и пишет outbox event. Внешние уведомления и
projection updates происходят после durable commit.

## 7. Strategy configuration

Вместо одного плоского объекта:

```text
StrategyConfig
  universe
  signal
  filters
  risk
  entry
  exit
  costs
  schedule
```

Каждый блок имеет собственную schema и UI section. Research-only параметры не входят в
production schema, пока соответствующая ветка не поддерживается runtime.

## 8. Analytics architecture

Разделить:

- source events: decisions, orders, fills, position events;
- canonical trades/positions;
- projections: overview, performance report, health, public track record;
- ad hoc queries: фильтры и breakdowns.

Тяжёлые агрегаты могут кэшироваться/материализоваться, но cache key обязан включать
workspace, environment, period, strategy version и data revision.

## 9. Конфигурация

- env читается только в composition root;
- конфигурация валидируется при старте;
- client-visible env содержит только несекретные значения;
- секреты никогда не имеют префикса `VITE_`;
- environment и trading mode — разные понятия;
- invalid production/live combination останавливает запуск.

Временный development gate не используется. API работает с database users, opaque
server-side sessions, membership resolver и CSRF; подробности — в
`13-AUTH-WORKSPACE-ARCHITECTURE.md`.

## 10. Что не строить без отдельного продуктового решения

- generic RBAC engine;
- billing abstraction;
- Kubernetes/microservices ради масштаба;
- multi-exchange plugin system;
- public API и marketing SSR;
- universal strategy DSL;
- полноценный event sourcing.

Нужно оставить интерфейсы там, где уже есть реальный второй implementation case, но не
создавать абстракции «на будущее» без потребителя.
