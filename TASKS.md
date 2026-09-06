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
- [x] Сверить desktop-примитивы и ключевые страницы с HTML-мокапами `crypto-trade/design`.
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
- [x] Полный overview projection с account snapshots.

## Этап 3 — Strategies и runtime

- [x] Strategy catalog и status model.
- [x] Секционный strategy editor.
- [x] Создание стратегии с immutable версией v1.
- [x] Strategy workspace с обзором и snapshot конфигурации.
- [x] Последующие immutable versions и diff.
- [x] Lifecycle transitions и validation eligibility.
- [x] Dry-run deployments и execution runs.
- [x] Immutable execution context с hash и provenance validation run.
- [x] Start/pause/resume/stop commands, confirmations, idempotency и audit trail.
- [x] Один активный deployment на dry-run account.
- [x] Worker execution loop для активного dry-run deployment.
- [x] Manual close позиции как отдельная команда.

## Этап 4 — Validation Center

- [x] Единая execution semantics runtime/backtest.
- [x] Immutable dataset snapshots с content hash и повторным использованием.
- [x] Durable очередь ValidationRun/Job для backtest и walk-forward.
- [x] Run composer и мониторинг очереди в Validation Center.
- [x] Worker execution для backtest/walk-forward jobs.
- [x] Validation gates и provenance.
- [x] Run details и compare.

## Этап 5 — Analytics

- [x] Performance projections и breakdowns.
- [x] Equity, drawdown и PnL calendar.
- [x] Распределения результата и времени в позиции.
- [x] Trade provenance и breakdowns по market regime и UTC-session.
- [x] Health, drift и watchdog.
- [x] Activity/explainability.

## Этап 6 — Разбор и polish

- [x] Journal и review sessions.
- [x] Playbooks.
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
- Управляемое самообучение стратегий по плану `docs/rebuild/11-SELF-LEARNING-MODELS.md`.
