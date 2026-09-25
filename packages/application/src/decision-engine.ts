import { createHash } from "node:crypto";

import type { ExecutionCandle, ExecutionMarketRegime } from "./execution-engine";

export const decisionContextSchemaVersion = 1;
export const decisionFeatureSetVersion = "decision-features@1";
export const defaultDecisionMemoryLimit = 8;

export type DecisionProviderKind = "rule-based" | "ml" | "llm";
export type DecisionMode = "execution" | "shadow";
export type DecisionCandidateAction = "BUY" | "SELL" | "HOLD";

export type DecisionOhlcvPoint = {
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover: number;
};

export type DecisionIndicatorSet = {
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  atr14: number | null;
  atrPercent: number | null;
  adx14: number | null;
  chop14: number | null;
  rvol20: number | null;
  zScore20: number | null;
  slope20PercentPerBar: number | null;
  pivot: number | null;
  support1: number | null;
  resistance1: number | null;
};

export type DecisionMarketFrame = {
  timeframe: string;
  intervalMs: number;
  availableAt: string;
  lastClosedAt: string | null;
  regime: ExecutionMarketRegime;
  candles: DecisionOhlcvPoint[];
  indicators: DecisionIndicatorSet;
};

export type DecisionPositionContext = {
  id: string;
  side: "long" | "short";
  openedAt: string;
  entryPrice: number;
  markPrice: number | null;
  quantity: number;
  stopPrice: number;
  takePrice: number;
  trailingPrice: number | null;
  unrealizedPnl: number;
};

export type DecisionMemoryEntry = {
  decisionId: string;
  decidedAt: string;
  action: "OPEN" | "CLOSE" | "HOLD" | "SKIP" | "ERROR";
  reasonCode: string;
  summary: string;
  providerId: string;
  mode: DecisionMode;
};

export type DecisionContextSnapshot = {
  schemaVersion: typeof decisionContextSchemaVersion;
  featureSetVersion: typeof decisionFeatureSetVersion;
  workspaceId: string;
  executionRunId: string;
  strategyVersionId: string;
  strategyConfigHash: string;
  engineVersion: string;
  symbol: string;
  availableAt: string;
  market: {
    primary: DecisionMarketFrame;
    higherTimeframes: DecisionMarketFrame[];
  };
  account: {
    equity: number;
    availableBalance: number | null;
    realizedPnlToday: number;
    openExposure: number;
  };
  position: DecisionPositionContext | null;
  risk: {
    entriesAllowed: boolean;
    maxOpenPositions: number;
    maxDailyLossPercent: number;
    riskPerTradePercent: number;
    maximumAccountExposure: number | null;
    remainingAccountExposure: number | null;
  };
  memory: DecisionMemoryEntry[];
};

export type HashedDecisionContextSnapshot = {
  snapshot: DecisionContextSnapshot;
  contentHash: string;
};

export type DecisionCandidate = {
  action: DecisionCandidateAction;
  side: "long" | "short" | null;
  tradable: boolean;
  confidence: number;
  riskBudgetPercent: number | null;
  stopLossPercent: number | null;
  takeProfitPercent: number | null;
  horizonCandles: number | null;
  reasonCodes: string[];
  summary: string;
  generatedAt: string;
  validUntil: string;
};

export type DecisionProviderDescriptor = {
  id: string;
  version: string;
  kind: DecisionProviderKind;
};

export type DecisionProvider = DecisionProviderDescriptor & {
  decide(input: {
    context: DecisionContextSnapshot;
    contextHash: string;
    signal: AbortSignal;
  }): Promise<DecisionCandidate>;
};

export type ShadowDecisionResult = {
  provider: DecisionProviderDescriptor;
  contextHash: string;
  mode: "shadow";
  status: "accepted" | "rejected" | "error" | "timeout";
  candidate: DecisionCandidate | null;
  rejectionCode: string | null;
  latencyMs: number;
};

export type DecisionCadence = {
  intervalMs: number;
  deadlineMs: number;
};

