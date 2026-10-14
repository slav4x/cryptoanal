import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  enrichExecutionCandles,
  executionEntryCandleRange,
  evaluateExecutionExit,
  updateExecutionTrailing,
  getExecutionSignal,
  runValidationEngine,
  runRuntimeReplay,
  type ExecutionPosition,
} from "../packages/application/src/index";
const config = strategyConfigSchema.parse({
  ...fixture.config,
  entry: { ...fixture.config.entry, orderType: "limit" },
  exit: {
    stopLossPercent: 3,
    takeProfitPercent: 3,
    trailingStopPercent: 1,
    trailingActivationR: 0.5,
    breakEvenActivationR: 0.5,
  },
});
const at = new Date("2026-10-14T00:00:00Z");
const seed = enrichExecutionCandles(
  fixture.candles.map((c) => ({ ...c, openTime: new Date(c.openTime) })),
  config,
).at(-1)!;
function position(side: "long" | "short"): ExecutionPosition {
  return {
    symbol: "BTCUSDT",
    side,
    openedAt: at,
    entryPrice: 100,
    quantity: 10,
    stopPrice: side === "long" ? 97 : 103,
    takePrice: side === "long" ? 103 : 97,
    trailingPrice: null,
    bestPrice: 100,
    entryFee: 0.6,
    entrySlippage: 0,
    entryRegime: "neutral",
    entrySession: "us",
  };
}
function candle(side: "long" | "short", close = 100.5) {
  const c = { ...seed, symbol: "BTCUSDT", openTime: at, open: 101, high: 110, low: 99.5, close };
  return side === "long"
    ? c
    : { ...c, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high, close: 200 - c.close };
}
for (const side of ["long", "short"] as const) {
  test(`${side}: pre-fill favorable extreme cannot invent profit or tighten protection`, () => {
    const p = position(side),
      c = candle(side),
      range = executionEntryCandleRange(p, c, config);
    assert.equal(evaluateExecutionExit(p, c, config)!.exitReason, "take-profit");
    assert.equal(range.mode, "intrabar-uncertain");
    assert.equal(evaluateExecutionExit(p, range.candle, config), null);
    const updated = updateExecutionTrailing(p, range.candle, config);
    assert.equal(updated.trailingPrice, null);
    assert.equal(updated.stopPrice, p.stopPrice);
    assert.equal(updated.bestPrice, c.close);
  });
  test(`${side}: final close beyond target confirms a post-fill take`, () => {
    const range = executionEntryCandleRange(position(side), candle(side, 104), config);
    assert.equal(
      evaluateExecutionExit(position(side), range.candle, config)!.exitReason,
      "take-profit",
    );
  });
  test(`${side}: adverse crossing after the limit remains a conservative stop`, () => {
    const c = candle(side);
    if (side === "long") c.low = 96;
    else c.high = 104;
    const range = executionEntryCandleRange(position(side), c, config);
    assert.equal(
      evaluateExecutionExit(position(side), range.candle, config)!.exitReason,
      "stop-loss",
    );
  });
  test(`${side}: known opening fill preserves the complete range`, () => {
    const c = candle(side);
    c.open = side === "long" ? 99.8 : 100.2;
    const range = executionEntryCandleRange(position(side), c, config);
    assert.equal(range.mode, "opening-fill");
    assert.equal(range.candle, c);
    const market = executionEntryCandleRange(position(side), candle(side), {
      ...config,
      entry: { ...config.entry, orderType: "market" },
    });
    assert.equal(market.mode, "opening-fill");
  });
}

test("validation and replay exclude a premature entry-candle TP and mark the uncertain limit fill", () => {
  const configured = strategyConfigSchema.parse({
    ...config,
    signal: { ...config.signal, direction: "long" },
    entry: { ...config.entry, limitOffsetBps: 100 },
    exit: { ...config.exit, trailingStopPercent: 0, breakEvenActivationR: 0 },
  });
  const candles = fixture.candles.map((c) => ({ ...c, openTime: new Date(c.openTime) }));
  const enriched = enrichExecutionCandles(candles, configured);
  const index = enriched.findIndex((c) => getExecutionSignal(c, configured)?.side === "long");
  assert.ok(index >= 0 && index + 1 < candles.length);
  const entry = getExecutionSignal(enriched[index]!, configured)!.signalPrice * 0.99;
  const history = candles.slice(0, index + 2);
  history[index + 1] = {
    ...history[index + 1]!,
    open: entry * 1.01,
    high: entry * 1.1,
    low: entry * 0.995,
    close: entry * 0.999,
  };
  const replay = runRuntimeReplay({ config: configured, candles: history, initialCapital: 10000 });
  const validation = runValidationEngine({
    config: configured,
    candles: history,
    initialCapital: 10000,
    kind: "backtest",
    walkForward: null,
  });
  assert.equal(replay.trades.length, 1);
  assert.equal(validation.trades.length, 1);
  assert.equal(replay.trades[0]!.exitReason, "end-of-data");
  assert.ok(replay.trades[0]!.netPnl < 0);
  assert.equal(replay.trades[0]!.netPnl, validation.trades[0]!.netPnl);
  assert.equal(
    replay.decisions.find((d) => d.action === "open")!.reasonCode,
    "pending-limit-filled-intrabar-uncertain",
  );
});
