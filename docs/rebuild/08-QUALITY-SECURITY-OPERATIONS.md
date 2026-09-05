# Качество, безопасность и эксплуатация

Этот документ задаёт требования для будущей реализации. В рамках текущей задачи тесты
кода и бота не запускаются и не изменяются.

## 1. Quality gates реализации

Когда начнётся код, каждый этап должен иметь:

- formatting/lint;
- TypeScript typecheck;
- unit tests доменных правил;
- contract validation;
- production build затронутого app;
- migration check для schema changes;
- краткое ручное подтверждение ключевого workflow;
- обновление active docs.

Полный suite не обязан запускаться при правке документации, но критические trading
изменения нельзя принимать только по UI-проверке.

## 2. Набор будущих проверок

### Domain

- signal/risk/sizing/exit/cost functions;
- deterministic Clock и IDs;
- state transitions;
- partial fills и retries;
- fee/funding/slippage accounting;
- daily loss/exposure/correlation limits;
- runtime/backtest equivalence на golden events.

### Persistence

- transaction atomicity;
- idempotency;
- outbox delivery;
- workspace scoping каждого repository;
- unique constraints внутри workspace;
- Decimal/time round trips;
- migrations и import mapping.

### API

- schemas и error envelope;
- command state/version conflicts;
- pagination/filtering;
- workspace access после P1;
- secret redaction;
- long job lifecycle.

### Dashboard

- route loading/error/empty/stale states;
- filters ↔ URL;
- dangerous action confirmation;
- async command status;
- accessibility keyboard flow;
- design token/visual regressions для primitives;
- route lazy loading и query policy.

### E2E critical paths

- создать strategy → version → validation → approve → deploy;
- открыть overview → позицию → trade details → journal note;
- сравнить два validation runs;
- pause/stop runtime;
- после P1: два workspace не видят данные друг друга.

## 3. Известные regression cases из старого проекта

- wall-clock меняет funding/PnL тест;
- runtime/backtest расходятся по signal/timeframe/grid;
- persistence failure происходит после уведомления;
- partial workspace scope раскрывает глобальные trades/report;
- multi-profile исполняет только одну leg;
- global frontend polling работает на любом route;
- invalid funding strategy продолжает называться validated;
- frontend/backend DTO расходятся вручную.

Эти случаи должны стать явными проверками/architecture constraints, а не потеряться при
переписывании.

## 4. Безопасность P0

P0 dashboard содержит управляющие действия, account data и параметры стратегии, поэтому
не является публичным продуктом.

Допустимые режимы:

1. localhost/private network без входящего public traffic;
2. VPN/allowlist;
3. reverse-proxy Basic Auth;
4. минимальный server-side development gate.

Недопустимо:

- `AUTH_ENABLED=false` на публичном адресе с write API;
- передавать пароль через Vite/client env;
- хранить password/session в localStorage;
- считать CORS защитой;
- возвращать exchange keys, secrets или raw signed requests;
- логировать credential/token/cookie.

### Development gate baseline

- username + password hash в server env;
- constant-time verification;
- rate limit и generic login error;
- signed, `HttpOnly`, `Secure`, `SameSite` cookie;
- короткий TTL и logout;
- CSRF protection для cookie-authenticated writes;
- отключение по одному config flag после внедрения P1 auth.

Если используется Basic Auth на proxy, application login page не нужна.

## 5. Торговая безопасность

- paper/demo по умолчанию;
- live включается отдельным server config и явным UI confirmation;
- API key permissions валидируются;
- withdrawal permission не требуется и не допускается;
- limits проверяются до order submission;
- commands idempotent;
- manual close сериализуется с trading cycle;
- reconciliation не создаёт повторных действий;
- persistence commit предшествует внешнему success event;
- kill switch доступен и наблюдаем;
- environment видим на каждой странице с execution data.

## 6. Безопасность P1

- session only server-side/opaque cookie;
- password hashing современным KDF либо внешний identity provider;
- membership проверяется на application boundary;
- deny-by-default policy;
- все user-owned queries требуют workspace scope;
- exchange credentials шифруются отдельным key management layer;
- secret rotation/revocation;
- audit login, credential, deployment и manual trade actions;
- rate limits, CSRF, secure headers;
- workspace isolation integration tests;
- удаление/экспорт данных по документированной policy.

Временный dev gate не мигрируется в User table и не используется для реальных клиентов.

## 7. Public security P2

Landing и public track record получают отдельный public surface:

- только whitelist DTO;
- aggregation/delay для чувствительных сделок;
- никакого account balance, открытых positions, exact thresholds, logs или controls;
- rate limiting/cache;
- security headers;
- provenance/disclaimer;
- отдельный CORS policy при реальной необходимости.

## 8. Observability

Структурированные logs/metrics должны включать:

- `requestId`/`correlationId`;
- `workspaceId`;
- `strategyVersionId`;
- `deploymentId`/`executionRunId`;
- `jobId`;
- service/environment;
- безопасный error code.

Не включать credentials, cookies, full authorization headers и чувствительные exchange
payload. Для пользователя activity/decision timeline строится из предметных событий,
а не из парсинга текстовых логов.

Минимальные health domains:

- API readiness;
- database;
- worker heartbeat;
- market data freshness;
- exchange connectivity;
- queue lag;
- failed jobs;
- persistence/outbox lag;
- runtime risk state.

## 9. Deployment topology

P0 достаточно:

```text
reverse proxy/access gate
  ├─ dashboard static assets
  └─ /api -> API

API -> PostgreSQL
worker -> PostgreSQL + Bybit
```

API и worker — отдельные processes. Dashboard не имеет прямого доступа к exchange.
Validation jobs можно выполнять тем же worker с отдельной concurrency queue до появления
реальной нагрузки.

## 10. Backup и recovery

- scheduled database backup;
- encrypted storage и retention;
- периодическая проверка restore, а не только наличия файла;
- documented RPO/RTO;
- strategy versions и validation artifacts входят в backup;
- exchange secrets имеют отдельную recovery/rotation policy;
- старый проект остаётся read-only до подтверждённого импорта.

## 11. Source of truth

- scope/roadmap — active product docs;
- schema — Prisma + migrations;
- HTTP contract — schemas/OpenAPI;
- strategy status — данные приложения, не ручной каталог;
- operations — runbook;
- research outcome — один append-only archive;
- changelog — только выполненные изменения.

## 12. Релизные stop-gates

### Dashboard staging

- недоступен без private network/gate;
- live mode не включён по ошибке;
- secrets redacted;
- backup существует;
- dangerous actions подтверждаются.

### Multi-user release

- ownership coverage 100% для user-owned entities;
- isolation tests пройдены;
- session/security flows проверены;
- credential storage и audit готовы;
- fixed development workspace мигрирован.

### Public landing

- private endpoints недоступны с public surface;
- track record только whitelist projection;
- claims соответствуют реальному продукту;
- privacy/terms/risk copy согласованы.