export type RecordedDecisionReplayResult = {
  status: "no-trade" | "completed" | "insufficient-data";
  side: "long" | "short" | null;
  entryPrice: number | null;
  exitPrice: number | null;
  exitReason: "stop-loss" | "take-profit" | "horizon" | null;
  candlesObserved: number;
  grossReturnPercent: number | null;
  netReturnPercent: number | null;
  maximumFavorableExcursionPercent: number | null;
  maximumAdverseExcursionPercent: number | null;
};

export type RecordedDecisionReplaySummary = {
  candidates: number;
  completedTrades: number;
  noTrades: number;
  insufficientData: number;
  coveragePercent: number;
  wins: number;
  losses: number;
  winRatePercent: number | null;
  grossExpectancyPercent: number | null;
  netExpectancyPercent: number | null;
  cumulativeNetReturnPercent: number;
  maximumDrawdownPercent: number;
  averageMfePercent: number | null;
  averageMaePercent: number | null;
};

export function buildDecisionMarketFrame(input: {
  candles: ExecutionCandle[];
  timeframe: string;
  intervalMs: number;
  availableAt: Date;
  maxCandles?: number;
}): DecisionMarketFrame {
  const availableAtMs = input.availableAt.getTime();
  const maxCandles = input.maxCandles ?? 48;
  const history = [...input.candles]
    .filter(
      (candle) =>
        Number.isFinite(candle.openTime.getTime()) &&
        candle.openTime.getTime() + input.intervalMs <= availableAtMs,
    )
    .sort((left, right) => left.openTime.getTime() - right.openTime.getTime());
  const candles = history.slice(-maxCandles);
  const points = candles.map(toDecisionOhlcvPoint);
  const closes = history.map((candle) => candle.close);
  const ema20 = last(emaSeries(closes, 20));
  const ema50 = last(emaSeries(closes, 50));
  const rsi14 = calculateRsi(closes, 14);
  const atr14 = calculateAtr(history, 14);
  const macd = calculateMacd(closes);
  const latest = history.at(-1);
  const previous = history.at(-2);
  const pivot = previous ? (previous.high + previous.low + previous.close) / 3 : null;
  const regime = inferRegime(ema20, ema50, rsi14);

  return {
    timeframe: input.timeframe,
    intervalMs: input.intervalMs,
    availableAt: input.availableAt.toISOString(),
    lastClosedAt: latest
      ? new Date(latest.openTime.getTime() + input.intervalMs).toISOString()
      : null,
    regime,
    candles: points,
    indicators: {
      ema20,
      ema50,
      rsi14,
      macd: macd.value,
      macdSignal: macd.signal,
      atr14,
      atrPercent: atr14 !== null && latest?.close ? (atr14 / latest.close) * 100 : null,
      adx14: calculateAdx(history, 14),
      chop14: calculateChop(history, 14),
      rvol20: calculateRelativeVolume(history, 20),
      zScore20: calculateZScore(closes, 20),
      slope20PercentPerBar: calculateSlopePercent(closes, 20),
      pivot,
      support1: pivot !== null && previous ? 2 * pivot - previous.high : null,
      resistance1: pivot !== null && previous ? 2 * pivot - previous.low : null,
    },
  };
}

export function createDecisionContextSnapshot(
  input: Omit<
    DecisionContextSnapshot,
    "schemaVersion" | "featureSetVersion" | "memory" | "market"
  > & {
    primaryFrame: DecisionMarketFrame;
    higherTimeframes?: DecisionMarketFrame[];
    memory?: DecisionMemoryEntry[];
  },
): HashedDecisionContextSnapshot {
  assertIsoTimestamp(input.availableAt, "availableAt");
  if (input.primaryFrame.availableAt !== input.availableAt) {
    throw new Error("Primary market frame and decision context must share availableAt");
  }
  const snapshot: DecisionContextSnapshot = {
    schemaVersion: decisionContextSchemaVersion,
    featureSetVersion: decisionFeatureSetVersion,
    workspaceId: input.workspaceId,
    executionRunId: input.executionRunId,
    strategyVersionId: input.strategyVersionId,
    strategyConfigHash: input.strategyConfigHash,
    engineVersion: input.engineVersion,
    symbol: input.symbol,
    availableAt: input.availableAt,
    market: {
      primary: input.primaryFrame,
      higherTimeframes: [...(input.higherTimeframes ?? [])].sort(
        (left, right) => left.intervalMs - right.intervalMs,
      ),
    },
    account: input.account,
    position: input.position,
    risk: input.risk,
    memory: trimDecisionMemory(input.memory ?? []),
  };
  return { snapshot, contentHash: hashDecisionContextSnapshot(snapshot) };
}

