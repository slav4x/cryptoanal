import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  enrichExecutionCandles,
  evaluateExecutionPriceExit,
  getExecutionSignal,
  openExecutionPositionAtQuote,
  settleExecutionPosition,
  updateExecutionTrailingAtPrice,
} from "../packages/application/src/index";
import {
  evaluateRuntimeCandleExit,
  executionProtectionChanged,
} from "../apps/worker/src/runtime-position";
import { BybitPublicMarketClient } from "../packages/exchange-bybit/src/index";

const config = strategyConfigSchema.parse(fixture.config);
const openedAt = new Date("2026-01-01T12:00:00Z");
function position(side: "long" | "short" = "long") {
  const result = openExecutionPositionAtQuote(
    { side, signalPrice: 100 },
    { symbol: "BTCUSDT", price: 100, observedAt: openedAt },
    "neutral",
    10_000,
    10_000,
    config,
  );
  assert.ok(result);
  return result;
}
function signalCandle() {
  const result = enrichExecutionCandles(
    fixture.candles.map((candle) => ({
      ...candle,
      openTime: new Date(candle.openTime),
    })),
    config,
  ).at(-1)!;
  return {
    ...result,
    openTime: openedAt,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    emaFast: 99,
    emaSlow: 100,
    previousEmaFast: 101,
    previousEmaSlow: 100,
  };
}

for (const family of ["ema-crossover", "breakout", "mean-reversion", "momentum"] as const) {
  for (const side of ["long", "short"] as const) {
    test(`${family}: ${side} signal respects direction and market filters`, () => {
      const configured = { ...config, signal: { ...config.signal, family } };
      const long = side === "long";
      const candle = {
        ...signalCandle(),
        atrPercent: 1,
        volume24h: 1000,
        rsi: 50,
        previousRsi: long ? 20 : 80,
        previousEmaFast: long ? 99 : 101,
        previousEmaSlow: 100,
        emaFast: long ? 101 : 99,
        emaSlow: 100,
        close: long ? 102 : 98,
        breakoutHigh: 101,
        breakoutLow: 99,
        previousMeanReversionZScore: long ? -3 : 3,
        meanReversionZScore: long ? -1 : 1,
        previousMomentumPercent: 0,
        momentumPercent: long ? 2 : -2,
      };
      assert.equal(getExecutionSignal(candle, configured)?.side, side);
      assert.equal(
        getExecutionSignal(candle, {
          ...configured,
          signal: { ...configured.signal, direction: long ? "short" : "long" },
        }),
        null,
      );
      assert.equal(
        getExecutionSignal(candle, {
          ...configured,
          filters: { ...configured.filters, minimumVolume24hUsdt: 2000 },
        }),
        null,
      );
    });
  }
}

for (const side of ["long", "short"] as const) {
  test(`${side}: cost-adjusted break-even survives retracement`, () => {
    const original = position(side);
    const configured = { ...config, exit: { ...config.exit, breakEvenActivationR: 1 } };
    const updated = updateExecutionTrailingAtPrice(
      original,
      side === "long" ? 103 : 97,
      configured,
    );
    assert.ok(executionProtectionChanged(original, updated));
    assert.notEqual(updated.stopPrice, original.stopPrice);
    const settlement = settleExecutionPosition(
      updated,
      updated.stopPrice,
      openedAt,
      "stop-loss",
      configured,
    );
    assert.ok(Math.abs(settlement.netPnl) < 0.000001);
    const retraced = updateExecutionTrailingAtPrice(updated, 100, configured);
    assert.equal(retraced.stopPrice, updated.stopPrice);
    assert.equal(retraced.bestPrice, updated.bestPrice);
  });

  test(`${side}: trailing protection never moves backwards`, () => {
    const original = position(side);
    const configured = { ...config, exit: { ...config.exit, trailingStopPercent: 1 } };
    const updated = updateExecutionTrailingAtPrice(
      original,
      side === "long" ? 103 : 97,
      configured,
    );
    assert.ok(executionProtectionChanged(original, updated));
    assert.equal(
      updateExecutionTrailingAtPrice(updated, 100, configured).trailingPrice,
      updated.trailingPrice,
    );
    const quote = { symbol: original.symbol, price: updated.trailingPrice!, observedAt: openedAt };
    assert.equal(
      evaluateExecutionPriceExit(updated, quote, configured)?.exitReason,
      "trailing-stop",
    );
  });
}

test("realtime signal exit uses executable quote and timestamp", () => {
  const configured = {
    ...config,
    signal: { ...config.signal, family: "ema-crossover" as const },
    exit: { ...config.exit, exitOnSignalReversal: true },
  };
  const closedAt = new Date("2026-01-01T12:15:00Z");
  const quote = { symbol: "BTCUSDT", price: 99.5, observedAt: new Date("2026-01-01T12:15:05Z") };
  const result = evaluateRuntimeCandleExit(position(), signalCandle(), closedAt, configured, quote);
  assert.equal(result?.exitReason, "signal-exit");
  assert.equal(result?.closedAt, quote.observedAt.toISOString());
  assert.equal(
    result?.exitPrice,
    settleExecutionPosition(position(), quote.price, quote.observedAt, "signal-exit", configured)
      .exitPrice,
  );
});

test("pre-entry candle cannot close a realtime position", () => {
  const candle = {
    ...signalCandle(),
    openTime: new Date("2026-01-01T11:45:00Z"),
    low: 1,
    high: 200,
  };
  assert.equal(evaluateRuntimeCandleExit(position(), candle, openedAt, config, null), null);
});

test("intrabar entry does not use earlier OHLC extremes", () => {
  const current = { ...position(), openedAt: new Date("2026-01-01T12:05:00Z") };
  const candle = { ...signalCandle(), low: 1, high: 200 };
  assert.equal(
    evaluateRuntimeCandleExit(current, candle, new Date("2026-01-01T12:15:00Z"), config, null),
    null,
  );
});

test("fallback settlement is timestamped at candle close", () => {
  const candle = { ...signalCandle(), low: 1 };
  const closedAt = new Date("2026-01-01T12:15:00Z");
  const result = evaluateRuntimeCandleExit(position(), candle, closedAt, config, null);
  assert.equal(result?.exitReason, "stop-loss");
  assert.equal(result?.closedAt, closedAt.toISOString());
});

test("REST candle finality uses request time, and requests have an abort deadline", async (t) => {
  const now = Date.now();
  const current = Math.floor(now / 900_000) * 900_000;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.ok(init.signal);
    return Response.json({
      retCode: 0,
      retMsg: "OK",
      result: {
        category: "linear",
        symbol: "BTCUSDT",
        list: [
          [String(current), "100", "101", "99", "100", "1", "100"],
          [String(current - 900_000), "100", "101", "99", "100", "1", "100"],
        ],
      },
    });
  });
  const candles = await new BybitPublicMarketClient("https://example.invalid").getLinearKlines(
    "BTCUSDT",
  );
  assert.deepEqual(
    candles.map((candle) => candle.isClosed),
    [true, false],
  );
});
