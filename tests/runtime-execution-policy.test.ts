import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  assessExecutionAccount,
  executionAccountEntryFailure,
  defaultExecutionAccountSafety,
  readExecutionRiskConfig,
  executionTradingDay,
} from "../packages/application/src/execution-account";
import {
  makeExecutionPolicy,
  readExecutionPolicy,
  compareExecutionPolicies,
  type ExecutionPolicySettings,
} from "../packages/application/src/execution-policy";
import { runExecutionPolicySimulation } from "../packages/application/src/execution-policy-simulation";
import { defaultLiquidityExitPolicy } from "../packages/application/src/execution-exit-policy";
import { defaultEntryLiquidityPolicy } from "../packages/application/src/execution-entry-liquidity";
import {
  enabledFundingPolicy,
  type ExecutionFundingDataset,
} from "../packages/application/src/execution-funding";
import {
  runValidationEngine,
  runRuntimeReplay,
  openExecutionPositionAtQuote,
  evaluateExecutionPriceExit,
} from "../packages/application/src/index";
import { advanceExecutionQuoteProtection } from "../packages/application/src/execution-position-policy";
import {
  processRuntimePriceEvents,
  type RuntimePriceCheckpoint,
} from "../apps/worker/src/runtime-price-processor";
import {
  pinExecutionPolicy,
  readPinnedExecutionPolicy,
} from "../packages/persistence/src/execution-policy-repository";
const config = strategyConfigSchema.parse(fixture.config);
const candles = fixture.candles.map((c) => ({ ...c, openTime: new Date(c.openTime) }));
const instrumentRules = Object.fromEntries(
  ["BTCUSDT", "ETHUSDT"].map((symbol) => [
    symbol,
    {
      version: 1 as const,
      symbol,
      observedAt: "2026-01-01T00:00:00Z",
      tickSize: "0.01",
      qtyStep: "0.001",
      minOrderQty: "0.001",
      minNotional: "5",
      maxOrderQty: "1000000",
      maxMarketOrderQty: "1000000",
      minPrice: "0.01",
      maxPrice: "1000000",
    },
  ]),
);
const settings: ExecutionPolicySettings = {
  accountSafety: defaultExecutionAccountSafety,
  profitProtection: {
    enabledAt: "2026-01-01T00:00:00Z",
    breakEvenActivationR: 0.5,
    trailingActivationR: 1,
    trailingDistanceR: 0.5,
  },
  marketEntry: { ttlMs: 60000, maxDeviationBps: 10000 },
  entryLiquidity: defaultEntryLiquidityPolicy,
  exit: defaultLiquidityExitPolicy,
  funding: null,
};
const policy = makeExecutionPolicy(config, settings, "ohlc-adverse-first@1");
const riskBase = {
  policy: settings.accountSafety,
  config,
  now: new Date("2026-01-01T12:00:00Z"),
  realizedNetPnl: 0,
  utcCashPnl: 0,
  strategyCashPnl: 0,
  positions: [],
};
test("shared account equity charges held costs and reserves stop loss without floating winners funding losses", () => {
  const costs = readExecutionRiskConfig(config)!;
  const p = {
    symbol: "BTCUSDT",
    side: "long" as const,
    entryPrice: 100,
    quantity: 1,
    entryFee: 0.1,
    stopPrice: 98,
    trailingPrice: null,
    markPrice: 99,
    realizedPnl: -0.3,
    costs,
  };
  const risk = assessExecutionAccount({ ...riskBase, positions: [p] });
  const exitCosts = (99 * (costs.takerFeeBps + costs.slippageBps)) / 10000;
  assert.ok(Math.abs(risk.equity - (10000 - 0.3 - 1 - 0.1 - exitCosts)) < 1e-8);
  assert.ok(Math.abs(risk.dailyPnl - (-1 - 0.1 - exitCosts)) < 1e-8);
  const winning = { ...p, symbol: "ETHUSDT", markPrice: 110, realizedPnl: 0 };
  assert.ok(
    assessExecutionAccount({ ...riskBase, positions: [p, winning] }).dailyPnl < risk.dailyPnl,
  );
  assert.ok(risk.remainingStopRisk < risk.dailyLimit);
});
test("account admission shares position, exposure, direction, per-trade and stop budgets", () => {
  const risk = assessExecutionAccount(riskBase),
    candidate = {
      symbol: "BTCUSDT",
      side: "long" as const,
      entryPrice: 100,
      stopPrice: 98,
      quantity: 1,
      entryFee: 0.06,
    };
  assert.equal(executionAccountEntryFailure(risk, candidate, []), null);
  assert.equal(
    executionAccountEntryFailure({ ...risk, positions: risk.maximumPositions }, candidate, []),
    "MAX_OPEN_POSITIONS",
  );
  assert.equal(
    executionAccountEntryFailure({ ...risk, maximumExposure: 50 }, candidate, []),
    "MAX_ACCOUNT_EXPOSURE",
  );
  assert.equal(
    executionAccountEntryFailure(risk, candidate, [
      { symbol: "BTCUSDT", side: "short", quantity: 1 },
    ]),
    "PORTFOLIO_DIRECTION_CONFLICT",
  );
  assert.equal(
    executionAccountEntryFailure({ ...risk, remainingStopRisk: 0.1 }, candidate, []),
    "MAX_ACCOUNT_STOP_RISK",
  );
  assert.equal(assessExecutionAccount({ ...riskBase, utcHalted: true }).reason, "daily-loss-limit");
});
test("trading days follow local midnight and real DST boundaries", () => {
  for (const [time, tz, start] of [
    ["2026-03-08T12:00:00Z", "America/New_York", "2026-03-08T05:00:00.000Z"],
    ["2026-11-01T12:00:00Z", "America/New_York", "2026-11-01T04:00:00.000Z"],
    ["2026-01-01T18:00:00Z", "Asia/Novosibirsk", "2026-01-01T17:00:00.000Z"],
  ])
    assert.equal(executionTradingDay(new Date(time!), tz!).startsAt.toISOString(), start);
});
test("policy snapshots preserve activation and reject both payload and profile corruption", () => {
  const pinned = pinExecutionPolicy(policy);
  assert.deepEqual(readPinnedExecutionPolicy(pinned), pinned);
  assert.throws(() => readPinnedExecutionPolicy({ ...pinned, hash: "broken" }), /checksum/);
  assert.throws(() => readPinnedExecutionPolicy({ ...pinned, profileHash: "broken" }), /checksum/);
  const incomplete = structuredClone(policy);
  delete (incomplete.settings as Partial<ExecutionPolicySettings>).funding;
  assert.throws(() => readExecutionPolicy(incomplete), /Incomplete/);
  delete (incomplete.settings as Partial<ExecutionPolicySettings>).accountSafety;
  assert.throws(() => readExecutionPolicy(incomplete), /account safety/);
  const runtime = makeExecutionPolicy(config, settings, "public-trade-l1@1");
  assert.equal(compareExecutionPolicies(policy, runtime).status, "scenario-only");
  assert.equal(compareExecutionPolicies(policy, structuredClone(policy)).status, "equivalent");
  assert.equal(compareExecutionPolicies(policy, null).status, "unavailable");
  assert.equal(
    compareExecutionPolicies(
      policy,
      makeExecutionPolicy(config, { ...settings, profitProtection: null }, "ohlc-adverse-first@1"),
    ).status,
    "incompatible",
  );
});
test("new validation/replay share policy, risk, protection and dated equity", () => {
  const input = {
    config,
    candles,
    instrumentRules,
    initialCapital: 10000,
    executionPolicy: policy,
  };
  const a = runValidationEngine({ ...input, kind: "backtest", walkForward: null }),
    b = runRuntimeReplay(input);
  assert.deepEqual(a.trades, b.trades);
  assert.ok(a.trades.length > 0);
  assert.equal(a.metrics.netPnl, b.metrics.netPnl);
  assert.equal(a.metrics.equitySeries.at(-1)!.equity, b.metrics.endingEquity);
  assert.ok(a.trades.every((t) => Date.parse(t.closedAt) >= Date.parse(t.openedAt)));
  assert.throws(
    () => runRuntimeReplay({ config, candles, initialCapital: 10000, executionPolicy: policy }),
    /Missing pinned instrument/,
  );
  assert.throws(
    () => runRuntimeReplay({ ...input, instrumentRules: { BTCUSDT: instrumentRules.ETHUSDT! } }),
    /Missing pinned instrument/,
  );
  assert.throws(
    () =>
      runValidationEngine({
        ...input,
        config: { ...config, costs: { ...config.costs, takerFeeBps: 99 } },
        kind: "backtest",
        walkForward: null,
      }),
    /policy\/config/,
  );
});
test("same-bar future profit cannot free capital or slots for another opening", () => {
  const one = { ...config, risk: { ...config.risk, maxOpenPositions: 1 } },
    p = makeExecutionPolicy(one, settings, "ohlc-adverse-first@1");
  const result = runExecutionPolicySimulation({
    instrumentRules,
    executionPolicy: p,
    candles: [...candles, ...candles.map((c) => ({ ...c, symbol: "ETHUSDT" }))],
    initialCapital: 10000,
  });
  assert.ok(result.trades.length > 0);
  assert.ok(result.admissions.some((a) => a.reason === "MAX_OPEN_POSITIONS"));
  const times = new Map<string, number>();
  for (const a of result.admissions.filter((a) => a.reason === "ENTRY_ALLOWED"))
    times.set(a.at, (times.get(a.at) ?? 0) + 1);
  assert.ok([...times.values()].every((n) => n === 1));
});
test("walk-forward equity does not rebase the pinned daily loss budget", () => {
  const c = { ...config, risk: { ...config.risk, maxOpenPositions: 1, riskPerTradePercent: 10 } };
  const executionPolicy = makeExecutionPolicy(
    c,
    { ...settings, accountSafety: { ...settings.accountSafety, maxDailyLossPercent: 0.5 } },
    "ohlc-adverse-first@1",
  );
  const firstQuantity = (initialCapital: number) =>
    runExecutionPolicySimulation({
      executionPolicy,
      candles,
      instrumentRules,
      initialCapital,
    }).admissions.find((a) => a.reason === "ENTRY_ALLOWED")!.quantity;
  assert.ok(firstQuantity(10000)! > 0);
  assert.equal(firstQuantity(20000), firstQuantity(10000));
});
test("funding is charged on actual simulation exposure and never twice at close", () => {
  const p = makeExecutionPolicy(
    config,
    { ...settings, funding: enabledFundingPolicy },
    "ohlc-adverse-first@1",
  );
  const funding: ExecutionFundingDataset = {
    version: 1,
    policy: enabledFundingPolicy,
    symbols: ["BTCUSDT"],
    startsAt: candles[0]!.openTime.toISOString(),
    throughAt: new Date(+candles.at(-1)!.openTime + 900000).toISOString(),
    coverage: "complete",
    events: candles.map((c) => ({
      symbol: c.symbol,
      settledAt: c.openTime.toISOString(),
      rate: "0.0002",
      markPrice: String(c.open),
      markInterval: "1",
    })),
  };
  const result = runRuntimeReplay({
    instrumentRules,
    config,
    candles,
    initialCapital: 10000,
    executionPolicy: p,
    funding,
  });
  assert.ok(result.trades.some((t) => (t.funding ?? 0) !== 0));
  assert.ok(Math.abs(result.metrics.endingEquity - (10000 + result.metrics.netPnl)) < 1e-8);
  assert.throws(
    () =>
      runRuntimeReplay({
        config,
        candles,
        instrumentRules,
        initialCapital: 10000,
        executionPolicy: p,
      }),
    /Funding policy/,
  );
});
test("runtime quote processing and the shared protection step agree on exact price events", async () => {
  const openedAt = new Date("2026-01-01T00:00:00Z"),
    c = { ...config, exit: { ...config.exit, breakEvenActivationR: 0, trailingStopPercent: 0 } };
  const position = openExecutionPositionAtQuote(
    { side: "long", signalPrice: 100 },
    { symbol: "BTCUSDT", price: 100, observedAt: openedAt },
    "neutral",
    10000,
    10000,
    c,
  )!;
  const events = [100, 101, 102, 101].map((price, i) => ({
    id: BigInt(i + 1),
    symbol: "BTCUSDT",
    price,
    observedAt: new Date(+openedAt + i * 1000),
    receivedAt: new Date(+openedAt + i * 1000),
    streamId: "one",
  }));
  let p = position,
    state = null as Parameters<typeof advanceExecutionQuoteProtection>[4],
    exit = null as ReturnType<typeof evaluateExecutionPriceExit>;
  for (const quote of events) {
    exit = evaluateExecutionPriceExit(p, quote, c);
    if (exit) break;
    const step = advanceExecutionQuoteProtection(p, quote, c, settings.profitProtection, state);
    p = step.position;
    state = step.state;
  }
  let final: RuntimePriceCheckpoint | null = null;
  await processRuntimePriceEvents({
    position,
    config: c,
    profitProtection: { policy: settings.profitProtection, state: null },
    through: openedAt,
    streamId: "one",
    events,
    recover: async () => {
      throw new Error("unexpected recovery");
    },
    checkpoint: async (s) => {
      final = s;
      return true;
    },
  });
  assert.ok(final);
  assert.deepEqual((final as RuntimePriceCheckpoint).position, p);
  assert.deepEqual((final as RuntimePriceCheckpoint).settlement, exit);
  assert.deepEqual((final as RuntimePriceCheckpoint).profitProtectionState, state);
});

