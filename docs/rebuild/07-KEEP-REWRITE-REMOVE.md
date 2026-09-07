# Что сохранить, переписать, переместить и убрать

> Статус: историческая матрица решений по переносу из `crypto-trade`. Основной rebuild и
> archive-only legacy migration выполнены; документ сохраняется как объяснение того, почему
> отдельные части не попали в новый production path.

## 1. Правило переноса

Старый проект используется как reference implementation и набор проверенных сценариев.
Файл не переносится только потому, что он работает. Сначала извлекаются инварианты,
contracts и полезный UX, затем реализация пишется в новых границах.

Статусы:

- **Сохранить** — идея/правило переносится почти без изменения;
- **Переписать** — ценность есть, текущая реализация не подходит;
- **Переместить** — оставить вне production path;
- **Убрать** — не переносить в новый проект.

## 2. Domain и execution

### Сохранить

- `ExchangeGateway` как port;
- risk limits, exposure/correlation/day-loss guards;
- serialized trading cycle и manual close;
- fee/funding/slippage accounting;
- reconciliation и safe defaults `DRY_RUN`, no autostart;
- причины решений `HOLD/SKIP/OPEN/CLOSE`;
- полезные indicator/regime/cost services;
- watchdog и graceful shutdown инварианты.

### Переписать

- 2331-строчный trading engine — в use cases/state machines/domain policies;
- global mutable config — в immutable `ExecutionContext`;
- memory-first `BotStore` — в транзакционные repositories/outbox;
- runtime/backtest duplicate logic — в общую execution semantics;
- строковые policy/status — в typed schemas и DB constraints;
- обработку clock/time — через явную зависимость;
- Bybit error mapping — в устойчивый adapter с нормализованными errors.

### Убрать

- автоматическое применение конфигурации через `Object.assign`;
- молчаливое продолжение после persistence failure;
- полную перезапись positions/history на каждую мутацию;
- pretending multi-strategy: выбор первой leg при заявленном profile;
- branches, которых нет в поддерживаемой runtime schema.

## 3. Стратегии и validation

### Сохранить

- version history и diff;
- backtest + walk-forward + holdout как связанный validation workflow;
- PF, expectancy, drawdown, R, MFE/MAE и breakdowns;
- negative research results;
- config/result hashes и demo checkpoints как идеи;
- maker fill-rate и сравнение ожидаемых/фактических costs.

### Переписать

- плоский `StrategyConfig` — в секционные schemas;
- 1317-строчный backtest runner — в job + shared domain engine;
- разрозненные backtest/analytics screens — в Validation Center;
- templates/catalog — только из актуального source of truth;
- validation verdict — в формальные gate results с причинами;
- multi-strategy data model — оставить совместимой, но не считать реализованным runtime.

### Переместить в research archive

- неподтверждённые гипотезы;
- Python notebooks/scripts, не участвующие в production;
- исторические sweeps и одноразовые выгрузки;
- invalid funding results и устаревшие «validated» заявления.

### Убрать

- funding carry из поддерживаемого каталога до повторной корректной валидации;
- research-only flags из production config;
- копии strategy docs с разными статусами одной ветки.

## 4. Dashboard

### Сохранить

- тёмную flat-концепцию;
- `panel`, stat cards, loading/error/empty patterns как UX reference;
- таблицы позиций/сделок;
- candlestick chart;
- PnL calendar;
- explainability timeline;
- grouped sidebar + mobile drawer;
- полезные страницы strategies, validation, analytics, journal, playbooks, health.

### Переписать

- 1155-строчный `JournalPage` и 900-строчный `StrategyEditorPage` — в feature modules;
- глобальный polling — в route/widget queries с общим cache;
- ручные frontend types — в generated/inferred contracts;
- `/trades/:symbol` — в корректные pair/trade routes;
- settings placeholders — только в реально работающие секции;
- смешанную навигацию — в продуктовые группы и вторичный `System`;
- компоненты — на shadcn + semantic tokens;
- runtime controls — в state-aware commands с confirmation/progress.

### Убрать

