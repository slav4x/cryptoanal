# Качество, безопасность и эксплуатация

Документ задаёт требования и фиксирует текущие эксплуатационные границы реализации.

> Статус: formatting, lint, typecheck, production build, bundle budgets, backup/restore и
> базовые auth/isolation checks действуют. Trading-domain automated suite, exchange secret
> lifecycle и production deployment hardening остаются незавершёнными.

## 1. Quality gates реализации

Каждый кодовый срез должен иметь:

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

## 2. Матрица проверок и оставшееся покрытие

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
- workspace access и CSRF;
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
- два workspace не видят данные друг друга.

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

## 4. Историческая безопасность P0

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

### Исторический development gate baseline

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

## 6. Текущая безопасность P1

- session only server-side/opaque cookie;
- password hashing современным KDF либо внешний identity provider;
- membership проверяется на application boundary;
- deny-by-default policy;
- все user-owned queries требуют workspace scope;
- exchange credentials шифруются отдельным key management layer;
- secret rotation/revocation;
- audit login, credential, deployment и manual trade actions;
- блокировать rotate/revoke credentials при ready/running/paused deployment;
- при окончательной ошибке connection переводить running deployment в paused, ready — в failed;
- rate limits, CSRF, secure headers;
- workspace isolation integration tests;
- удаление/экспорт данных по документированной policy.

Реализованы opaque sessions, Argon2id, membership resolver, CSRF, rate limiting, secure
headers, auth audit events, AES-256-GCM storage, ручная и периодическая Bybit verification
с lease/retry и watchdog incidents, device/session management, password rotation и
одноразовый recovery с полным отзывом sessions. Остаются master-key rotation,
автоматическая email-доставка, расширенная permission matrix и формализованная
export/delete policy. Временный dev gate не используется.

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

Локальный development backup:

```bash
pnpm db:backup
pnpm db:restore-check
```

`db:backup` создаёт PostgreSQL custom dump и manifest с SHA-256 в закрытом от Git
`var/backups`. Если Compose-сервис остановлен, используется временный контейнер без
публикации порта. `db:restore-check` проверяет checksum, восстанавливает dump в отдельный
одноразовый volume, сравнивает набор таблиц и проверяет Prisma migrations, затем удаляет
контейнер и volume. Исходная БД к restore-check не подключается.

Контрольная проверка 7 сентября 2026 года восстановила 36 таблиц и 13 миграций; failed
migrations — 0. Dump SHA-256:

`9645152b3fa0318123130818557fec6547223d9c5aedfecae0fdeea26d5da1ed`

До production остаются обязательными:

- scheduled backup;
- внешнее encrypted storage и retention;
- периодический автоматический restore-check;
- documented RPO/RTO;
- отдельная recovery/rotation policy для exchange secrets.

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

## 13. Dashboard performance baseline

Бюджеты проверяются после production build командой `pnpm check:budgets`:

- entry JavaScript — не более 100 KiB gzip;
- весь JavaScript с lazy route chunks — не более 250 KiB gzip;
- весь CSS — не более 12 KiB gzip;
- один route chunk — не более 12 KiB gzip.

Текущий baseline: entry JS 81.58 KiB, весь JS 211.90 KiB, CSS 8.12 KiB, самый тяжёлый
route chunk 5.85 KiB gzip. Бюджет проверяет собранный `apps/dashboard/dist`, поэтому перед
ним обязателен `pnpm build`.

Polling включается только на активном маршруте и не работает в фоне:

- runtime и очередь validation — 5 секунд;
- overview, trades, activity и health — 15 секунд;
- markets и analytics — 30 секунд;
- validation detail — 3 секунды только пока run находится в очереди или выполняется;
- system logs — 5 секунд только после ручного включения автообновления;
- shell обновляет runtime-индикатор только на overview, runtime и trades.

Desktop accessibility baseline включает skip-link, единый `focus-visible`, reduced motion,
семантические состояния табов и раскрываемых строк, а также `scope` у заголовков таблиц.
Mobile responsive review намеренно отложен и не входит в текущий stop-gate.
