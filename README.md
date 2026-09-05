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
- `/validation` — постановка backtest/walk-forward runs и состояние durable очереди.

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
- `POST /api/v1/strategies/:strategyId/validations`.

Strategy workspace получает рассчитанную сервером lifecycle-модель. Ручной переход
статуса требует ожидаемый текущий статус и комментарий, записывается вместе с audit
event и отклоняется при активной проверке/deployment либо отсутствии успешной проверки
последней версии. Новая версия разрешена только для draft/approved и возвращает
approved-стратегию в draft.

Validation-команда принимает только последнюю версию, timeframe и пары из её config.
Создание `ValidationRun`, durable `Job`, audit event и переход стратегии в validating
выполняются одной транзакцией. Сейчас jobs остаются в очереди: расчёт метрик и завершение
run появятся вместе с единым validation engine, без фиктивных результатов.

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
- `ACCOUNT_SNAPSHOT_INTERVAL_MS` — интервал snapshot, по умолчанию 5 минут.
