# CryptoAnal

CryptoAnal — dashboard-first платформа для исследования, проверки, запуска и анализа
криптоторговых стратегий. Текущий этап работает в одном development workspace без
пользовательской авторизации. Полный план находится в [docs/rebuild](docs/rebuild/README.md).

## Структура

- `apps/dashboard` — React/Vite dashboard;
- `apps/api` — Fastify API;
- `apps/worker` — execution и background jobs;
- `packages/ui` — shadcn-compatible компоненты и design tokens;
- `packages/contracts` — Zod schemas и общие DTO;
- `packages/application` — use cases, context и ports;
- `packages/persistence` — Prisma client и repositories;
- `packages/config` — server-side environment config;
- `prisma` — чистая схема и seed development workspace.

Визуальное направление перенесено из согласованных макетов `crypto-trade/design` в
semantic tokens `packages/ui/src/styles/globals.css`. Feature-страницы используют эти
токены и shadcn-compatible primitives без собственной темы.

## Требования

- Node.js 22.18+;
- pnpm 10+;
- Docker с Compose либо PostgreSQL 17+.

## Запуск

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:generate
pnpm db:migrate --name init
pnpm db:seed
pnpm dev
```

Адреса:

- dashboard: `http://localhost:5173`;
- API: `http://localhost:3100`;
- health: `http://localhost:3100/health`.

Основные рабочие маршруты:

- `/` — обзор;
- `/markets` — список инструментов и watchlist;
- `/markets/:symbol` — реальные свечи, техническая сводка и торговый контекст пары;
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

Реализованный private API:

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
- `POST /api/v1/positions/:positionId/close`.

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

Каталог validation возвращает только лёгкие summary-метрики. Полные equity points,
per-symbol breakdown и provenance загружаются отдельным detail-запросом. Все сделки run
хранятся в `ValidationTrade` и выдаются страницами до 100 строк, поэтому размер списка
запусков не растёт вместе с историей сделок.

Dry-run deployment создаётся только для активной approved-версии, имеющей завершённую
passed-валидацию с тем же config hash. На один `DRY_RUN_ACCOUNT_ID` допускается один
deployment в состоянии ready/running/paused. Start создаёт новый immutable
`ExecutionRun.context` с version/config/validation provenance и SHA-256 context hash;
pause/resume продолжают тот же run, stop завершает его. Каждая команда требует
`expectedStatus`, reason и idempotency key, а результат и audit event записываются в той
же транзакции.

Worker обрабатывает только завершённые свечи и фиксирует не более одного решения на
пару и свечу. Сигнал переносится на открытие следующей свечи, после чего dry-run
исполнение атомарно создаёт `Decision`, `Position`, `Order` и `Fill`; закрытие также
создаёт канонический `Trade`. Pause запрещает новые входы, но продолжает сопровождать
уже открытые позиции. Stop недоступен до их закрытия. Ручное закрытие выполняется на
странице `/trades` по свежему market snapshot и имеет собственные idempotency receipt и
audit event. Runtime и validation используют общие функции сигналов, risk sizing,
комиссий, slippage и exit rules.

Текущая execution policy использует 1× совокупную экспозицию: номинал одной позиции
ограничен `equity / maxOpenPositions`. Явные leverage и max exposure появятся вместе с
общим runtime execution context; до этого validation не предполагает скрытого плеча.

## Проверки

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
```

## Безопасность development-этапа

Dashboard содержит private account/runtime данные и управляющие действия. Пока нет
настоящей auth, его можно использовать локально или в private network. Перед удалённым
deployment требуется reverse-proxy Basic Auth либо development access gate.

## Dry-run account

Worker сохраняет account snapshots для development workspace. Капитал рассчитывается как
`DRY_RUN_INITIAL_BALANCE + realized PnL + unrealized PnL`; доступный баланс остаётся
неопределённым до появления risk/margin model или private exchange adapter.

Настройки:

- `DRY_RUN_ACCOUNT_ID` — стабильный идентификатор development-счёта;
- `DRY_RUN_INITIAL_BALANCE` — стартовый капитал;
- `ACCOUNT_SNAPSHOT_INTERVAL_MS` — интервал snapshot, по умолчанию 5 минут;
- `RUNTIME_POLL_INTERVAL_MS` — частота поиска новых завершённых свечей, по умолчанию 5 секунд.