- отдельный demo dashboard;
- public track record из P0 navigation;
- fake login как будто это реальная user auth;
- безусловные запросы status/trades/decisions/report на каждом route;
- синхронный импорт всех страниц;
- прямые HTTP calls из случайных widgets;
- hardcoded colors и локальные варианты одной и той же кнопки/card.

## 5. Journal и playbooks

Раньше их можно было считать лишним SaaS-шумом, но для полного analytical dashboard они
полезны, если связаны с основным циклом.

### Оставить

- journal entry, связанный со стратегией, run, trade или decision;
- review session за период;
- playbook условий/setup;
- фильтры/теги и links из аналитики.

### Не делать

- универсальный редактор документов;
- social feed/comments;
- marketplace playbooks;
- сложные permissions до P1;
- AI coach без отдельного запроса и доказанной потребности.

## 6. Auth/workspaces

### Сохранить как требования/reference

- идея workspace ownership;
- server-side sessions/cookies;
- permission checks в application boundary;
- audit событий доступа и управления.

### Переписать

- текущую partial workspace model: ownership должен охватывать trades, positions,
  decisions, reports, validation и runtime;
- auth middleware и schema согласованно после завершения dashboard;
- любые глобальные report/status queries.

### Не переносить в P0

- текущие `User/Session/WorkspaceMember` только ради видимости SaaS;
- роли без реальных policy;
- login UI, который не обеспечивает data isolation.

Это ограничение относилось к P0. Текущий проект использует database users, session context
и membership isolation; env gate удалён из целевой архитектуры.

## 7. API и persistence

### Сохранить

- PostgreSQL и Prisma, если команда сохраняет текущую экспертизу;
- cursor pagination pattern из logs;
- whitelist projection pattern для будущих public данных;
- correlation ids и health endpoints.

### Переписать

- 1601-строчный `server.ts` — по route modules/use cases;
- 71 endpoint — в последовательный `/api/v1` contract;
- body casts — в runtime validation;
- неодинаковые error responses — в один envelope;
- Float money fields — в Decimal/minor units;
- mixed columns/JSON — в явный source of truth;
- старые 19 migrations — в новую baseline schema.

### Убрать

- public exposure private runtime DTO;
- account balance и exact strategy thresholds из будущего public API;
- synchronous heavy backtest request;
- repository methods без workspace scope для user-owned data.

## 8. Operations

### Сохранить

- backup/restore intent;
- graceful shutdown;
- health/readiness;
- watchdog edge-triggered alerts;
- redaction secrets;
- отдельные worker processes.

### Переписать

- scripts в документированные operations/use cases;
- notification sending через outbox;
- deployment topology под dashboard/api/worker;
- backup с проверкой restore;
- observability вокруг request/run/workspace correlation.

### Не переносить автоматически

- все старые shell scripts;
- machine-specific paths;
- дублирующие health/watchdog механизмы;
- публикацию track record до landing stage.

## 9. Документация

### Active docs нового проекта

- `README.md` — установка и запуск;
- `docs/product/SCOPE.md` — scope и этап;
- `docs/architecture/OVERVIEW.md` — границы и зависимости;
- `docs/architecture/DATA.md` — ownership/schema decisions;
- `docs/operations/RUNBOOK.md` — запуск, incident, recovery;
- `CHANGELOG.md` — фактические изменения;
- один strategy catalog, генерируемый/связанный с реальными версиями.

### Knowledge archive

- отрицательные исследования;
- validated methodology;
- миграционные mappings;
- postmortem funding divergence;
- regression scenarios;
- исходный rebuild-каталог.

### Убрать как active source

- несколько roadmap с разным приоритетом;
- устаревшие чеклисты, выдаваемые за состояние продукта;
- generated artifacts без пометки/генератора;
- формулировки «готово», не подтверждённые runtime.

## 10. Что извлечь до архивирования старого проекта

- таблицу доменных инвариантов;
- список всех API/use cases с решением keep/rewrite/remove;
- golden datasets и ожидаемые outputs;
- формулы performance metrics;
- state transitions;
- Bybit edge cases;
- data migration mapping;
- список обязательных UI workflows;
- screenshots только как visual reference;
- итоговый статус каждой strategy branch.

После этого старый репозиторий остаётся read-only reference, а не источником новых
частичных копирований.