test("a signal cannot survive a missing candle past its pinned entry deadline", () => {
  const baseline = runExecutionPolicySimulation({
    instrumentRules,
    executionPolicy: policy,
    candles,
    initialCapital: 10000,
  });
  const at = Date.parse(baseline.admissions.find((a) => a.reason === "ENTRY_ALLOWED")!.at);
  const result = runExecutionPolicySimulation({
    instrumentRules,
    executionPolicy: policy,
    candles: candles.filter((c) => +c.openTime !== at),
    initialCapital: 10000,
  });
  assert.ok(
    result.admissions.some(
      (a) => Date.parse(a.at) === at + 900000 && a.reason === "ENTRY_SIGNAL_EXPIRED",
    ),
  );
});
test("a funding loss latches UTC safety for the day and resets on a later UTC day", () => {
  const extended = [
    ...candles,
    ...candles.map((c) => ({ ...c, openTime: new Date(+c.openTime + 2 * 86400000) })),
  ];
  const limited = makeExecutionPolicy(
    config,
    {
      ...settings,
      accountSafety: { ...settings.accountSafety, maxDailyLossPercent: 0.5 },
      funding: enabledFundingPolicy,
    },
    "ohlc-adverse-first@1",
  );
  const first = runExecutionPolicySimulation({
    instrumentRules,
    executionPolicy: policy,
    candles,
    initialCapital: 10000,
  }).admissions.find((a) => a.reason === "ENTRY_ALLOWED")!;
  const settledAt = new Date(Date.parse(first.at) + 900000).toISOString();
  const funding: ExecutionFundingDataset = {
    version: 1,
    policy: enabledFundingPolicy,
    symbols: ["BTCUSDT"],
    startsAt: extended[0]!.openTime.toISOString(),
    throughAt: new Date(+extended.at(-1)!.openTime + 900000).toISOString(),
    coverage: "complete",
    events: [{ symbol: "BTCUSDT", settledAt, rate: "1", markPrice: "100", markInterval: "1" }],
  };
  const result = runExecutionPolicySimulation({
    instrumentRules,
    executionPolicy: limited,
    candles: extended,
    initialCapital: 10000,
    funding,
  });
  assert.ok(result.trades.some((t) => t.exitReason === "daily-loss-limit"));
  assert.ok(result.utcHaltedDays.includes(settledAt.slice(0, 10)));
  assert.ok(
    result.admissions.some(
      (a) => a.reason === "ENTRY_ALLOWED" && a.at.slice(0, 10) > settledAt.slice(0, 10),
    ),
  );
});
