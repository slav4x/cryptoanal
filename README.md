# CryptoAnal

CryptoAnal — dashboard-first платформа для исследования, проверки, запуска и анализа
криптоторговых стратегий. Private dashboard защищён database-backed сессиями, а данные
разделены membership-based workspaces. Полный план находится в [docs/rebuild](docs/rebuild/README.md).

## Структура

- `apps/dashboard` — React/Vite dashboard;
- `apps/api` — Fastify API;
- `apps/worker` — execution и background jobs;
- `packages/ui` — shadcn-compatible компоненты, Radix Select и design tokens;
- `packages/contracts` — Zod schemas и общие DTO;
- `packages/application` — use cases, context и ports;
- `packages/persistence` — Prisma client и repositories;
- `packages/config` — server-side environment config;
- `prisma` — чистая схема и seed development workspace.

Визуальное направление перенесено из согласованных макетов `crypto-trade/design` в
semantic tokens `packages/ui/src/styles/globals.css`. Feature-страницы используют эти
токены и shadcn-compatible primitives без собственной темы. Поля форм используют единую
desktop-геометрию, а выпадающие списки собраны на Radix Select с общими состояниями
focus, disabled и keyboard navigation. Основные контролы используют текст 13 px,
компактные варианты — 12 px; длинное выбранное значение Select остаётся в одну строку
и обрезается многоточием.

## Текущий статус

Dashboard, runtime/validation, analytics, migration и backup-контуры завершены. В P1 уже
работают database users, session auth, CSRF, membership isolation, создание/переключение
workspaces, приглашения, управление участниками, encrypted exchange connections, проверка
Bybit credentials, deployment binding, periodic verification, управление пользовательскими
сессиями, смена и восстановление пароля, multi-workspace worker, а также четыре независимых
семейства сигналов: EMA crossover, breakout, mean-reversion и momentum. Следующий
продуктовый блок — оставшийся client hardening. Landing остаётся последним этапом.

## Требования

- Node.js 22.18+;
- pnpm 10+;
- Docker с Compose либо PostgreSQL 17+.

## Постоянный локальный запуск через Docker

После заполнения `.env` весь контур запускается одной командой:

```bash
docker compose up -d --build
```

Compose сохраняет PostgreSQL в именованном volume, автоматически применяет миграции перед
стартом API и перезапускает сервисы после сбоя или рестарта Docker. Проверка состояния и
просмотр логов:

```bash
docker compose ps
docker compose logs -f api worker
```

Остановка приложений без удаления базы:

```bash
docker compose stop api worker dashboard
```

## Запуск для разработки без контейнеров приложений

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:generate
pnpm db:migrate
pnpm db:seed
CRYPTOANAL_NEW_USER_PASSWORD='use-a-long-local-password' \
  pnpm auth:create-user --email owner@example.com --name 'Owner' --workspace development
pnpm dev
```

В этом режиме PostgreSQL работает в Docker, а API, worker и Vite — как локальные процессы.

Адреса:

- dashboard: `http://localhost:5173`;
- API: `http://localhost:3100`;
- health: `http://localhost:3100/health`.

Основные рабочие маршруты:

- `/` — обзор с интерактивным графиком капитала за 24 часа, 7 дней и 30 дней;
- `/markets` — список инструментов и watchlist;
- `/markets/:symbol` — интерактивные реальные свечи, торговые отметки и уровни открытых
  позиций, техническая сводка и табличный торговый контекст пары;
- `/trades` — открытые позиции и история завершённых сделок;
- `/trades/:tradeId` — результат сделки, runtime-контекст, ордера и fills;
- `/strategies` — каталог стратегий, версий, validation и deployment states;
- `/strategies/new` — секционный редактор и создание черновика с immutable v1;
- `/strategies/:strategyId` — workspace стратегии с обзором, конфигурацией и историей версий;
- `/strategies/:strategyId/versions/new` — создание новой версии на основе последней;
- `/validation` — постановка backtest/walk-forward runs и состояние durable очереди;
- `/validation/:validationRunId` — полный отчёт запуска: метрики, equity/drawdown, gates,
  пары, сделки и provenance;
