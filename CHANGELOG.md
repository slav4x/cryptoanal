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

### Changed

- Dashboard visual system aligned with the approved `crypto-trade/design` direction.
- Dashboard typography, control geometry, semantic metrics and desktop shell refined against the source HTML mockups.
- Overview now reports account freshness and uses bucketed account snapshots instead of placeholder capital data.
- Sidebar runtime indicator now reflects the real worker state.
- Request validation errors now return a structured `400` response.
- Creating a new version from an approved strategy now clears its approval and active version.
