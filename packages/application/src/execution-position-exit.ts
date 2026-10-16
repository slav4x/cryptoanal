import { assertExecutionExitQuote } from "./execution-exit-policy";
import {
  settleExecutionPosition,
  type EnrichedExecutionCandle,
  type ExecutionPosition,
  type ExecutionQuote,
  type ExecutionStrategyConfig,
  type PendingExecutionSignal,
} from "./execution-engine";

export const positionExitVersion = "cryptoanal-position-exit@1";
export type ExecutionPositionExitPolicy = {
  version: typeof positionExitVersion;
  signalModel: "legacy" | "family-invalidation@1";
  signalEnabled: boolean;
  family: ExecutionStrategyConfig["signal"]["family"];
  breakoutLevel: number | null;
  maxHoldingMs: number | null;
};

export function readExecutionPositionExitPolicy(
  value: unknown,
): ExecutionPositionExitPolicy | null {
  if (value == null) return null;
  const p = value as ExecutionPositionExitPolicy;
  if (
    p.version !== positionExitVersion ||
    !["legacy", "family-invalidation@1"].includes(p.signalModel) ||
    typeof p.signalEnabled !== "boolean" ||
    !["ema-crossover", "breakout", "momentum", "mean-reversion"].includes(p.family) ||
    (p.maxHoldingMs !== null &&
      (!Number.isSafeInteger(p.maxHoldingMs) ||
        p.maxHoldingMs < 60000 ||
        p.maxHoldingMs > 31536000000)) ||
    (p.signalModel === "family-invalidation@1" && p.family === "breakout" && p.signalEnabled
      ? typeof p.breakoutLevel !== "number" ||
        !Number.isFinite(p.breakoutLevel) ||
        p.breakoutLevel <= 0
      : p.breakoutLevel !== null)
  )
    throw new Error("Invalid position exit policy");
  return { ...p };
}

export function makeExecutionPositionExitPolicy(
  config: ExecutionStrategyConfig,
  signal: PendingExecutionSignal,
): ExecutionPositionExitPolicy | null {
  if (config.exit.signalExitModel === undefined && config.exit.maxHoldingMinutes === undefined)
    return null;
  return readExecutionPositionExitPolicy({
    version: positionExitVersion,
    signalModel: config.exit.signalExitModel ?? "legacy",
    signalEnabled: config.exit.exitOnSignalReversal,
    family: config.signal.family,
    breakoutLevel:
      config.exit.signalExitModel &&
      config.signal.family === "breakout" &&
      config.exit.exitOnSignalReversal
        ? signal.breakoutLevel
        : null,
    maxHoldingMs:
      config.exit.maxHoldingMinutes === undefined ? null : config.exit.maxHoldingMinutes * 60000,
  });
}

export function executionHoldingDeadline(position: ExecutionPosition): Date | null {
  const duration = position.positionExitPolicy?.maxHoldingMs;
  return duration == null ? null : new Date(+position.openedAt + duration);
}

export function evaluateExecutionHoldingExit(
  position: ExecutionPosition,
  quote: ExecutionQuote,
  config: ExecutionStrategyConfig,
) {
  const deadline = executionHoldingDeadline(position);
  if (!deadline || quote.observedAt < deadline || quote.symbol !== position.symbol) return null;
  if (!Number.isFinite(+quote.observedAt) || !Number.isFinite(quote.price) || quote.price <= 0)
    throw new Error("Invalid holding deadline quote");
  assertExecutionExitQuote(position, quote);
  return settleExecutionPosition(
    position,
    quote.price,
    quote.observedAt,
    "holding-timeout",
    config,
  );
}

export function executionSignalExitEnabled(
  position: ExecutionPosition,
  config: ExecutionStrategyConfig,
) {
  const p = position.positionExitPolicy;
  return p?.signalModel === "family-invalidation@1"
    ? p.signalEnabled
    : config.signal.family === "mean-reversion" ||
        (config.signal.family === "ema-crossover" && config.exit.exitOnSignalReversal);
}

export function executionFamilySignalExit(
  position: ExecutionPosition,
  candle: EnrichedExecutionCandle,
): "breakout-invalidated" | "momentum-invalidated" | "mean-return" | null {
  const p = position.positionExitPolicy;
  if (p?.signalModel !== "family-invalidation@1" || !p.signalEnabled) return null;
  const long = position.side === "long";
  if (
    p.family === "breakout" &&
    p.breakoutLevel !== null &&
    (long ? candle.close <= p.breakoutLevel : candle.close >= p.breakoutLevel)
  )
    return "breakout-invalidated";
  if (
    p.family === "momentum" &&
    candle.momentumPercent !== null &&
    (long ? candle.momentumPercent <= 0 : candle.momentumPercent >= 0)
  )
    return "momentum-invalidated";
  if (
    p.family === "mean-reversion" &&
    candle.meanReversionZScore !== null &&
    (long ? candle.meanReversionZScore >= 0 : candle.meanReversionZScore <= 0)
  )
    return "mean-return";
  return null;
}
