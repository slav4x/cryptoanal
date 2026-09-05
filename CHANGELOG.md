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

### Changed

- Dashboard visual system aligned with the approved `crypto-trade/design` direction.
- Sidebar runtime indicator now reflects the real worker state.
