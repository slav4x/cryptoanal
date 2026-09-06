# Changelog

## Unreleased

### Added

- Initial CryptoAnal monorepo foundation.
- Clean PostgreSQL/Prisma schema with workspace ownership.
- Shared API contracts and fixed development request context.
- Fastify API and worker entrypoints.
- shadcn-compatible token-based UI package.
- Dashboard shell with Overview and Markets routes.
- Public Bybit ticker ingestion with persisted market snapshots.
- Persisted Bybit 15-minute candle ingestion.
- Market detail API with EMA, RSI, ATR and regime analysis.
- Market pair page with a tokenized SVG candlestick chart.
- Watchlist commands with controls on market list and pair pages.
- Trading ledger API for open positions and completed trades.
- Trades workspace with positions and history views.
- Position and recent trade context on Overview and market pair pages.
- Trade detail API and page with strategy runtime, orders and fill provenance.
- Dry-run account snapshot capture derived from the configured balance and canonical trading ledger.
- Period-aware Overview equity series for 24 hours, 7 days and 30 days.
- Account equity chart, exposure and realized/unrealized PnL widgets.
- Strategy lifecycle model with explicit allowed status transitions.
- Strategy catalog API and dashboard page with version, validation and deployment states.
- Validated strategy configuration contract split into universe, signal, filters, risk, entry, exit, costs and schedule.
- Atomic strategy creation with an immutable initial version and deterministic config hash.
- Sectional strategy editor for creating draft strategies from the dashboard.
- Strategy workspace with overview, read-only configuration snapshot and version history.
- Immutable v2+ creation with row locking, change summaries and unchanged-config protection.
- Human-readable configuration diff between every version and its predecessor.
- Server-side strategy lifecycle policy with validation eligibility and blocked-action reasons.
- Audited manual status transitions with optimistic status conflict protection.
- Lifecycle controls and validation readiness state in the strategy workspace.
- Durable ValidationRun and Job creation with idempotent replay handling.
- Atomic `draft → validating` transition when a validation run is queued.
- Validation Center with backtest/walk-forward composer and queue monitoring.
- Dataset/config/engine provenance captured for every queued validation run.
- Lease-based validation job claiming with stale-job recovery and atomic completion/failure persistence.
- Paginated Bybit historical candle materialization for validation datasets.
- Deterministic backtest and walk-forward execution with fees, slippage, risk sizing and conservative stop handling.
- Validation metrics, quality gates, dataset content hash and compact results in Validation Center.
- Validation run detail API with paginated persisted trades and full metric provenance.
- Validation report page with equity/drawdown chart, gates, symbol breakdown and trades.
- Side-by-side comparison for two to four completed validation runs.
- Dry-run deployment control-plane gated by approved, successfully validated strategy versions.
- Immutable execution contexts with validation provenance and deterministic context hashes.
- Start, pause, resume and stop commands with optimistic status checks, durable idempotency receipts and audit events.
- Runtime dashboard with command confirmations and execution-run visibility.
- Idempotent dry-run execution loop with per-symbol candle cursors and durable failure state.
- Canonical dry-run decisions, positions, filled orders, fills and completed trades.
- Manual dry-run position close command with current-price validation, audit event and replay-safe receipt.
- Runtime status details for evaluated symbols, failures, open positions and the latest decision.
- Content-addressed immutable validation dataset snapshots with canonical persisted candles.
- Validation retry recovery from the already linked dataset snapshot.
- Dataset source, actual coverage and integrity hash in validation report provenance.
- Server-side performance analytics with period, environment, strategy and symbol filters.
- Equity, drawdown and daily PnL projections from the canonical closed-trade ledger.
- Analytics workspace with performance metrics, PnL calendar and strategy/version, symbol and exit-reason breakdowns.
- Trading cost attribution for fees, funding and slippage in analytics.
- Operational health projection for API, database, worker, Bybit connectivity, market/account data, queues, execution and outbox.
- Edge-triggered watchdog incidents with automatic resolution and episode counting.
- Runtime drift comparison against the exact validation baseline captured by execution context.
- System health workspace with domain statuses, incident history and drift metrics.
- Cursor-paginated activity API with action, strategy, symbol, reason and period filters.
- Explainable decision workspace with factor inspection and execution provenance.
- Explicit nullable links from decisions to the related position and canonical trade.

### Changed

- Dashboard visual system aligned with the approved `crypto-trade/design` direction.
- Dashboard typography, control geometry, semantic metrics and desktop shell refined against the source HTML mockups.
- Overview now reports account freshness and uses bucketed account snapshots instead of placeholder capital data.
- Sidebar runtime indicator now reflects the real worker state.
- Request validation errors now return a structured `400` response.
- Creating a new version from an approved strategy now clears its approval and active version.
- Validation datasets are capped at 10 symbols and 250,000 candles per run.
- Validation catalog responses now contain summary metrics; heavy series are loaded by run detail.
- Runtime and validation now share signal, sizing, cost and exit semantics.
- Paused deployments continue managing open positions but cannot open new ones.
- Deployment stop is blocked while positions remain open.
