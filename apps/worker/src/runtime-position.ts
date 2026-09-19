import {
  evaluateExecutionExit,
  evaluateExecutionPriceExit,
  evaluateExecutionSignalExit,
  settleExecutionPosition,
  type EnrichedExecutionCandle,
  type ExecutionPosition,
  type ExecutionQuote,
  type ExecutionStrategyConfig,
} from "@cryptoanal/application";

export function executionProtectionChanged(before: ExecutionPosition, after: ExecutionPosition) {
  return (
    before.stopPrice !== after.stopPrice ||
    before.trailingPrice !== after.trailingPrice ||
    before.bestPrice !== after.bestPrice
  );
}

export function evaluateRuntimeCandleExit(
  position: ExecutionPosition,
  candle: EnrichedExecutionCandle,
  candleClosedAt: Date,
  config: ExecutionStrategyConfig,
  quote: ExecutionQuote | null,
) {
  // The signal candle predates a realtime entry; its range cannot close that entry.
  if (candleClosedAt <= position.openedAt) return null;
  if (quote && quote.observedAt >= candleClosedAt && quote.observedAt >= position.openedAt) {
    const priceExit = evaluateExecutionPriceExit(position, quote, config);
    if (priceExit) return priceExit;
    return evaluateExecutionSignalExit(position, candle, config)
      ? settleExecutionPosition(position, quote.price, quote.observedAt, "signal-exit", config)
      : null;
  }
  // OHLC does not tell us which extremes occurred after an intrabar entry.
  const settlement =
    candle.openTime >= position.openedAt
      ? evaluateExecutionExit(position, candle, config)
      : evaluateExecutionSignalExit(position, candle, config, candleClosedAt);
  return settlement ? { ...settlement, closedAt: candleClosedAt.toISOString() } : null;
}