- `/validation/compare` — сравнение 2–4 завершённых запусков;
- `/runtime` — dry-run deployments, execution runs и подтверждаемые runtime-команды.
- `/analytics` — performance, equity, drawdown, PnL-календарь и разрезы результатов.
- `/analytics/health` — operational health, watchdog incidents и validation drift.
- `/activity` — лента OPEN/CLOSE/HOLD/SKIP/ERROR с причинами и факторами решения.
- `/journal` — исследовательские записи, предметные связи и review sessions.
- `/playbooks` — библиотека сетапов, правил, условий инвалидации и связанных примеров.
- `/system/logs` — технические события сервисов с фильтрами, cursor pagination и redaction.
- `/settings` — настройки workspace, runtime safety, состояния интеграций и JSON-экспорт.
- `/invite/:token` — принятие одноразового приглашения существующим или новым пользователем.
- `/recovery/:token` — установка нового пароля по одноразовой recovery-ссылке.

Реализованный private API:

- `GET /api/v1/auth/session`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`;
- `GET /api/v1/auth/sessions` и `DELETE .../:sessionId` — просмотр и отзыв активных устройств;
- `POST /api/v1/auth/password` — смена пароля с отзывом остальных сессий;
- `GET`/`POST /api/v1/auth/recovery/:token` — проверка и применение recovery token;
- `POST /api/v1/auth/workspace` — membership-checked смена активного workspace;
- `POST /api/v1/workspaces` — создание изолированного workspace и owner membership;
- `GET /api/v1/workspaces/:workspaceId/access` — участники и ожидающие приглашения;
- `POST /api/v1/workspaces/:workspaceId/invitations` и `DELETE .../:invitationId`;
- `PATCH`/`DELETE /api/v1/workspaces/:workspaceId/members/:userId`;
- `GET /api/v1/invitations/:token` и `POST /api/v1/invitations/:token/accept`;
- `GET`/`POST /api/v1/exchange-connections`;
- `PUT /api/v1/exchange-connections/:connectionId/credentials` и `DELETE .../:connectionId`;
- `POST /api/v1/exchange-connections/:connectionId/verify` — проверка ключа и permissions;
- `GET /api/v1/overview?period=24h|7d|30d`;
- `GET /api/v1/markets` и `GET /api/v1/markets/:symbol`;
- `PUT /api/v1/watchlist/:symbol` и `DELETE /api/v1/watchlist/:symbol`;
- `GET /api/v1/trades` и `GET /api/v1/trades/:tradeId`;
- `GET /api/v1/strategies` и `POST /api/v1/strategies`;
- `GET /api/v1/strategies/:strategyId`;
- `POST /api/v1/strategies/:strategyId/versions`;
- `POST /api/v1/strategies/:strategyId/status`;
- `GET /api/v1/validations`;
- `GET /api/v1/validations/:validationRunId?tradePage=1&tradeLimit=50`;
- `POST /api/v1/strategies/:strategyId/validations`;
- `GET /api/v1/deployments`;
- `POST /api/v1/strategies/:strategyId/deployments`;
- `POST /api/v1/deployments/:deploymentId/commands`;
- `POST /api/v1/positions/:positionId/close`;
- `GET /api/v1/analytics?period=7d|30d|90d|all&environment=&strategyId=&symbol=`;
- `GET /api/v1/health`.
- `GET /api/v1/activity?period=24h|7d|30d|all&action=&strategyId=&symbol=&reasonCode=&cursor=`.
- `GET /api/v1/journal?period=7d|30d|90d|all&kind=&strategyId=&symbol=&tag=&cursor=`;
- `POST /api/v1/journal/entries` и `POST /api/v1/journal/reviews`.
- `GET /api/v1/playbooks?status=&strategyId=&tag=&query=`;
- `POST /api/v1/playbooks`, `PUT /api/v1/playbooks/:playbookId`;
- `POST /api/v1/playbooks/:playbookId/status`.
- `GET /api/v1/system/logs?period=&level=&service=&correlationId=&query=&cursor=`;
- `GET /api/v1/settings` и `PUT /api/v1/settings/preferences`;
- `GET /api/v1/settings/export`.

Analytics строится на сервере из канонического журнала закрытых сделок. Период, контур,
стратегия и пара фильтруются до расчёта. Проекция содержит net/gross PnL, win rate,
profit factor, expectancy, costs, equity, drawdown, дневной PnL, распределения по
результату/времени в позиции и breakdowns по strategy version, symbol, exit reason,
market regime и UTC-сессии входа. Regime и session фиксируются в Position при входе и
копируются в каноническую Trade при закрытии; старые записи получают `unknown`. Стартовая точка equity берётся из
`DRY_RUN_INITIAL_BALANCE`; это аналитическая база текущего development-контура, а не
исторический account snapshot.

Health projection проверяет API/database, worker heartbeat, Bybit public connection,
свежесть market/account данных, validation queue, runtime failures, rejected orders и outbox lag. Worker с
интервалом `WATCHDOG_INTERVAL_MS` сохраняет edge-triggered инциденты и автоматически
закрывает их после восстановления. Drift сравнивает runtime только с тем validation run,
который зафиксирован в immutable execution context; до 20 закрытых сделок вывод не
делается.

Activity — отдельный продуктовый audit trail на основе `Decision`, а не представление
raw logs. Лента поддерживает серверные фильтры и keyset pagination, показывает factors,
correlation/market reference, execution provenance и точные ссылки на position/trade,
если решение создало или закрыло торговый результат.

Journal хранит типизированные гипотезы, наблюдения, выводы и решения. Запись может
ссылаться на strategy/version, execution или validation run, trade, runtime decision и
symbol; цель ссылки проверяется в текущем workspace. Review session фиксирует выбранный
период, итог, выводы и следующие действия, а также неизменяемый состав попавших в период
записей. Создание записей и разборов отражается в audit trail.

Playbook хранит условия рынка, правила входа/выхода/риска, явные условия инвалидации и
чек-лист. Он может ссылаться на стратегии и закрытые сделки текущего workspace, но эти
связи справочные: создание и редактирование плейбука не меняет immutable strategy config
и не запускает runtime. Редактирование защищено `expectedUpdatedAt`, смена статуса —
ожидаемым текущим статусом и audit reason. Удаление заменено обратимой архивацией;
история версий плейбука остаётся задачей после P1.

System Logs хранит отдельный структурированный технический поток. API записывает
мутации и ошибки без request body, headers и cookies; секретоподобные ключи и значения
редактируются при записи и повторно при выдаче. Экран поддерживает фильтры, keyset
pagination, раскрытие metadata/correlation id и вручную включаемый live tail.

Desktop-навигация разделена на рабочую область, исследования и систему. Базовые поля,
select-контролы, focus states и reduced-motion поведение живут в `packages/ui`; мобильная
адаптация на текущем этапе намеренно не полируется.

Settings сохраняет timezone и плотность таблиц с optimistic conflict protection.
Остальные секции показывают реально действующие runtime safety limits, интервалы market
data, состояние public/private exchange connection, notifications и retention без
фиктивных переключателей. JSON-экспорт содержит настройки, стратегии и версии, сделки,
journal/reviews и playbooks, но исключает candles, system logs и secrets; экспорт
фиксируется в audit trail.

Strategy workspace получает рассчитанную сервером lifecycle-модель. Ручной переход
статуса требует ожидаемый текущий статус и комментарий, записывается вместе с audit
event и отклоняется при активной проверке/deployment либо отсутствии успешной проверки
последней версии. Новая версия разрешена только для draft/approved и возвращает
approved-стратегию в draft.

Validation-команда принимает только последнюю версию, timeframe и пары из её config.
Создание `ValidationRun`, durable `Job`, audit event и переход стратегии в validating
выполняются одной транзакцией. Worker забирает задачи через lease, загружает завершённые
свечи Bybit, сохраняет их пакетами и выполняет детерминированный backtest либо
walk-forward. Результат содержит PnL, доходность, drawdown, profit factor, expectancy,
комиссии, сделки, validation gates и SHA-256 provenance фактического датасета. Один run
ограничен 10 парами и 250 000 свечей; при недоступных или недостаточных данных run
завершается явной ошибкой без синтетического результата.

Перед расчётом worker материализует фактические свечи в immutable `DatasetSnapshot`.
Snapshot хранит source, timeframe, пары, фактический диапазон, candle count и content
hash; одинаковый завершённый исторический набор данных повторно используется внутри
workspace без повторной загрузки с биржи. Validation run
ссылается на snapshot до запуска engine, поэтому после потери lease или перезапуска
worker продолжает работу на том же наборе, а не загружает изменившуюся историю заново.

Каталог validation возвращает только лёгкие summary-метрики. Полные equity points,
per-symbol breakdown и provenance загружаются отдельным detail-запросом. Все сделки run
хранятся в `ValidationTrade` и выдаются страницами до 100 строк, поэтому размер списка
запусков не растёт вместе с историей сделок. В provenance отчёта также отображаются
идентификатор, hash, источник и фактические границы immutable dataset snapshot.

Dry-run deployment создаётся только для активной approved-версии, имеющей завершённую
passed-валидацию с тем же config hash. Каждая стратегия автоматически получает отдельный
виртуальный account `${DRY_RUN_ACCOUNT_ID}:strategy:<strategyId>`; на один такой account
допускается один deployment в состоянии ready/running/paused. Поэтому несколько стратегий
могут безопасно исполняться параллельно без смешивания капитала, дневного PnL и открытых
позиций. Start создаёт новый immutable
`ExecutionRun.context` с version/config/validation provenance, безопасным snapshot
выбранного `ACTIVE` Bybit connection и SHA-256 context hash;
pause/resume продолжают тот же run, stop завершает его. Каждая команда требует
`expectedStatus`, reason и idempotency key, а результат и audit event записываются в той
же транзакции. Runtime остаётся `dry-run`: привязка не отправляет приватные ордера. Start
и resume повторно проверяют connection; rotate/revoke блокируются до остановки deployment.

Worker получает ticker и подтверждённые закрытия свечей через один public Bybit WebSocket;
REST polling остаётся fallback для восстановления истории. Сигналы вычисляются только по
завершённым свечам и не чаще одного решения на пару и свечу. После сигнала dry-run вход
исполняется по первой свежей realtime-котировке, а SL, TP и trailing-stop проверяются раз в
секунду по фактической цене. Mark price и unrealized PnL сохраняются раз в пять секунд,
чтобы не создавать лишнюю нагрузку на БД. Открытие и закрытие атомарно создают канонические
`Decision`, `Position`, `Order`, `Fill` и `Trade`. При недоступном WebSocket worker временно
возвращается к консервативной обработке завершённых OHLC-свечей.

Pause запрещает новые входы, но продолжает сопровождать уже открытые позиции. Stop
недоступен до их закрытия. Ручное закрытие выполняется на странице `/trades` по свежему
market snapshot и имеет собственные idempotency receipt и audit event. Runtime и
validation используют общие функции сигналов, risk sizing, комиссий, slippage и exit
rules; источник цены исполнения различается явно: историческая свеча в validation и
realtime quote в runtime.

Конфигурация явно выбирает `ema-crossover`, `breakout`, `mean-reversion` или `momentum`.
Для каждого семейства редактор показывает только относящиеся к нему параметры, а runtime
и validation рассчитывают один и тот же сигнал. Текущий development-портфель содержит 15
изолированных dry-run accounts; приватные биржевые ордера по-прежнему не отправляются.

Проверенные EMA-кандидаты на 5m не прошли минимальный backtest gate по profit factor и
expectancy, поэтому в runtime не запущены и до walk-forward не допущены. Результаты
сохранены в `docs/rebuild/15-PARALLEL-STRATEGY-EXPERIMENTS.md`.

Текущая execution policy использует 1× совокупную экспозицию: номинал одной позиции
ограничен `equity / maxOpenPositions`. Явные leverage и max exposure появятся вместе с
общим runtime execution context; до этого validation не предполагает скрытого плеча.

## Проверки

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm check:budgets
```