export function hashDecisionContextSnapshot(snapshot: DecisionContextSnapshot): string {
  return createHash("sha256").update(stableJson(snapshot)).digest("hex");
}

export function trimDecisionMemory(
  entries: DecisionMemoryEntry[],
  limit = defaultDecisionMemoryLimit,
): DecisionMemoryEntry[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Decision memory limit is invalid");
  return [...entries]
    .sort((left, right) => left.decidedAt.localeCompare(right.decidedAt))
    .slice(-limit);
}

export function validateDecisionCandidate(
  candidate: DecisionCandidate,
  snapshot: DecisionContextSnapshot,
  now = new Date(),
): string | null {
  if (
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  )
    return "INVALID_CONFIDENCE";
  if (!candidate.summary.trim() || candidate.summary.length > 500) return "INVALID_SUMMARY";
  if (candidate.reasonCodes.length === 0 || candidate.reasonCodes.length > 12)
    return "INVALID_REASON_CODES";
  if (candidate.reasonCodes.some((code) => !/^[A-Z0-9_:-]{2,64}$/.test(code)))
    return "INVALID_REASON_CODE";
  if (candidate.action === "HOLD" && candidate.side !== null) return "HOLD_WITH_SIDE";
  if (candidate.action !== "HOLD" && candidate.side === null) return "ACTION_WITHOUT_SIDE";
  if (candidate.action === "BUY" && candidate.side !== "long") return "BUY_SIDE_MISMATCH";
  if (candidate.action === "SELL" && candidate.side !== "short") return "SELL_SIDE_MISMATCH";
  if (!candidate.tradable && candidate.action !== "HOLD") return "UNTRADABLE_ACTION";
  if (!validOptionalPercent(candidate.riskBudgetPercent)) return "INVALID_RISK_BUDGET";
  if (!validOptionalPercent(candidate.stopLossPercent)) return "INVALID_STOP_LOSS";
  if (!validOptionalPercent(candidate.takeProfitPercent)) return "INVALID_TAKE_PROFIT";
  if (
    candidate.horizonCandles !== null &&
    (!Number.isInteger(candidate.horizonCandles) || candidate.horizonCandles <= 0)
  )
    return "INVALID_HORIZON";
  const generatedAt = Date.parse(candidate.generatedAt);
  const validUntil = Date.parse(candidate.validUntil);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(validUntil) || validUntil < generatedAt)
    return "INVALID_VALIDITY_WINDOW";
  if (generatedAt < Date.parse(snapshot.availableAt)) return "GENERATED_BEFORE_CONTEXT";
  if (validUntil < now.getTime()) return "STALE_DECISION";
  if (!snapshot.risk.entriesAllowed && candidate.action !== "HOLD") return "ENTRY_GATE_CLOSED";
  return null;
}

