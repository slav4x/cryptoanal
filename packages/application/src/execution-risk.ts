import {
  executionDecimalProduct,
  executionDecimalSum,
  roundExecutionStep,
} from "./execution-instrument";

export function executionStopRisk(input: {
  tickSize?: string;
  side: "long" | "short";
  entryPrice: number;
  stopPrice: number;
  quantity: number;
  entryFee: number;
  takerFeeBps: number;
  slippageBps: number;
}): number | null {
  const { side, entryPrice, stopPrice, quantity, entryFee, takerFeeBps, slippageBps } = input;
  if (
    ![entryPrice, stopPrice, quantity, entryFee, takerFeeBps, slippageBps].every(Number.isFinite) ||
    entryPrice <= 0 ||
    stopPrice <= 0 ||
    quantity <= 0 ||
    entryFee < 0 ||
    takerFeeBps < 0 ||
    slippageBps < 0
  )
    return null;
  const direction = side === "long" ? 1 : -1;
  const stopFill = input.tickSize
    ? Number(
        roundExecutionStep(
          executionDecimalProduct(
            stopPrice,
            executionDecimalSum(1, executionDecimalProduct(slippageBps, -direction * 0.0001)),
          ),
          input.tickSize,
          side === "long" ? "floor" : "ceil",
        ),
      )
    : stopPrice * (1 - (direction * slippageBps) / 10_000);
  if (!Number.isFinite(stopFill) || stopFill <= 0) return null;
  const loss =
    Math.max(0, (entryPrice - stopFill) * direction) * quantity +
    entryFee +
    (stopFill * quantity * takerFeeBps) / 10_000;
  return Number.isFinite(loss) ? loss : null;
}

export function remainingExecutionStopBudget(input: {
  dailyLimit: number;
  dailyPnl: number;
  equityWithoutFloatingGains: number;
  reservedStopRisk: number;
}): number {
  const { dailyLimit, dailyPnl, equityWithoutFloatingGains, reservedStopRisk } = input;
  if (
    ![dailyLimit, dailyPnl, equityWithoutFloatingGains, reservedStopRisk].every(Number.isFinite) ||
    dailyLimit < 0 ||
    reservedStopRisk < 0
  )
    return 0;
  return Math.max(
    0,
    Math.min(dailyLimit + dailyPnl, equityWithoutFloatingGains) - reservedStopRisk,
  );
}
