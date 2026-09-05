# Задачи CryptoAnal

## Этап 1 — Foundation

- [x] Создать структуру pnpm monorepo.
- [x] Добавить единые TypeScript, ESLint и Prettier настройки.
- [x] Подготовить локальный PostgreSQL и чистую Prisma-схему.
- [x] Добавить fixed development workspace и `RequestContext`.
- [x] Создать shared API contracts.
- [x] Создать Fastify API с health, context, overview и markets.
- [x] Создать worker foundation с heartbeat.
- [x] Создать shadcn-compatible UI package и semantic tokens.
- [x] Перенести визуальное направление из `crypto-trade/design` в tokens и dashboard shell.
- [x] Собрать dashboard shell, Overview и Markets.
- [x] Подключить реальный public Bybit market data adapter.
- [ ] Добавить временный access gate перед первым удалённым deployment.

## Этап 2 — Trading data

- [x] Market snapshots и 15m candle history ingestion.
- [x] Watchlist mutations.
- [x] Страница пары со свечами, EMA, RSI, ATR и regime.
- [x] Read-model позиций и завершённых сделок.
- [x] Страница открытых позиций и истории сделок.
- [x] Торговый контекст на Overview и странице пары.
- [x] Orders, fills и детальная страница сделки.
- [ ] Полный overview projection с account snapshots.

## Этап 3 — Strategies и runtime

- [ ] Strategy catalog и status model.
- [ ] Секционный strategy editor.
- [ ] Immutable versions и diff.
- [ ] Deployments и execution runs.
- [ ] Immutable execution context.
- [ ] Runtime commands и audit trail.

## Этап 4 — Validation Center

- [ ] Единая execution semantics runtime/backtest.
- [ ] Асинхронные backtest/walk-forward jobs.
- [ ] Validation gates и provenance.
- [ ] Run details и compare.

## Этап 5 — Analytics

- [ ] Performance projections и breakdowns.
- [ ] Equity, drawdown и PnL calendar.
- [ ] Health, drift и watchdog.
- [ ] Activity/explainability.

## Этап 6 — Разбор и polish

- [ ] Journal и review sessions.
- [ ] Playbooks.
- [ ] System logs и settings.
- [ ] Responsive, accessibility и performance review.

## Этап 7 — Migration

- [ ] Mapping старой БД.
- [ ] Импорт проверенных данных в development workspace.
- [ ] Архивирование неоднозначных данных.
- [ ] Backup/restore check.

## Этап 8 — Users и workspaces

- [ ] Auth ADR.
- [ ] Users, sessions и memberships.
- [ ] Session-based `RequestContext`.
- [ ] Workspace isolation.
- [ ] Exchange connections и encrypted credentials.
- [ ] Миграция development workspace к владельцу.

## Этап 9 — Landing

- [ ] Marketing app.
- [ ] Product, methodology и docs.
- [ ] Public track-record projection.
- [ ] Signup/waitlist и pricing после отдельных решений.

## Идеи

- Multi-strategy allocation.
- Team roles beyond owner/member.
- Billing.
- AI assistant.
- Marketplace.
- Multi-exchange.