`check:budgets` запускается после сборки и ограничивает gzip-размер entry JS, всего JS,
CSS, отдельного route chunk и изолированных `lightweight-charts` и Radix UI vendor chunks.
Интервальный refetch привязан к активным страницам; системные логи обновляются
автоматически только после явного включения.

Read-only аудит legacy PostgreSQL и локальный архив:

```bash
pnpm migration:audit -- --source-env ../crypto-trade/bot/.env
```

Команда не подключается к новой БД. Она сохраняет manifest и gzip-архив business data в
игнорируемом `var/legacy-migration`; подробный mapping описан в
[`docs/rebuild/12-LEGACY-DATA-MIGRATION.md`](docs/rebuild/12-LEGACY-DATA-MIGRATION.md).

Локальный backup и изолированная проверка восстановления:

```bash
pnpm db:backup
pnpm db:restore-check
```

Артефакты сохраняются с правами `0600` в игнорируемом `var/backups`. Restore-check
использует отдельные временные Docker container/volume и не изменяет рабочую базу.

## Безопасность development-этапа

Dashboard содержит private account/runtime данные и управляющие действия. Private API
требует server-side session; сырой token хранится только в `HttpOnly` cookie, а в БД — его
hash. Изменяющие запросы защищены CSRF, login ограничен по частоте, workspace выбирается
только через membership. Для production необходимо задать случайный `AUTH_SECRET` длиной
не менее 32 символов, отдельный `EXCHANGE_CREDENTIALS_KEY` и использовать HTTPS.

