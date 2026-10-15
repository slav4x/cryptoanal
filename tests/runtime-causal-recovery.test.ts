import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  defaultLiquidityExitPolicy,
  openExecutionPositionAtQuote,
  advanceExecutionQuoteProtection,
} from "../packages/application/src/index";
import {
  recoverCausalRuntimeGap,
  selectRecoveryTrades,
  type CausalRecoveryInput,
} from "../apps/worker/src/causal-recovery";
import {
  processRuntimePriceEvents,
  type RuntimePriceCheckpoint,
} from "../apps/worker/src/runtime-price-processor";
const at = new Date("2026-01-01T00:00:00Z");
const config = strategyConfigSchema.parse({
  ...fixture.config,
  exit: {
    ...fixture.config.exit,
    stopLossPercent: 2,
    takeProfitPercent: 10,
    trailingStopPercent: 0,
    breakEvenActivationR: 0,
  },
});
const policy = {
  enabledAt: at.toISOString(),
  breakEvenActivationR: 0.5,
  trailingActivationR: 1,
  trailingDistanceR: 0.5,
};
function input(side: "long" | "short" = "long"): CausalRecoveryInput {
  const position = openExecutionPositionAtQuote(
    { side, signalPrice: 100 },
    { symbol: "BTCUSDT", price: 100, observedAt: at },
    "neutral",
    10000,
    10000,
    config,
  )!;
  return {
    position: { ...position, exitPolicy: defaultLiquidityExitPolicy },
    since: at,
    quote: {
      symbol: "BTCUSDT",
      source: "LastPrice",
      price: 100,
      observedAt: new Date(+at + 10000),
    },
    config,
    strictMinutes: true,
    protection: { policy, state: null },
    minutes: [],
    anchorTradeId: "anchor",
    quoteTradeId: "quote",
    recent: {
      sampledAt: new Date(+at + 11000).toISOString(),
      trades: [
        { symbol: "BTCUSDT", tradeId: "anchor", price: "100", observedAt: at.toISOString() },
        {
          symbol: "BTCUSDT",
          tradeId: "quote",
          price: "100",
          observedAt: new Date(+at + 10000).toISOString(),
        },
      ],
    },
  };
}
function trade(price: number, offset: number, id = `t${offset}`) {
  return {
    symbol: "BTCUSDT",
    tradeId: id,
    price: String(price),
    observedAt: new Date(+at + offset).toISOString(),
  };
}
test("recent history requires both matching boundary trades and rejects truncated or contradictory bounds", () => {
  const i = input();
  assert.deepEqual(selectRecoveryTrades(i), []);
  assert.equal(selectRecoveryTrades({ ...i, anchorPrice: "101" }), null);
  for (const recent of [
    { ...i.recent!, trades: i.recent!.trades.slice(1) },
    { ...i.recent!, trades: [...i.recent!.trades, trade(99, 10000, "end-tie")] },
    { ...i.recent!, trades: [...i.recent!.trades, i.recent!.trades[0]!] },
  ])
    assert.equal(selectRecoveryTrades({ ...i, recent }), null);
  assert.equal(selectRecoveryTrades({ ...i, quoteTradeId: "missing" }), null);
});
for (const side of ["long", "short"] as const) {
  test(`${side}: complete public price history restores protection exactly and does not use later trades`, () => {
    const i = input(side),
      best = side === "long" ? 102 : 98;
    i.quote.price = best;
    i.recent!.trades[1]!.price = String(best);
    i.recent!.trades.push(trade(best, 5000), trade(side === "long" ? 120 : 80, 12000, "future"));
    const r = recoverCausalRuntimeGap(i),
      step = advanceExecutionQuoteProtection(
        i.position,
        { source: "LastPrice", symbol: "BTCUSDT", price: best, observedAt: new Date(+at + 5000) },
        i.config,
        policy,
        null,
      );
    assert.equal(r.settlement, null);
    assert.deepEqual(r.position, step.position);
    assert.deepEqual(r.profitProtectionState, step.state);
    assert.equal(r.evidence.source, "recent-public-trades");
  });
  test(`${side}: a historical touch initiates recovery at the known quote without a fictional old fill`, () => {
    const i = input(side);
    i.recent!.trades.push(trade(side === "long" ? 97 : 103, 5000));
    const r = recoverCausalRuntimeGap(i);
    assert.equal(r.settlement?.exitReason, "recovery-exit");
    assert.equal(r.settlement?.closedAt, i.quote.observedAt.toISOString());
    assert.equal(r.evidence.ambiguity, "historical-trigger-without-fill");
  });
  test(`${side}: protection activated before a reconnect is hit after its restored trailing move`, () => {
    const i = input(side),
      best = side === "long" ? 103 : 97,
      back = side === "long" ? 100.5 : 99.5;
    i.recent!.trades.push(trade(best, 3000), trade(back, 5000));
    const r = recoverCausalRuntimeGap(i);
    assert.equal(r.settlement?.exitReason, "recovery-exit");
    assert.equal(r.profitProtectionState?.bestPrice, best);
  });
  test(`${side}: unknown ordering inside a millisecond stays ambiguous`, () => {
    const i = input(side);
    i.recent!.trades.push(
      trade(side === "long" ? 102 : 98, 3000, "best"),
      trade(100, 3000, "adverse"),
    );
    const r = recoverCausalRuntimeGap(i);
    assert.equal(r.evidence.ambiguity, "same-timestamp-order");
    assert.equal(r.position.stopPrice, i.position.stopPrice);
    assert.equal(r.profitProtectionState, null);
  });
}
test("unobserved current-minute data never determines the new recovery result", () => {
  const i = input();
  delete i.recent;
  i.minutes = [
    { symbol: "BTCUSDT", openTime: at, open: 100, high: 120, low: 80, close: 100, turnover: 1 },
  ];
  const a = recoverCausalRuntimeGap(i);
  const b = recoverCausalRuntimeGap({ ...i, minutes: [] });
  assert.deepEqual(a, b);
  assert.equal(a.evidence.ambiguity, "unobserved-partial-minute");
  assert.equal(a.position.stopPrice, i.position.stopPrice);
});
test("zero elapsed milliseconds do not prove an unconfirmed stream is gap-free", () => {
  const i = input();
  i.quote.observedAt = at;
  i.recent!.trades[1]!.observedAt = at.toISOString();
  assert.equal(recoverCausalRuntimeGap(i).settlement, null);
  delete i.recent;
  assert.equal(recoverCausalRuntimeGap(i).evidence.ambiguity, "same-timestamp-order");
  assert.equal(recoverCausalRuntimeGap({ ...i, strictMinutes: false }).settlement, null);
});
test("a complete minute restores additional protection only when every possible ordering is safe", () => {
  const i = input();
  delete i.recent;
  i.quote.observedAt = new Date(+at + 60000);
  i.position.openedAt = new Date(+at - 60000);
  i.position.entryPrice = 98;
  i.position.stopPrice = 96;
  i.position.bestPrice = 98;
  i.position.takePrice = 110;
  i.minutes = [
    {
      symbol: "BTCUSDT",
      openTime: at,
      open: 100,
      high: 102,
      low: 101.1,
      close: 101.5,
      turnover: 1,
    },
  ];
  i.minutes[0]!.open = 101.5;
  const r = recoverCausalRuntimeGap(i);
  assert.equal(r.settlement, null);
  assert.ok(r.position.trailingPrice !== null);
  assert.equal(r.profitProtectionState?.bestPrice, 102);
  const activatedMidbar = recoverCausalRuntimeGap({
    ...i,
    protection: {
      policy: { ...policy, enabledAt: new Date(+at + 30000).toISOString() },
      state: null,
    },
  });
  assert.equal(activatedMidbar.profitProtectionState, null);
});
test("a fresh stop is processed before an unavailable history source", async () => {
  const i = input();
  let final: RuntimePriceCheckpoint | null = null;
  await processRuntimePriceEvents({
    position: i.position,
    through: at,
    streamId: "old",
    config,
    protectBeforeRecovery: true,
    events: [
      {
        id: 2n,
        symbol: "BTCUSDT",
        source: "LastPrice",
        price: 97,
        observedAt: new Date(+at + 10000),
        receivedAt: new Date(+at + 10000),
        streamId: "new",
      },
    ],
    recover: async () => {
      throw Error("must not wait for REST");
    },
    checkpoint: async (s) => {
      final = s;
      return true;
    },
  });
  assert.ok(final);
  assert.equal((final as RuntimePriceCheckpoint).settlement?.exitReason, "stop-loss");
});
test("a missing recovery interval cannot hide a later stop beyond the fetched journal batch", async () => {
  const i = input();
  let final: RuntimePriceCheckpoint | null = null;
  const event = {
    id: 2n,
    symbol: "BTCUSDT",
    source: "LastPrice" as const,
    price: 100,
    observedAt: new Date(+at + 10000),
    receivedAt: new Date(+at + 10000),
    streamId: "new",
  };
  await processRuntimePriceEvents({
    position: i.position,
    through: at,
    streamId: "old",
    config,
    protectBeforeRecovery: true,
    events: [event],
    latestProtectiveEvent: { ...event, id: 5000n, price: 97, observedAt: new Date(+at + 20000) },
    recover: async () => {
      throw Error("unavailable history must not block a known stop");
    },
    checkpoint: async (s) => {
      final = s;
      return true;
    },
  });
  assert.ok(final);
  assert.equal((final as RuntimePriceCheckpoint).event.id, 5000n);
  assert.equal((final as RuntimePriceCheckpoint).historyIncomplete, true);
  assert.equal((final as RuntimePriceCheckpoint).recovery?.ambiguity, "unreconstructed-gap");
});
