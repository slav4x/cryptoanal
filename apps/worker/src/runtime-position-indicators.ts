import {
  advanceExecutionIndicators,
  readExecutionIndicatorCheckpoint,
  type ExecutionCandle,
  type ExecutionIndicatorCheckpoint,
  type ExecutionStrategyConfig,
} from "@cryptoanal/application";
import type { RuntimeSignalEvent } from "./runtime-price-processor";

export function positionIndicatorCheckpoint(
  positionState: unknown,
  entryState: unknown,
  signalCandleAt: Date | null,
  config: ExecutionStrategyConfig,
  symbol: string,
) {
  const own = readExecutionIndicatorCheckpoint(positionState, config, symbol);
  if (own) {
    if (!signalCandleAt || Date.parse(own.lastCandleAt) !== +signalCandleAt)
      throw new Error("Position indicator checkpoint does not match signal progress");
    return own;
  }
  const entry = readExecutionIndicatorCheckpoint(entryState, config, symbol);
  // A deployment cursor ahead of the position would skip unprocessed exit signals.
  return entry && signalCandleAt && Date.parse(entry.lastCandleAt) === +signalCandleAt
    ? entry
    : null;
}

export function replayPositionIndicators(
  history: ExecutionCandle[],
  availability: Date[],
  intervalMs: number,
  config: ExecutionStrategyConfig,
  initial: ExecutionIndicatorCheckpoint | null,
) {
  if (history.length !== availability.length) throw new Error("Missing signal availability");
  const candles = advanceExecutionIndicators(history, config, initial).candles;
  const signals: RuntimeSignalEvent[] = candles.map((candle, index) => ({
    candle,
    closedAt: new Date(+candle.openTime + intervalMs),
    availableAt: new Date(
      Math.max(+availability[index]!, initial?.availableAt ? Date.parse(initial.availableAt) : 0),
    ),
  }));
  return {
    signals,
    checkpointThrough(candleAt: Date): ExecutionIndicatorCheckpoint | null {
      const index = history.findIndex((candle) => +candle.openTime === +candleAt);
      if (index < 0) return null;
      const checkpoint = advanceExecutionIndicators(
        history.slice(0, index + 1),
        config,
        initial,
      ).checkpoint!;
      checkpoint.availableAt = signals[index]!.availableAt.toISOString();
      return checkpoint;
    },
  };
}
