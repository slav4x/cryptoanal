import {
  enrichExecutionCandles,
  minimumExecutionCandleCount,
  type ExecutionCandle,
  type ExecutionSettlement,
} from "./execution-engine";
import {
  runExecutionPolicySimulation,
  type PolicySimulationInput,
} from "./execution-policy-simulation";
import { readExecutionPolicy, type ExecutionPolicySnapshot } from "./execution-policy";

export const protectionStudyVersion = "cryptoanal-protection-study@1";
export const protectionStudyProtocol = {
  version: protectionStudyVersion,
  model: "ohlc-adverse-first@1",
  activation: "from-window-start-new-entries-only@1",
  split: { training: 0.6, validation: 0.2, holdout: 0.2 },
  walkForward: { initialTraining: 0.4, developmentThrough: 0.8, folds: 3 },
  minimumTrades: { training: 40, validation: 20, holdout: 30, walkForwardTest: 20 },
  minimumPositiveFolds: 2,
  minimumImprovementCapitalPercent: 0.5,
  maximumDrawdownIncreasePp: 0,
  minimumPairedCoverage: 0.5,
  maximumPrematureExitIncreasePp: 5,
  minimumForwardCandidateTraces: 30,
} as const;
export type ProtectionParameters = {
  breakEvenActivationR: number;
  trailingActivationR: number;
  trailingDistanceR: number;
};
export const protectionStudyCandidates: ReadonlyArray<{
  id: string;
  parameters: ProtectionParameters | null;
  selectable: boolean;
}> = [
  {
    id: "current",
    parameters: { breakEvenActivationR: 0.5, trailingActivationR: 1, trailingDistanceR: 0.5 },
    selectable: true,
  },
  {
    id: "later-break-even",
    parameters: { breakEvenActivationR: 0.75, trailingActivationR: 1, trailingDistanceR: 0.5 },
    selectable: true,
  },
  {
    id: "later-trailing",
    parameters: { breakEvenActivationR: 0.5, trailingActivationR: 1.5, trailingDistanceR: 0.5 },
    selectable: true,
  },
  {
    id: "wider-trailing",
    parameters: { breakEvenActivationR: 0.5, trailingActivationR: 1.5, trailingDistanceR: 0.75 },
    selectable: true,
  },
  {
    id: "tighter-trailing",
    parameters: { breakEvenActivationR: 0.5, trailingActivationR: 1, trailingDistanceR: 0.35 },
    selectable: true,
  },
  { id: "strategy-only-control", parameters: null, selectable: false },
];
export type StudyWindow = { from: number; to: number };
export function protectionStudyWindows(times: number[], warmup: number) {
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  if (
    !Number.isInteger(warmup) ||
    warmup < 1 ||
    sorted.length < warmup + 15 ||
    sorted.some((t) => !Number.isFinite(t))
  )
    throw new Error("Insufficient chronological study history");
  const interval = sorted[1]! - sorted[0]!;
  if (interval <= 0 || sorted.some((t, i) => i > 0 && t - sorted[i - 1]! !== interval))
    throw new Error("Study history is not continuous");
  const start = sorted[warmup]!,
    end = sorted.at(-1)! + interval,
    count = sorted.length - warmup;
  const boundary = (fraction: number) => sorted[warmup + Math.floor(count * fraction)] ?? end;
  const trainEnd = boundary(0.6),
    validationEnd = boundary(0.8);
  const folds = Array.from({ length: 3 }, (_, i) => ({
    training: { from: start, to: boundary(0.4 + i * (0.4 / 3)) },
    test: {
      from: boundary(0.4 + i * (0.4 / 3)),
      to: i === 2 ? validationEnd : boundary(0.4 + (i + 1) * (0.4 / 3)),
    },
  }));
  return {
    interval,
    training: { from: start, to: trainEnd },
    validation: { from: trainEnd, to: validationEnd },
    holdout: { from: validationEnd, to: end },
    folds,
  };
}
export function summarizeProtectionTrades(
  trades: ExecutionSettlement[],
  initialCapital: number,
  maxDrawdownPercent: number,
) {
  const sum = (f: (t: ExecutionSettlement) => number) => trades.reduce((n, t) => n + f(t), 0);
  return {
    trades: trades.length,
    netPnl: sum((t) => t.netPnl),
    fees: sum((t) => t.fees),
    funding: sum((t) => t.funding ?? 0),
    slippageAlreadyInPrices: sum((t) => t.slippage),
    maxDrawdownPercent,
    returnPercent: (sum((t) => t.netPnl) / initialCapital) * 100,
    winRatePercent: trades.length
      ? (trades.filter((t) => t.netPnl > 0).length / trades.length) * 100
      : null,
    boundaryExits: trades.filter((t) => t.exitReason === "end-of-data").length,
    exitReasons: trades.reduce<Record<string, number>>((r, t) => {
      r[t.exitReason] = (r[t.exitReason] ?? 0) + 1;
      return r;
    }, {}),
  };
}
export type ProtectionStudyScore = ReturnType<typeof summarizeProtectionTrades>;
export function chooseProtectionCandidate(
  results: Array<{ id: string; score: ProtectionStudyScore }>,
) {
  const current = results.find((r) => r.id === "current");
  if (!current) throw new Error("Current protection comparator is missing");
  if (current.score.trades < protectionStudyProtocol.minimumTrades.training) return "current";
  const eligible = results.filter(
    (r) =>
      protectionStudyCandidates.find((c) => c.id === r.id)?.selectable &&
      r.score.trades >= protectionStudyProtocol.minimumTrades.training &&
      r.score.netPnl > current.score.netPnl &&
      r.score.maxDrawdownPercent <= current.score.maxDrawdownPercent,
  );
  eligible.sort((a, b) => b.score.netPnl - a.score.netPnl || a.id.localeCompare(b.id));
  return eligible[0]?.id ?? "current";
}
export function comparePairedProtectionExits(
  baseline: ExecutionSettlement[],
  candidate: ExecutionSettlement[],
) {
  const key = (t: ExecutionSettlement) => JSON.stringify([t.symbol, t.side, t.openedAt]);
  const original = new Map(baseline.map((t) => [key(t), t]));
  let paired = 0,
    premature = 0,
    improved = 0;
  for (const trade of candidate) {
    const base = original.get(key(trade));
    if (!base) continue;
    paired++;
    if (
      Date.parse(trade.closedAt) < Date.parse(base.closedAt) &&
      trade.netPnl / trade.quantity < base.netPnl / base.quantity
    )
      premature++;
    if (trade.netPnl > base.netPnl) improved++;
  }
  return {
    paired,
    candidateTrades: candidate.length,
    coverage: candidate.length ? paired / candidate.length : 0,
    premature,
    prematureRatePercent: paired ? (premature / paired) * 100 : null,
    improved,
    definition: "same-entry-earlier-exit-lower-net-per-unit-than-current@1",
  };
}
export function runProtectionStudy(
  input: Omit<PolicySimulationInput, "entryFrom" | "entryTo" | "indicatorHistory">,
) {
  const original = readExecutionPolicy(input.executionPolicy),
    config = original.strategy;
  if (
    !original.settings.profitProtection ||
    ["breakEvenActivationR", "trailingActivationR", "trailingDistanceR"].some(
      (k) =>
        original.settings.profitProtection![k as keyof ProtectionParameters] !==
        protectionStudyCandidates[0]!.parameters![k as keyof ProtectionParameters],
    )
  )
    throw new Error("Study requires the declared current protection parameters");
  const history = new Map<string, ReturnType<typeof enrichExecutionCandles>>();
  for (const symbol of new Set(input.candles.map((c) => c.symbol))) {
    const series = input.candles
      .filter((c) => c.symbol === symbol)
      .sort((a, b) => +a.openTime - +b.openTime);
    history.set(symbol, enrichExecutionCandles(series, config));
  }
  const first = history.values().next().value;
  if (!first) throw new Error("Study history is empty");
  const times = first.map((c) => +c.openTime),
    warmup = minimumExecutionCandleCount(config);
  for (const series of history.values())
    if (series.length !== times.length || series.some((c, i) => +c.openTime !== times[i]))
      throw new Error("Study symbols have incompatible coverage");
  const windows = protectionStudyWindows(times, warmup);
  const cache = new Map<string, ReturnType<typeof simulate>>();
  function simulate(id: string, window: StudyWindow) {
    const candidate = protectionStudyCandidates.find((c) => c.id === id)!;
    const policy: ExecutionPolicySnapshot = {
      ...original,
      settings: {
        ...original.settings,
        profitProtection: candidate.parameters
          ? { ...candidate.parameters, enabledAt: new Date(window.from).toISOString() }
          : null,
      },
    };
    const candles: ExecutionCandle[] = input.candles.filter(
      (c) => +c.openTime >= window.from - windows.interval * warmup && +c.openTime < window.to,
    );
    const result = runExecutionPolicySimulation({
      ...input,
      candles,
      executionPolicy: policy,
      indicatorHistory: history,
      entryFrom: window.from,
      entryTo: window.to - windows.interval,
    });
    return {
      policy,
      trades: result.trades,
      score: summarizeProtectionTrades(
        result.trades,
        input.initialCapital,
        result.maxDrawdownPercent,
      ),
    };
  }
  function run(id: string, window: StudyWindow) {
    const key = `${id}:${window.from}:${window.to}`;
    if (!cache.has(key)) cache.set(key, simulate(id, window));
    return cache.get(key)!;
  }
  const training = protectionStudyCandidates.map((c) => ({
    id: c.id,
    ...run(c.id, windows.training),
  }));
  const selected = chooseProtectionCandidate(training);
  function evaluate(id: string, window: StudyWindow) {
    const current = run("current", window),
      candidate = run(id, window);
    return {
      window,
      selected: id,
      current: current.score,
      candidate: candidate.score,
      netImprovement: candidate.score.netPnl - current.score.netPnl,
      drawdownIncreasePp: candidate.score.maxDrawdownPercent - current.score.maxDrawdownPercent,
      pairing: comparePairedProtectionExits(current.trades, candidate.trades),
    };
  }
  const validation = evaluate(selected, windows.validation);
  // The final candidate is locked before inspecting holdout results; no runner-up substitution.
  const holdout = evaluate(selected, windows.holdout);
  const walkForward = windows.folds.map((fold) => {
    const scores = protectionStudyCandidates
      .filter((c) => c.selectable)
      .map((c) => ({ id: c.id, score: run(c.id, fold.training).score }));
    return {
      trainingWindow: fold.training,
      ...evaluate(chooseProtectionCandidate(scores), fold.test),
    };
  });
  const problems: string[] = [];
  if (selected === "current") problems.push("NO_TRAINING_CHANGE_SELECTED");
  const minimum = protectionStudyProtocol.minimumTrades;
  const enough = (pair: ReturnType<typeof evaluate>, count: number) =>
    pair.current.trades >= count && pair.candidate.trades >= count;
  if (
    training.find((r) => r.id === selected)!.score.trades < minimum.training ||
    !enough(validation, minimum.validation) ||
    !enough(holdout, minimum.holdout) ||
    walkForward.some((f) => !enough(f, minimum.walkForwardTest))
  )
    problems.push("INSUFFICIENT_TEMPORAL_SAMPLE");
  for (const [name, pair] of [
    ["VALIDATION", validation],
    ["HOLDOUT", holdout],
  ] as const) {
    if (
      (pair.netImprovement / input.initialCapital) * 100 <
      protectionStudyProtocol.minimumImprovementCapitalPercent
    )
      problems.push(`${name}_NET_IMPROVEMENT_TOO_SMALL`);
    if (pair.candidate.netPnl <= 0) problems.push(`${name}_CANDIDATE_NOT_PROFITABLE`);
    if (pair.drawdownIncreasePp > 0) problems.push(`${name}_DRAWDOWN_WORSE`);
    if (pair.pairing.coverage < protectionStudyProtocol.minimumPairedCoverage)
      problems.push(`${name}_PAIRED_COVERAGE_LOW`);
    if (
      (pair.pairing.prematureRatePercent ?? 0) >
      protectionStudyProtocol.maximumPrematureExitIncreasePp
    )
      problems.push(`${name}_PREMATURE_EXITS_HIGH`);
  }
  if (
    walkForward.filter((f) => f.netImprovement > 0 && f.drawdownIncreasePp <= 0).length <
    protectionStudyProtocol.minimumPositiveFolds
  )
    problems.push("WALK_FORWARD_UNSTABLE");
  return {
    protocol: protectionStudyProtocol,
    originalPolicy: original,
    windows,
    selected,
    training: training.map(({ id, score, policy }) => ({ id, score, policy })),
    validation,
    holdout,
    walkForward,
    selectedPolicy: run(selected, windows.holdout).policy,
    holdoutTrades: run(selected, windows.holdout).trades,
    baselineHoldoutTrades: run("current", windows.holdout).trades,
    statisticalProblems: problems,
    outcome: problems.length ? "retain-current" : "candidate-for-independent-validation",
    applied: false,
    limitations: [
      "OHLC_ADVERSE_FIRST_SCENARIO",
      "FIXED_HISTORICAL_INSTRUMENT_SCENARIO",
      "L1_FILL_CAPACITY_NOT_OBSERVED",
      "FLAT_WINDOW_BOUNDARIES",
      "STRATEGY_SET_PREVIOUSLY_SELECTED",
      "PAIRED_EXIT_METRIC_IS_COUNTERFACTUAL_NOT_AN_EXECUTABLE_PROFIT_GUARANTEE",
    ],
  };
}
