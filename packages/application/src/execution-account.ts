import { executionStopRisk, remainingExecutionStopBudget } from "./execution-risk";
import { getTradingDateKey, type ExecutionStrategyConfig } from "./execution-engine";
export type ExecutionAccountSafety = {
  initialBalance: number;
  maxDailyLossPercent: number;
  maxAccountExposurePercent: number;
  maxOpenPositions: number;
  maxQuoteAgeMs: number;
};
export const defaultExecutionAccountSafety: ExecutionAccountSafety = {
  initialBalance: 10000,
  maxDailyLossPercent: 10,
  maxAccountExposurePercent: 100,
  maxOpenPositions: 20,
  maxQuoteAgeMs: 10000,
};
export type ExecutionRiskConfig = {
  timezone: string;
  maxDailyLossPercent: number;
  maxOpenPositions: number;
  riskPerTradePercent: number;
  takerFeeBps: number;
  slippageBps: number;
};
export function readExecutionRiskConfig(value: unknown): ExecutionRiskConfig | null {
  const c = value as ExecutionStrategyConfig | null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: c?.schedule?.timezone });
  } catch {
    return null;
  }
  if (typeof c?.schedule?.timezone !== "string") return null;
  const n = [
    c.risk?.maxDailyLossPercent,
    c.risk?.maxOpenPositions,
    c.risk?.riskPerTradePercent,
    c.costs?.takerFeeBps,
    c.costs?.slippageBps,
  ];
  if (n.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) return null;
  return {
    timezone: c.schedule.timezone,
    maxDailyLossPercent: n[0]!,
    maxOpenPositions: n[1]!,
    riskPerTradePercent: n[2]!,
    takerFeeBps: n[3]!,
    slippageBps: n[4]!,
  };
}
const days = new Map<string, number>();
export function executionTradingDay(now: Date, timezone: string) {
  if (!Number.isFinite(+now)) throw new Error("Invalid trading clock");
  const day = getTradingDateKey(now, timezone),
    key = `${timezone}:${day}`;
  let start = days.get(key);
  if (start === undefined) {
    let low = +now - 48 * 3600000,
      high = +now;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (getTradingDateKey(new Date(mid), timezone) < day) low = mid;
      else high = mid;
    }
    start = high;
    days.set(key, start);
  }
  return { day, startsAt: new Date(start) };
}
export type ExecutionAccountPosition = {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  stopPrice: number;
  trailingPrice: number | null;
  quantity: number;
  entryFee: number;
  markPrice: number;
  realizedPnl: number;
  costs: ExecutionRiskConfig | null;
  tickSize?: string;
};
export function assessExecutionAccount(input: {
  policy: ExecutionAccountSafety;
  config: unknown;
  now: Date;
  realizedNetPnl: number;
  utcCashPnl: number;
  strategyCashPnl: number;
  positions: ExecutionAccountPosition[];
  marketReady?: boolean;
  fundingReady?: boolean;
  utcHalted?: boolean;
  killSwitch?: boolean;
}) {
  const configured = readExecutionRiskConfig(input.config),
    policy = input.policy;
  const calendar = executionTradingDay(input.now, configured?.timezone ?? "UTC");
  let equity = policy.initialBalance + input.realizedNetPnl,
    dailyPnl = input.utcCashPnl,
    exposure = 0,
    floatingGains = 0,
    reservedStopRisk = 0,
    stopRiskValid = true;
  for (const p of input.positions) {
    if (p.quantity === 0) {
      equity += p.realizedPnl;
      continue;
    }
    const pnl = (p.markPrice - p.entryPrice) * p.quantity * (p.side === "long" ? 1 : -1);
    const exitCosts =
      (p.markPrice * p.quantity * ((p.costs?.takerFeeBps ?? 0) + (p.costs?.slippageBps ?? 0))) /
      10000;
    const stop =
      p.trailingPrice === null
        ? p.stopPrice
        : (p.side === "long" ? Math.max : Math.min)(p.stopPrice, p.trailingPrice);
    const risk = p.costs
      ? executionStopRisk({
          side: p.side,
          entryPrice: p.entryPrice,
          stopPrice: stop,
          quantity: p.quantity,
          entryFee: p.entryFee,
          takerFeeBps: p.costs.takerFeeBps,
          slippageBps: p.costs.slippageBps,
          ...(p.tickSize ? { tickSize: p.tickSize } : {}),
        })
      : null;
    if (risk === null) stopRiskValid = false;
    else reservedStopRisk += Math.max(0, risk - (Math.max(0, -pnl) + p.entryFee + exitCosts));
    floatingGains += Math.max(0, pnl);
    equity += p.realizedPnl + pnl - p.entryFee - exitCosts;
    dailyPnl += Math.min(0, pnl) - p.entryFee - exitCosts;
    exposure += p.markPrice * p.quantity;
  }
  const dailyLimit =
    (policy.initialBalance *
      Math.min(
        policy.maxDailyLossPercent,
        configured?.maxDailyLossPercent ?? 0,
        ...input.positions.map((p) => p.costs?.maxDailyLossPercent ?? 0),
      )) /
    100;
  const remainingStopRisk = remainingExecutionStopBudget({
    dailyLimit,
    dailyPnl,
    equityWithoutFloatingGains: equity - floatingGains,
    reservedStopRisk,
  });
  const shouldLatch = !!configured && (equity <= 0 || dailyPnl <= -dailyLimit);
  const forceCloseReason = input.killSwitch
    ? ("kill-switch" as const)
    : input.utcHalted || shouldLatch
      ? ("daily-loss-limit" as const)
      : null;
  const strategyLossLimit = (policy.initialBalance * (configured?.maxDailyLossPercent ?? 0)) / 100;
  const reason =
    forceCloseReason ??
    (input.fundingReady === false
      ? "FUNDING_DATA_UNAVAILABLE"
      : !configured || !stopRiskValid
        ? "INVALID_RISK_CONFIG"
        : input.marketReady === false
          ? "MARKET_RECOVERY_REQUIRED"
          : input.strategyCashPnl <= -strategyLossLimit
            ? "STRATEGY_DAILY_LOSS_LIMIT"
            : remainingStopRisk <= 0
              ? "MAX_ACCOUNT_STOP_RISK"
              : null);
  return {
    policy,
    reason,
    forceCloseReason,
    shouldLatch,
    equity,
    dailyPnl,
    dailyLimit,
    reservedStopRisk,
    remainingStopRisk,
    strategyDay: {
      timezone: configured?.timezone ?? "UTC",
      ...calendar,
      realizedPnl: input.strategyCashPnl,
      lossLimit: strategyLossLimit,
    },
    exposure,
    positions: input.positions.length,
    maximumExposure: (Math.max(0, equity) * policy.maxAccountExposurePercent) / 100,
    maximumPositions: Math.min(policy.maxOpenPositions, configured?.maxOpenPositions ?? 0),
    configured,
  };
}
export function executionAccountEntryFailure(
  risk: ReturnType<typeof assessExecutionAccount>,
  candidate: {
    symbol: string;
    side: "long" | "short";
    quantity: number;
    entryPrice: number;
    stopPrice: number;
    entryFee: number;
    tickSize?: string;
  },
  positions: Pick<ExecutionAccountPosition, "symbol" | "side" | "quantity">[],
) {
  if (risk.reason) return risk.reason;
  const p = candidate;
  if (
    ![p.quantity, p.entryPrice, p.stopPrice, p.entryFee].every(Number.isFinite) ||
    p.quantity <= 0 ||
    p.entryPrice <= 0 ||
    p.stopPrice <= 0 ||
    p.entryFee < 0
  )
    return "INVALID_ENTRY_SIZE";
  if (
    positions.some(
      (other) => other.quantity > 0 && other.symbol === p.symbol && other.side !== p.side,
    )
  )
    return "PORTFOLIO_DIRECTION_CONFLICT";
  if (risk.positions >= risk.maximumPositions) return "MAX_OPEN_POSITIONS";
  if (risk.exposure + p.quantity * p.entryPrice + p.entryFee > risk.maximumExposure + 1e-8)
    return "MAX_ACCOUNT_EXPOSURE";
  const c = risk.configured!;
  const loss = executionStopRisk({ ...p, takerFeeBps: c.takerFeeBps, slippageBps: c.slippageBps });
  if (loss === null) return "INVALID_ENTRY_SIZE";
  if (loss > (Math.max(0, risk.equity) * c.riskPerTradePercent) / 100 + 1e-8)
    return "MAX_TRADE_RISK";
  if (loss > risk.remainingStopRisk + 1e-8) return "MAX_ACCOUNT_STOP_RISK";
  return null;
}
