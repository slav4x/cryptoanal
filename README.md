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
- `/trades/:tradeId` — результат сделки, runtime-контекст, ордера и fills.

Реализованный private API:

- `GET /api/v1/overview`;
- `GET /api/v1/markets` и `GET /api/v1/markets/:symbol`;
- `PUT /api/v1/watchlist/:symbol` и `DELETE /api/v1/watchlist/:symbol`;
- `GET /api/v1/trades` и `GET /api/v1/trades/:tradeId`.

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
