import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import { createTradeExcursions } from "../packages/application/src/trade-excursions";
import {
  protectionStudyWindows,
  chooseProtectionCandidate,
  comparePairedProtectionExits,
  summarizeProtectionTrades,
  runProtectionStudy,
  protectionStudyProtocol,
} from "../packages/application/src/protection-study";
import { makeExecutionPolicy } from "../packages/application/src/execution-policy";
import { defaultExecutionAccountSafety } from "../packages/application/src/execution-account";
import { defaultEntryLiquidityPolicy } from "../packages/application/src/execution-entry-liquidity";
import { defaultExecutionExitPolicy } from "../packages/application/src/execution-exit-policy";
import type { ExecutionSettlement } from "../packages/application/src/execution-engine";
import { researchReadOnlyUrl } from "../scripts/lib/research-readonly";
import { createPrismaClient } from "../packages/persistence/src/client";
const at = Date.parse("2026-01-01T00:00:00Z");
for (const side of ["long", "short"] as const) {
  test(`${side}: observed excursions retain extrema, first peak time, giveback and known duration`, () => {
    const observer = createTradeExcursions({
      side,
      entryPrice: 100,
      initialRiskDistance: 2,
      openedAt: new Date(at),
      throughAt: new Date(at + 1000),
    });
    const direction = side === "long" ? 1 : -1;
    for (const [index, move] of [-1, 4, 4, 1, -3].entries())
      observer.observe({ price: 100 + direction * move, observedAt: new Date(at + index * 100) });
    observer.observe({ price: 100 + direction * 20, observedAt: new Date(at + 1001) });
    const m = observer.finish(100 - direction * 2, true, []);
    assert.equal(m.quality, "complete-observed-path");
    assert.equal(m.mfeR, 2);
    assert.equal(m.maeR, 1.5);
    assert.equal(m.maxDrawdownFromPeakR, 3.5);
    assert.equal(m.givebackAtExitR, 3);
    assert.equal(m.peakAt, new Date(at + 100).toISOString());
    assert.equal(m.holdingMs, 1000);
    assert.equal(m.observations, 5);
  });
}
test("missing prefix is a lower bound; missing prices stay null and source-time disorder is explicit", () => {
  const basis = {
    side: "long" as const,
    entryPrice: 100,
    initialRiskDistance: 2,
    openedAt: new Date(at),
    throughAt: new Date(at + 1000),
  };
  const empty = createTradeExcursions(basis).finish(100, false, ["MISSING_ENTRY_PREFIX"]);
  assert.equal(empty.quality, "unavailable");
  assert.equal(empty.mfeR, null);
  const partial = createTradeExcursions(basis);
  partial.observe({ price: 101, observedAt: new Date(at + 500) });
  partial.observe({ price: 102, observedAt: new Date(at + 100) });
  const value = partial.finish(99, true, []);
  assert.equal(value.quality, "observed-lower-bound");
  assert.ok(value.issues.includes("SOURCE_TIME_OUT_OF_ORDER"));
  assert.equal(partial.finish(99, false, ["MISSING_ENTRY_PREFIX"]).quality, "observed-lower-bound");
  assert.throws(() => createTradeExcursions({ ...basis, initialRiskDistance: 0 }), /basis/);
});
test("chronological holdout is separate from all walk-forward selection and test windows", () => {
  const times = Array.from({ length: 300 }, (_, i) => at + i * 900000);
  const w = protectionStudyWindows(times, 20);
  assert.equal(w.training.to, w.validation.from);
  assert.equal(w.validation.to, w.holdout.from);
  assert.equal(w.folds.length, 3);
  for (const fold of w.folds) {
    assert.equal(fold.training.to, fold.test.from);
    assert.ok(fold.test.to <= w.holdout.from);
  }
  assert.equal(w.folds.at(-1)!.test.to, w.holdout.from);
  assert.throws(
    () =>
      protectionStudyWindows(
        times.filter((_, i) => i !== 50),
        20,
      ),
    /continuous/,
  );
  assert.throws(() => protectionStudyWindows(times.slice(0, 25), 20), /Insufficient/);
});
function trade(overrides: Partial<ExecutionSettlement> = {}): ExecutionSettlement {
  return {
    symbol: "BTCUSDT",
    side: "long",
    openedAt: new Date(at).toISOString(),
    closedAt: new Date(at + 1000).toISOString(),
    entryRegime: "neutral",
    entrySession: "asia",
    entryPrice: 100,
    exitPrice: 102,
    quantity: 1,
    grossPnl: 2,
    netPnl: 1.8,
    fees: 0.2,
    slippage: 0.1,
    funding: 0,
    exitReason: "trailing-stop",
    ...overrides,
  };
}
function score(netPnl = 100, n = 50, drawdown = 5) {
  return summarizeProtectionTrades(
    Array.from({ length: n }, () => trade({ netPnl: netPnl / n })),
    10000,
    drawdown,
  );
}
test("training selection excludes under-sampled, higher-drawdown and diagnostic-only controls", () => {
  const current = { id: "current", score: score() };
  assert.equal(
    chooseProtectionCandidate([
      current,
      { id: "later-trailing", score: score(200, 50, 6) },
      { id: "strategy-only-control", score: score(1000) },
      { id: "wider-trailing", score: score(200, 39) },
    ]),
    "current",
  );
  assert.equal(
    chooseProtectionCandidate([
      current,
      { id: "later-trailing", score: score(200) },
      { id: "wider-trailing", score: score(190) },
    ]),
    "later-trailing",
  );
  assert.equal(
    chooseProtectionCandidate([
      { id: "current", score: score(100, 39) },
      { id: "later-trailing", score: score(200) },
    ]),
    "current",
  );
});
test("paired premature-exit comparison normalizes quantity and exposes unmatched entries", () => {
  const baseline = [trade({ quantity: 10, netPnl: 20 })];
  const comparison = comparePairedProtectionExits(baseline, [
    trade({ quantity: 1, netPnl: 3, closedAt: new Date(at + 500).toISOString() }),
    trade({ symbol: "ETHUSDT" }),
  ]);
  assert.equal(comparison.premature, 0);
  assert.equal(comparison.coverage, 0.5);
  assert.equal(
    comparePairedProtectionExits(baseline, [
      trade({ netPnl: 1, closedAt: new Date(at + 500).toISOString() }),
    ]).premature,
    1,
  );
  assert.equal(comparePairedProtectionExits(baseline, []).prematureRatePercent, null);
});
test("summary retains net funding/fee accounting and never subtracts embedded slippage twice", () => {
  const m = summarizeProtectionTrades(
    [trade({ netPnl: 1, funding: 0.5, slippage: 0.2 })],
    10000,
    3,
  );
  assert.equal(m.netPnl, 1);
  assert.equal(m.funding, 0.5);
  assert.equal(m.slippageAlreadyInPrices, 0.2);
});
const config = strategyConfigSchema.parse(fixture.config);
const candles = fixture.candles.map((c) => ({ ...c, openTime: new Date(c.openTime) }));
const rules = {
  BTCUSDT: {
    version: 1 as const,
    symbol: "BTCUSDT",
    observedAt: new Date(at).toISOString(),
    tickSize: "0.01",
    qtyStep: "0.001",
    minOrderQty: "0.001",
    minNotional: "5",
    maxOrderQty: "100000",
    maxMarketOrderQty: "100000",
    minPrice: "0.01",
    maxPrice: "1000000",
  },
};
const policy = makeExecutionPolicy(
  config,
  {
    accountSafety: defaultExecutionAccountSafety,
    profitProtection: {
      enabledAt: "2026-10-13T00:00:00Z",
      breakEvenActivationR: 0.5,
      trailingActivationR: 1,
      trailingDistanceR: 0.5,
    },
    marketEntry: { ttlMs: 60000, maxDeviationBps: 10000 },
    entryLiquidity: defaultEntryLiquidityPolicy,
    exit: defaultExecutionExitPolicy,
    funding: null,
  },
  "ohlc-adverse-first@1",
);
test("historical scenario activates only at its own window, while saved policies remain unchanged", () => {
  const original = structuredClone(policy);
  const study = runProtectionStudy({
    executionPolicy: policy,
    candles,
    initialCapital: 10000,
    instrumentRules: rules,
  });
  assert.deepEqual(policy, original);
  assert.equal(
    study.training[0]!.policy.settings.profitProtection!.enabledAt,
    new Date(study.windows.training.from).toISOString(),
  );
  assert.equal(
    study.selectedPolicy.settings.profitProtection!.enabledAt,
    new Date(study.windows.holdout.from).toISOString(),
  );
  assert.ok(study.statisticalProblems.includes("INSUFFICIENT_TEMPORAL_SAMPLE"));
  assert.equal(study.applied, false);
  assert.equal(
    study.training.find((c) => c.id === "strategy-only-control")!.policy.settings.profitProtection,
    null,
  );
});
test("future holdout prices cannot change training scores or walk-forward decisions", () => {
  const input = { executionPolicy: policy, candles, initialCapital: 10000, instrumentRules: rules };
  const first = runProtectionStudy(input);
  const changed = candles.map((c) =>
    +c.openTime >= first.windows.holdout.from
      ? { ...c, open: c.open * 2, high: c.high * 2, low: c.low * 2, close: c.close * 2 }
      : c,
  );
  const second = runProtectionStudy({ ...input, candles: changed });
  assert.deepEqual(second.training, first.training);
  assert.deepEqual(second.walkForward, first.walkForward);
  assert.equal(second.selected, first.selected);
});
test("study rejects incomplete symbol coverage and a mismatched baseline template", () => {
  assert.throws(
    () =>
      runProtectionStudy({
        executionPolicy: policy,
        candles: [...candles, ...candles.slice(1).map((c) => ({ ...c, symbol: "ETHUSDT" }))],
        initialCapital: 10000,
        instrumentRules: rules,
      }),
    /coverage/,
  );
  const altered = structuredClone(policy);
  altered.settings.profitProtection!.trailingDistanceR = 0.4;
  assert.throws(
    () =>
      runProtectionStudy({
        executionPolicy: altered,
        candles,
        initialCapital: 10000,
        instrumentRules: rules,
      }),
    /declared current/,
  );
  assert.equal(protectionStudyProtocol.minimumForwardCandidateTraces, 30);
});
test("research URL enforces read-only without dropping connection or existing options", () => {
  const u = new URL(
    researchReadOnlyUrl(
      "postgresql://local:password@localhost:15432/db?options=-c%20statement_timeout=3000",
    ),
  );
  assert.equal(u.pathname, "/db");
  assert.equal(u.port, "15432");
  assert.match(
    u.searchParams.get("options")!,
    /statement_timeout=3000.*default_transaction_read_only=on$/,
  );
});
const databaseUrl = process.env.RUNTIME_TEST_DATABASE_URL;
if (databaseUrl && !/^\/cryptoanal_runtime_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname))
  throw new Error("Use a dedicated research test database");
test(
  "research database session rejects writes at PostgreSQL level",
  { skip: !databaseUrl },
  async () => {
    const p = createPrismaClient(researchReadOnlyUrl(databaseUrl!), {
      maxConnections: 1,
      applicationName: "research-readonly-test",
    });
    try {
      const [r] = await p.$queryRaw<
        Array<{ default_transaction_read_only: string }>
      >`SHOW default_transaction_read_only`;
      assert.equal(r?.default_transaction_read_only, "on");
      await assert.rejects(
        p.$executeRaw`UPDATE "Trade" SET "netPnl"="netPnl" WHERE false`,
        /read-only/,
      );
    } finally {
      await p.$disconnect();
    }
  },
);
