import {
  evaluateExecutionExit,
  evaluateExecutionPriceExit,
  evaluateExecutionSignalExit,
  settleExecutionPosition,
  updateExecutionTrailing,
  type ExecutionPosition,
  type ExecutionQuote,
  type ExecutionStrategyConfig,
  type ExecutionCandle,
  type EnrichedExecutionCandle,
  type ExecutionSettlement,
} from "@cryptoanal/application";

export class RuntimeRecoveryIncompleteError extends Error {}

export function recoverRuntimeGap(input: {
  position: ExecutionPosition;
  since: Date;
  quote: ExecutionQuote;
  minutes: ExecutionCandle[];
  signals: EnrichedExecutionCandle[];
  signalIntervalMs: number;
  config: ExecutionStrategyConfig;
}): { position: ExecutionPosition; settlement: ExecutionSettlement | null } {
  const from = Math.floor(input.since.getTime() / 60_000) * 60_000;
  const to = Math.floor(input.quote.observedAt.getTime() / 60_000) * 60_000;
  const minutes = new Map(input.minutes.map((candle) => [candle.openTime.getTime(), candle]));
  for (let time = from; time <= to; time += 60_000) {
    const candle = minutes.get(time);
    if (
      !candle ||
      ![candle.open, candle.high, candle.low, candle.close].every(
        (value) => Number.isFinite(value) && value > 0,
      ) ||
      candle.low > Math.min(candle.open, candle.close) ||
      candle.high < Math.max(candle.open, candle.close)
    ) {
      throw new RuntimeRecoveryIncompleteError("Missing or invalid minute in recovery history");
    }
  }
  let position = input.position;
  for (let time = from; time <= to; time += 60_000) {
    const candle = asPriceCandle(minutes.get(time)!);
    const complete =
      time >= input.since.getTime() && time + 60_000 <= input.quote.observedAt.getTime();
    const exit = evaluateExecutionExit(position, candle, input.config);
    if (exit) {
      return {
        position,
        settlement: complete
          ? { ...exit, closedAt: new Date(time + 60_000).toISOString() }
          : settleExecutionPosition(
              position,
              input.quote.price,
              input.quote.observedAt,
              "recovery-exit",
              input.config,
            ),
      };
    }
    const updated = updateExecutionTrailing(position, candle, input.config);
    // Partial bars can contain prices before entry or after the recovery quote.
    // Do not adopt protection derived from a time range we cannot reconstruct.
    if (
      !complete &&
      (updated.bestPrice !== position.bestPrice ||
        updated.stopPrice !== position.stopPrice ||
        updated.trailingPrice !== position.trailingPrice)
    ) {
      return {
        position,
        settlement: settleExecutionPosition(
          position,
          input.quote.price,
          input.quote.observedAt,
          "recovery-exit",
          input.config,
        ),
      };
    }
    // OHLC cannot establish whether protection activated before or after the adverse extreme.
    if (
      evaluateExecutionPriceExit(
        updated,
        {
          symbol: candle.symbol,
          price: position.side === "long" ? candle.low : candle.high,
          observedAt: input.quote.observedAt,
        },
        input.config,
      )
    ) {
      return {
        position: updated,
        settlement: settleExecutionPosition(
          updated,
          input.quote.price,
          input.quote.observedAt,
          "recovery-exit",
          input.config,
        ),
      };
    }
    position = updated;
    for (const signal of input.signals) {
      const closedAt = signal.openTime.getTime() + input.signalIntervalMs;
      if (
        closedAt <= input.since.getTime() ||
        closedAt > input.quote.observedAt.getTime() ||
        closedAt !== time + 60_000
      )
        continue;
      const settlement = evaluateExecutionSignalExit(
        position,
        signal,
        input.config,
        new Date(closedAt),
      );
      if (settlement) return { position, settlement };
    }
  }
  return { position, settlement: null };
}

function asPriceCandle(candle: ExecutionCandle): EnrichedExecutionCandle {
  return {
    ...candle,
    emaFast: null,
    emaSlow: null,
    previousEmaFast: null,
    previousEmaSlow: null,
    rsi: null,
    previousRsi: null,
    atrPercent: null,
    volume24h: 0,
    breakoutHigh: null,
    breakoutLow: null,
    meanReversionZScore: null,
    previousMeanReversionZScore: null,
    momentumPercent: null,
    previousMomentumPercent: null,
  };
}

export function limitRuntimePositionRisk(
  position: ExecutionPosition,
  equity: number,
  maximumNotional: number,
  config: ExecutionStrategyConfig,
): ExecutionPosition | null {
  const stopFill =
    position.stopPrice *
    (position.side === "long"
      ? 1 - config.costs.slippageBps / 10_000
      : 1 + config.costs.slippageBps / 10_000);
  const feePerUnit = position.entryFee / position.quantity;
  const unitLoss =
    Math.max(0, (position.entryPrice - stopFill) * (position.side === "long" ? 1 : -1)) +
    feePerUnit +
    (stopFill * config.costs.takerFeeBps) / 10_000;
  const quantity = Math.min(
    position.quantity,
    maximumNotional / (position.entryPrice + feePerUnit),
    (Math.max(0, equity) * config.risk.riskPerTradePercent) / 100 / unitLoss,
  );
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const scale = quantity / position.quantity;
  return {
    ...position,
    quantity,
    entryFee: position.entryFee * scale,
    entrySlippage: position.entrySlippage * scale,
  };
}