Публичный signup и автоматическая email-доставка пока отсутствуют. Владелец создаёт
одноразовую invite-ссылку в `/settings`; в БД хранится только SHA-256 токена. Новый
пользователь задаёт имя и пароль, существующий подтверждает свой пароль. Пароли сохраняются
как Argon2id hash. Для bootstrap остаётся `pnpm auth:create-user`; пароль передаётся только
через `CRYPTOANAL_NEW_USER_PASSWORD`.

До подключения email-провайдера администратор выпускает recovery-ссылку вручную:

```bash
pnpm auth:create-recovery --email owner@example.com
```

Ссылка одноразовая и действует `AUTH_RECOVERY_TTL_MINUTES`. Восстановление отзывает все
активные сессии пользователя. Обычный вход ограничен `AUTH_MAX_ACTIVE_SESSIONS`; лишние
старые сессии закрываются автоматически.

Приватные Bybit credentials шифруются AES-256-GCM отдельным ключом окружения. API никогда
не возвращает исходные значения, а после отзыва подключения ciphertext удаляется. До
ручной проверки через Bybit подключение имеет статус `не проверено`. Проверка использует
подписанный `GET /v5/user/query-api`, сохраняет только безопасную сводку permissions и
отклоняет ключи с разрешением `Withdraw`. Даже статус `ACTIVE` не включает торговлю.
Новый production-ключ можно создать командой
`openssl rand -base64 32` и сохранить как `EXCHANGE_CREDENTIALS_KEY` вне Git.

