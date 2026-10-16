import type { ExecutionStrategyConfig } from "./execution-engine";
import { readExecutionRiskConfig, type ExecutionAccountSafety } from "./execution-account";
import { readExecutionExitPolicy, type ExecutionExitPolicy } from "./execution-exit-policy";
import { readExecutionFundingPolicy, type ExecutionFundingPolicy } from "./execution-funding";
import type { ExecutionEntryLiquidityPolicy } from "./execution-entry-liquidity";
import type { ExecutionProfitProtectionPolicy } from "./execution-profit-protection";
export const executionPolicyVersion = "cryptoanal-execution-policy@1";
export type ExecutionPolicySettings = {
  accountSafety: ExecutionAccountSafety;
  profitProtection: ExecutionProfitProtectionPolicy | null;
  marketEntry: { ttlMs: number; maxDeviationBps: number };
  entryLiquidity: ExecutionEntryLiquidityPolicy;
  exit: ExecutionExitPolicy;
  funding: ExecutionFundingPolicy | null;
};
export type ExecutionPolicySnapshot = {
  version: typeof executionPolicyVersion;
  capturedAt: string;
  strategy: ExecutionStrategyConfig;
  settings: ExecutionPolicySettings;
  dataModel: "public-trade-l1@1" | "ohlc-adverse-first@1";
  instrumentModel: "per-entry-snapshot" | "fixed-snapshot-scenario";
  calendar: {
    strategyTimezone: string;
    accountSafetyTimezone: "UTC";
    latch: "until-next-utc-day@1";
  };
};
export type PinnedExecutionPolicy = {
  payload: ExecutionPolicySnapshot;
  hash: string;
  profileHash: string;
};
export function canonicalExecutionValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalExecutionValue).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalExecutionValue(v)}`)
      .join(",")}}`;
  const s = JSON.stringify(v);
  if (s === undefined) throw new Error("Invalid policy value");
  return s;
}
export function executionPolicyProfile(p: ExecutionPolicySnapshot) {
  return { version: p.version, strategy: p.strategy, settings: p.settings, calendar: p.calendar };
}
export function readExecutionPolicy(value: unknown): ExecutionPolicySnapshot {
  const p = value as ExecutionPolicySnapshot;
  if (
    !p ||
    p.version !== executionPolicyVersion ||
    !Number.isFinite(Date.parse(p.capturedAt)) ||
    !readExecutionRiskConfig(p.strategy) ||
    !["public-trade-l1@1", "ohlc-adverse-first@1"].includes(p.dataModel) ||
    !["per-entry-snapshot", "fixed-snapshot-scenario"].includes(p.instrumentModel) ||
    p.calendar?.strategyTimezone !== p.strategy.schedule.timezone ||
    p.calendar.accountSafetyTimezone !== "UTC" ||
    p.calendar.latch !== "until-next-utc-day@1"
  )
    throw new Error("Invalid execution policy snapshot");
  const exit = p.strategy.exit;
  if (
    (exit.signalExitModel !== undefined && exit.signalExitModel !== "family-invalidation@1") ||
    (exit.maxHoldingMinutes !== undefined &&
      (!Number.isInteger(exit.maxHoldingMinutes) ||
        exit.maxHoldingMinutes < 1 ||
        exit.maxHoldingMinutes > 525600))
  )
    throw new Error("Invalid position exit configuration");
  const s = p.settings,
    a = s?.accountSafety;
  if (
    !a ||
    ![
      a.initialBalance,
      a.maxDailyLossPercent,
      a.maxAccountExposurePercent,
      a.maxOpenPositions,
      a.maxQuoteAgeMs,
    ].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0) ||
    a.maxDailyLossPercent > 100 ||
    a.maxAccountExposurePercent > 100 ||
    !Number.isInteger(a.maxOpenPositions)
  )
    throw new Error("Invalid account safety policy");
  if (s.funding === undefined || s.profitProtection === undefined)
    throw new Error("Incomplete execution policy snapshot");
  readExecutionExitPolicy(s.exit);
  readExecutionFundingPolicy(s.funding);
  if (
    ![
      s.marketEntry.ttlMs,
      s.marketEntry.maxDeviationBps,
      s.entryLiquidity.maximumBookAgeMs,
      s.entryLiquidity.maximumSpreadBps,
      s.entryLiquidity.maximumSlippageBps,
      s.entryLiquidity.makerParticipationBps,
    ].every((v) => Number.isFinite(v) && v >= 0) ||
    s.marketEntry.ttlMs <= 0 ||
    s.entryLiquidity.maximumBookAgeMs <= 0 ||
    s.entryLiquidity.makerParticipationBps <= 0 ||
    s.entryLiquidity.makerParticipationBps > 10000
  )
    throw new Error("Invalid entry policy");
  const g = s.profitProtection;
  if (
    g &&
    (!Number.isFinite(Date.parse(g.enabledAt)) ||
      ![g.breakEvenActivationR, g.trailingActivationR, g.trailingDistanceR].every(
        (v) => Number.isFinite(v) && v > 0,
      ) ||
      g.trailingDistanceR >= g.trailingActivationR)
  )
    throw new Error("Invalid protection policy");
  return structuredClone(p);
}
export function makeExecutionPolicy(
  strategy: ExecutionStrategyConfig,
  settings: ExecutionPolicySettings,
  dataModel: ExecutionPolicySnapshot["dataModel"],
  capturedAt = new Date(),
): ExecutionPolicySnapshot {
  return readExecutionPolicy({
    version: executionPolicyVersion,
    capturedAt: capturedAt.toISOString(),
    strategy,
    settings,
    dataModel,
    instrumentModel:
      dataModel === "public-trade-l1@1" ? "per-entry-snapshot" : "fixed-snapshot-scenario",
    calendar: {
      strategyTimezone: strategy.schedule.timezone,
      accountSafetyTimezone: "UTC",
      latch: "until-next-utc-day@1",
    },
  });
}
export function compareExecutionPolicies(
  a: ExecutionPolicySnapshot | null,
  b: ExecutionPolicySnapshot | null,
) {
  if (!a || !b) return { status: "unavailable" as const, reasons: ["EXECUTION_POLICY_MISSING"] };
  if (
    canonicalExecutionValue(executionPolicyProfile(a)) !==
    canonicalExecutionValue(executionPolicyProfile(b))
  )
    return { status: "incompatible" as const, reasons: ["EXECUTION_POLICY_MISMATCH"] };
  const reasons: string[] = [];
  if (a.dataModel !== b.dataModel) reasons.push("MARKET_EVENT_RESOLUTION");
  if (a.instrumentModel !== b.instrumentModel) reasons.push("HISTORICAL_INSTRUMENT_SCENARIO");
  return { status: reasons.length ? ("scenario-only" as const) : ("equivalent" as const), reasons };
}
