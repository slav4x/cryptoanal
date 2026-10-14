import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  evaluateExecutionExit,
  evaluateExecutionPriceExit,
  enrichExecutionCandles,
  type ExecutionPosition,
} from "../packages/application/src/index";
import { recoverRuntimeGap } from "../apps/worker/src/runtime-recovery";
const config = strategyConfigSchema.parse(fixture.config);
const at = new Date("2026-10-14T00:00:00Z");
const seed = enrichExecutionCandles(
  fixture.candles.map((c) => ({ ...c, openTime: new Date(c.openTime) })),
  config,
).at(-1)!;
function position(side: "long" | "short"): ExecutionPosition {
  return {
    symbol: "BTCUSDT",
    side,
    openedAt: new Date(+at - 3600000),
    entryPrice: 100,
    quantity: 10,
    stopPrice: side === "long" ? 90 : 110,
    trailingPrice: side === "long" ? 105 : 95,
    takePrice: side === "long" ? 120 : 80,
    bestPrice: side === "long" ? 112 : 88,
    entryFee: 0.6,
    entrySlippage: 0,
    entryRegime: "neutral",
    entrySession: "us",
  };
}
function candle(side: "long" | "short", open = 110) {
  const raw = {
    symbol: "BTCUSDT",
    openTime: at,
    open,
    high: Math.max(open, 112),
    low: Math.min(open, 89),
    close: 108,
    turnover: 1000,
  };
  if (side === "long") return { ...seed, ...raw };
  return {
    ...seed,
    ...raw,
    open: 200 - raw.open,
    high: 200 - raw.low,
    low: 200 - raw.high,
    close: 200 - raw.close,
  };
}
for (const side of ["long", "short"] as const) {
  test(`${side}: closer trailing is hit before original stop in a continuous candle`, () => {
    const result = evaluateExecutionExit(position(side), candle(side), config)!;
    assert.equal(result.exitReason, "trailing-stop");
    const expected =
      (side === "long" ? 105 : 95) *
      (side === "long"
        ? 1 - config.costs.slippageBps / 10000
        : 1 + config.costs.slippageBps / 10000);
    assert.ok(Math.abs(result.exitPrice - expected) < 1e-8);
    assert.ok(result.netPnl > 0);
  });
  test(`${side}: gap through both protective levels fills at open and reports tighter protection`, () => {
    const c = candle(side, 85);
    const result = evaluateExecutionExit(position(side), c, config)!;
    const quote = evaluateExecutionPriceExit(
      position(side),
      { symbol: c.symbol, price: c.open, observedAt: at },
      config,
    )!;
    assert.deepEqual(result, quote);
    assert.equal(result.exitReason, "trailing-stop");
    assert.ok(result.netPnl < 0);
  });
  test(`${side}: tighter stop wins over looser trailing and equal levels stay stop-loss`, () => {
    for (const level of [side === "long" ? 80 : 120, side === "long" ? 90 : 110]) {
      const p = { ...position(side), trailingPrice: level };
      assert.equal(evaluateExecutionExit(p, candle(side), config)!.exitReason, "stop-loss");
    }
  });
  test(`${side}: known opening take precedes later adverse intrabar extrema`, () => {
    const c = candle(side, 125);
    const result = evaluateExecutionExit(position(side), c, config)!;
    assert.equal(result.exitReason, "take-profit");
    assert.equal(result.closedAt, at.toISOString());
    const expected =
      position(side).takePrice *
      (side === "long"
        ? 1 - config.costs.slippageBps / 10000
        : 1 + config.costs.slippageBps / 10000);
    assert.ok(Math.abs(result.exitPrice - expected) < 1e-8);
  });
  test(`${side}: ambiguous intrabar take and protection keep conservative protective-first policy`, () => {
    const c = candle(side);
    if (side === "long") c.high = 125;
    else c.low = 75;
    assert.equal(evaluateExecutionExit(position(side), c, config)!.exitReason, "trailing-stop");
  });
  test(`${side}: complete-minute recovery uses the same tighter protection and does not invent OHLC order`, () => {
    const c = candle(side);
    const result = recoverRuntimeGap({
      position: position(side),
      since: at,
      quote: { symbol: c.symbol, price: c.close, observedAt: new Date(+at + 60000) },
      minutes: [c],
      signals: [],
      signalIntervalMs: 900000,
      config,
    });
    assert.equal(result.settlement!.exitReason, "trailing-stop");
    assert.ok(result.settlement!.netPnl > 0);
    assert.equal(result.evidence.quality, "complete-minutes");
    assert.equal(result.settlement!.closedAt, new Date(+at + 60000).toISOString());
  });
}