Private Bybit verification использует `BYBIT_DEMO_BASE_URL` для demo,
`BYBIT_LIVE_BASE_URL` для live и timeout `BYBIT_PRIVATE_REQUEST_TIMEOUT_MS`. Региональный
mainnet-домен при необходимости задаётся через server environment, без изменений frontend.

После успешной ручной проверки worker перепроверяет connection каждые
`EXCHANGE_VERIFICATION_INTERVAL_HOURS` часов. Claim защищён lease; временная ошибка
переносит попытку на `EXCHANGE_VERIFICATION_RETRY_MINUTES`, но не сбрасывает статус
`ACTIVE`. Окончательная ошибка переводит connection в `INVALID` и создаёт watchdog
incident. `credentialRevision` не позволяет запоздавшему результату проверки перезаписать
уже заменённые ключи.

## Dry-run account

Worker сохраняет account snapshots каждого виртуального strategy account и сводный
`${DRY_RUN_ACCOUNT_ID}:portfolio`. Капитал отдельной стратегии рассчитывается как
`DRY_RUN_INITIAL_BALANCE + realized PnL + unrealized PnL`; portfolio складывает капиталы и
PnL всех известных dry-run accounts. Доступный баланс остаётся неопределённым до появления
risk/margin model или private exchange adapter.

Настройки:

- `DRY_RUN_ACCOUNT_ID` — базовый идентификатор для strategy accounts и portfolio внутри
  каждого workspace;
- `DRY_RUN_INITIAL_BALANCE` — стартовый капитал;
- `ACCOUNT_SNAPSHOT_INTERVAL_MS` — интервал snapshot, по умолчанию 5 минут;
- `RUNTIME_POLL_INTERVAL_MS` — частота поиска новых завершённых свечей, по умолчанию 5 секунд.
- `WATCHDOG_INTERVAL_MS` — частота пересчёта и синхронизации инцидентов, по умолчанию 30 секунд.