export async function runShadowDecisionProviders(input: {
  providers: DecisionProvider[];
  context: HashedDecisionContextSnapshot;
  timeoutMs: number;
  now?: Date;
}): Promise<ShadowDecisionResult[]> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)
    throw new Error("Shadow provider timeout must be positive");
  const now = input.now ?? new Date();
  return Promise.all(
    input.providers.map(async (provider) => {
      const startedAt = performance.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        const candidate = await provider.decide({
          context: input.context.snapshot,
          contextHash: input.context.contentHash,
          signal: controller.signal,
        });
        const rejectionCode = validateDecisionCandidate(candidate, input.context.snapshot, now);
        return {
          provider: descriptor(provider),
          contextHash: input.context.contentHash,
          mode: "shadow" as const,
          status: rejectionCode ? ("rejected" as const) : ("accepted" as const),
          candidate,
          rejectionCode,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        };
      } catch {
        return {
          provider: descriptor(provider),
          contextHash: input.context.contentHash,
          mode: "shadow" as const,
          status: controller.signal.aborted ? ("timeout" as const) : ("error" as const),
          candidate: null,
          rejectionCode: controller.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR",
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        };
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
}

export function getDecisionCadenceWindow(input: {
  availableAt: Date;
  lastEvaluatedAt: Date | null;
  cadence: DecisionCadence;
}): { due: boolean; validUntil: Date } {
  if (!Number.isInteger(input.cadence.intervalMs) || input.cadence.intervalMs <= 0)
    throw new Error("Decision cadence interval must be a positive integer");
  if (!Number.isInteger(input.cadence.deadlineMs) || input.cadence.deadlineMs <= 0)
    throw new Error("Decision cadence deadline must be a positive integer");
  const due =
    input.lastEvaluatedAt === null ||
    input.availableAt.getTime() - input.lastEvaluatedAt.getTime() >= input.cadence.intervalMs;
  return {
    due,
    validUntil: new Date(input.availableAt.getTime() + input.cadence.deadlineMs),
  };
}

export function evaluateRecordedDecisionCandidate(input: {
  candidate: DecisionCandidate;
  availableAt: Date;
  asOf: Date;
  intervalMs: number;
  candles: ExecutionCandle[];
  roundTripCostBps?: number;
  fallbackHorizonCandles?: number;
}): RecordedDecisionReplayResult {
  if (input.candidate.action === "HOLD" || input.candidate.side === null) {
    return replayResult("no-trade", null, 0);
  }
  const horizon = input.candidate.horizonCandles ?? input.fallbackHorizonCandles ?? 12;
  if (!Number.isInteger(horizon) || horizon <= 0) throw new Error("Replay horizon is invalid");
  const candles = [...input.candles]
    .filter(
      (candle) =>
        candle.openTime.getTime() >= input.availableAt.getTime() &&
        candle.openTime.getTime() + input.intervalMs <= input.asOf.getTime(),
    )
    .sort((left, right) => left.openTime.getTime() - right.openTime.getTime())
    .slice(0, horizon);
  if (candles.length === 0) return replayResult("insufficient-data", input.candidate.side, 0);

  const side = input.candidate.side;
  const entryPrice = candles[0]!.open;
  const stopPrice =
    input.candidate.stopLossPercent === null
      ? null
      : entryPrice *
        (side === "long"
          ? 1 - input.candidate.stopLossPercent / 100
          : 1 + input.candidate.stopLossPercent / 100);
  const takePrice =
    input.candidate.takeProfitPercent === null
      ? null
      : entryPrice *
        (side === "long"
          ? 1 + input.candidate.takeProfitPercent / 100
          : 1 - input.candidate.takeProfitPercent / 100);
  let favorable = 0;
  let adverse = 0;
  let exitPrice: number | null = null;
  let exitReason: RecordedDecisionReplayResult["exitReason"] = null;
  let candlesObserved = 0;

  for (const candle of candles) {
    candlesObserved += 1;
    const favorablePrice = side === "long" ? candle.high : candle.low;
    const adversePrice = side === "long" ? candle.low : candle.high;
    favorable = Math.max(favorable, signedReturnPercent(side, entryPrice, favorablePrice));
    adverse = Math.min(adverse, signedReturnPercent(side, entryPrice, adversePrice));
    const stopTouched =
      stopPrice !== null && (side === "long" ? candle.low <= stopPrice : candle.high >= stopPrice);
    if (stopTouched) {
      exitPrice = stopPrice;
      exitReason = "stop-loss";
      break;
    }
    const takeTouched =
      takePrice !== null && (side === "long" ? candle.high >= takePrice : candle.low <= takePrice);
    if (takeTouched) {
      exitPrice = takePrice;
      exitReason = "take-profit";
      break;
    }
  }
  if (exitPrice === null && candles.length === horizon) {
    exitPrice = candles.at(-1)!.close;
    exitReason = "horizon";
  }
  if (exitPrice === null) {
    return {
      ...replayResult("insufficient-data", side, candlesObserved),
      entryPrice,
      maximumFavorableExcursionPercent: favorable,
      maximumAdverseExcursionPercent: Math.abs(adverse),
    };
  }
  const grossReturnPercent = signedReturnPercent(side, entryPrice, exitPrice);
  return {
    status: "completed",
    side,
    entryPrice,
    exitPrice,
    exitReason,
    candlesObserved,
    grossReturnPercent,
    netReturnPercent: grossReturnPercent - (input.roundTripCostBps ?? 0) / 100,
    maximumFavorableExcursionPercent: favorable,
    maximumAdverseExcursionPercent: Math.abs(adverse),
  };
}

export function summarizeRecordedDecisionReplays(
  results: RecordedDecisionReplayResult[],
): RecordedDecisionReplaySummary {
  const completed = results.filter(
    (
      result,
    ): result is RecordedDecisionReplayResult & {
      grossReturnPercent: number;
      netReturnPercent: number;
      maximumFavorableExcursionPercent: number;
      maximumAdverseExcursionPercent: number;
    } =>
      result.status === "completed" &&
      result.grossReturnPercent !== null &&
      result.netReturnPercent !== null &&
      result.maximumFavorableExcursionPercent !== null &&
      result.maximumAdverseExcursionPercent !== null,
  );
  let equity = 100;
  let peak = equity;
  let maximumDrawdownPercent = 0;
  for (const result of completed) {
    equity *= 1 + result.netReturnPercent / 100;
    peak = Math.max(peak, equity);
    maximumDrawdownPercent = Math.max(maximumDrawdownPercent, ((peak - equity) / peak) * 100);
  }
  const wins = completed.filter((result) => result.netReturnPercent > 0).length;
  const losses = completed.filter((result) => result.netReturnPercent < 0).length;
  return {
    candidates: results.length,
    completedTrades: completed.length,
    noTrades: results.filter((result) => result.status === "no-trade").length,
    insufficientData: results.filter((result) => result.status === "insufficient-data").length,
    coveragePercent: results.length === 0 ? 0 : (completed.length / results.length) * 100,
    wins,
    losses,
    winRatePercent: completed.length === 0 ? null : (wins / completed.length) * 100,
    grossExpectancyPercent:
      completed.length === 0 ? null : average(completed.map((result) => result.grossReturnPercent)),
    netExpectancyPercent:
      completed.length === 0 ? null : average(completed.map((result) => result.netReturnPercent)),
    cumulativeNetReturnPercent: equity - 100,
    maximumDrawdownPercent,
    averageMfePercent:
      completed.length === 0
        ? null
        : average(completed.map((result) => result.maximumFavorableExcursionPercent)),
    averageMaePercent:
      completed.length === 0
        ? null
        : average(completed.map((result) => result.maximumAdverseExcursionPercent)),
  };
}

function descriptor(provider: DecisionProvider): DecisionProviderDescriptor {
  return { id: provider.id, version: provider.version, kind: provider.kind };
}

function replayResult(
  status: "no-trade" | "insufficient-data",
  side: "long" | "short" | null,
  candlesObserved: number,
): RecordedDecisionReplayResult {
  return {
    status,
    side,
    entryPrice: null,
    exitPrice: null,
    exitReason: null,
    candlesObserved,
    grossReturnPercent: null,
    netReturnPercent: null,
    maximumFavorableExcursionPercent: null,
    maximumAdverseExcursionPercent: null,
  };
}

function signedReturnPercent(side: "long" | "short", entryPrice: number, price: number): number {
  return ((price - entryPrice) / entryPrice) * 100 * (side === "long" ? 1 : -1);
}

function toDecisionOhlcvPoint(candle: ExecutionCandle): DecisionOhlcvPoint {
  return {
    openTime: candle.openTime.toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    turnover: candle.turnover,
  };
}

function inferRegime(
  ema20: number | null,
  ema50: number | null,
  rsi14: number | null,
): ExecutionMarketRegime {
  if (ema20 === null || ema50 === null || rsi14 === null) return "unknown";
  if (ema20 > ema50 * 1.002 && rsi14 >= 52) return "bull";
  if (ema20 < ema50 * 0.998 && rsi14 <= 48) return "bear";
  return "neutral";
}

function emaSeries(values: number[], period: number): Array<number | null> {
  const result = values.map(() => null as number | null);
  if (values.length < period) return result;
  const multiplier = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  for (let index = period; index < values.length; index += 1) {
    current = (values[index]! - current) * multiplier + current;
    result[index] = current;
  }
  return result;
}

function calculateRsi(values: number[], period: number): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function calculateAtr(candles: ExecutionCandle[], period: number): number | null {
  const ranges = trueRanges(candles);
  if (ranges.length < period) return null;
  return average(ranges.slice(-period));
}

function calculateAdx(candles: ExecutionCandle[], period: number): number | null {
  if (candles.length < period * 2 + 1) return null;
  const ranges: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index]!;
    const previous = candles[index - 1]!;
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  let smoothedRange = sum(ranges.slice(0, period));
  let smoothedPlus = sum(plusDm.slice(0, period));
  let smoothedMinus = sum(minusDm.slice(0, period));
  const dx: number[] = [];
  for (let index = period - 1; index < ranges.length; index += 1) {
    if (index >= period) {
      smoothedRange = smoothedRange - smoothedRange / period + ranges[index]!;
      smoothedPlus = smoothedPlus - smoothedPlus / period + plusDm[index]!;
      smoothedMinus = smoothedMinus - smoothedMinus / period + minusDm[index]!;
    }
    const plusDi = smoothedRange === 0 ? 0 : (100 * smoothedPlus) / smoothedRange;
    const minusDi = smoothedRange === 0 ? 0 : (100 * smoothedMinus) / smoothedRange;
    const total = plusDi + minusDi;
    dx.push(total === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / total);
  }
  if (dx.length < period) return null;
  let adx = average(dx.slice(0, period));
  for (const value of dx.slice(period)) adx = (adx * (period - 1) + value) / period;
  return adx;
}

function calculateChop(candles: ExecutionCandle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const window = candles.slice(-period);
  const rangeSum = sum(trueRanges(candles.slice(-(period + 1))));
  const highest = Math.max(...window.map((candle) => candle.high));
  const lowest = Math.min(...window.map((candle) => candle.low));
  if (rangeSum <= 0 || highest <= lowest) return null;
  return (100 * Math.log10(rangeSum / (highest - lowest))) / Math.log10(period);
}

function calculateRelativeVolume(candles: ExecutionCandle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const latest = candles.at(-1)!.turnover;
  const baseline = average(candles.slice(-(period + 1), -1).map((candle) => candle.turnover));
  return baseline > 0 ? latest / baseline : null;
}

function calculateZScore(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const window = values.slice(-period);
  const mean = average(window);
  const deviation = Math.sqrt(
    window.reduce((total, value) => total + (value - mean) ** 2, 0) / window.length,
  );
  return deviation === 0 ? 0 : (window.at(-1)! - mean) / deviation;
}

function calculateSlopePercent(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const window = values.slice(-period);
  const meanX = (period - 1) / 2;
  const meanY = average(window);
  if (meanY === 0) return null;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < period; index += 1) {
    numerator += (index - meanX) * (window[index]! - meanY);
    denominator += (index - meanX) ** 2;
  }
  return denominator === 0 ? null : (numerator / denominator / meanY) * 100;
}

function calculateMacd(values: number[]): { value: number | null; signal: number | null } {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const macdSeries = values.map((_, index) => {
    const fastValue = fast[index];
    const slowValue = slow[index];
    return fastValue == null || slowValue == null ? null : fastValue - slowValue;
  });
  const defined = macdSeries.filter((value): value is number => value !== null);
  return { value: last(macdSeries), signal: last(emaSeries(defined, 9)) };
}

function trueRanges(candles: ExecutionCandle[]): number[] {
  const ranges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const previousClose = candles[index - 1]!.close;
    ranges.push(
      Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose),
      ),
    );
  }
  return ranges;
}

function validOptionalPercent(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value > 0 && value <= 100);
}

function assertIsoTimestamp(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
}

function last(values: Array<number | null>): number | null {
  return values.at(-1) ?? null;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
