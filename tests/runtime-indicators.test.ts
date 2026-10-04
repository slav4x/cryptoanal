import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  enrichExecutionCandles,
  getExecutionSignal,
  minimumExecutionCandleCount,
  runRuntimeReplay,
  runValidationEngine,
  type ExecutionCandle,
} from "../packages/application/src/index";

const config = strategyConfigSchema.parse(fixture.config);
const intervalMs = 900_000;
const start = Date.parse("2026-01-01T00:00:00Z");
function history(length: number, offset = 0, symbol = "BTCUSDT"): ExecutionCandle[] {
  return Array.from({ length }, (_, index) => ({
    symbol,
    openTime: new Date(start + (offset + index) * intervalMs),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    turnover: 10,
  }));
}

test("24h volume is unavailable until the exact full continuous window", () => {
  for (const [timeframe, minutes] of [
    ["5m", 5],
    ["15m", 15],
    ["30m", 30],
    ["1h", 60],
    ["4h", 240],
  ] as const) {
    const count = 1440 / minutes;
    const candles = history(count + 1).map((candle, index) => ({
      ...candle,
      openTime: new Date(start + index * minutes * 60_000),
      turnover: index + 1,
    }));
    const enriched = enrichExecutionCandles(candles, {
      ...config,
      universe: { ...config.universe, timeframe },
    });
    assert.equal(enriched[count - 2]!.volume24h, null);
    assert.equal(enriched[count - 1]!.volume24h, (count * (count + 1)) / 2);
    assert.equal(enriched[count]!.volume24h, (count * (count + 3)) / 2);
  }
});

test("all families reject otherwise valid signals with incomplete volume", () => {
  const baseline = enrichExecutionCandles(history(96), config).at(-1)!;
  for (const family of ["ema-crossover", "breakout", "mean-reversion", "momentum"] as const) {
    const configured = { ...config, signal: { ...config.signal, family } };
    const candle = {
      ...baseline,
      close: 102,
      rsi: 50,
      previousRsi: 20,
      previousEmaFast: 99,
      previousEmaSlow: 100,
      emaFast: 101,
      emaSlow: 100,
      breakoutHigh: 101,
      breakoutLow: 99,
      previousMeanReversionZScore: -3,
      meanReversionZScore: -1,
      previousMomentumPercent: 0,
      momentumPercent: 2,
    };
    assert.equal(getExecutionSignal(candle, configured)?.side, "long");
    assert.equal(getExecutionSignal({ ...candle, volume24h: null }, configured), null);
  }
});

test("missing candles reset every indicator and the full volume warmup", () => {
  const before = history(120);
  const after = history(120, 121).map((candle, index) => ({
    ...candle,
    close: 110 + Math.sin(index),
    turnover: 20,
  }));
  const combined = enrichExecutionCandles([...before, ...after], config);
  assert.deepEqual(combined.slice(before.length), enrichExecutionCandles(after, config));
  assert.equal(combined[120]!.previousEmaFast, null);
  assert.equal(combined[120]!.previousRsi, null);
  assert.equal(combined[214]!.volume24h, null);
  assert.equal(combined[215]!.volume24h, 1920);
});

test("symbols cannot contaminate each other's indicator history", () => {
  const btc = history(120);
  const eth = history(120, 0, "ETHUSDT").map((candle) => ({
    ...candle,
    close: 1000,
    turnover: 100,
  }));
  const combined = enrichExecutionCandles([...btc, ...eth].reverse(), config);
  for (const candles of [btc, eth]) {
    assert.deepEqual(
      combined.filter((candle) => candle.symbol === candles[0]!.symbol),
      enrichExecutionCandles(candles, config),
    );
  }
});

test("duplicate timestamps fail instead of inventing a second indicator step", () => {
  const candles = history(120);
  assert.throws(() => enrichExecutionCandles([...candles, candles[119]!], config), /Duplicate/);
});

test("short histories do not trade in either validation or replay", () => {
  const candles = history(80).map((candle, index) => ({
    ...candle,
    close: index % 4 < 2 ? 100 : 110,
  }));
  assert.equal(
    runValidationEngine({
      config,
      candles,
      initialCapital: 10000,
      kind: "backtest",
      walkForward: null,
    }).trades.length,
    0,
  );
  assert.equal(runRuntimeReplay({ config, candles, initialCapital: 10000 }).trades.length, 0);
});

test("minimum runtime history supplies volume and previous indicator warmup for all families", () => {
  for (const timeframe of ["5m", "15m", "30m", "1h", "4h"] as const) {
    for (const family of ["ema-crossover", "breakout", "mean-reversion", "momentum"] as const) {
      const configured = {
        ...config,
        universe: { ...config.universe, timeframe },
        signal: { ...config.signal, family },
      };
      const minutes = { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 }[timeframe];
      const candles = history(minimumExecutionCandleCount(configured)).map((candle, index) => ({
        ...candle,
        openTime: new Date(start + index * minutes * 60_000),
      }));
      const last = enrichExecutionCandles(candles, configured).at(-1)!;
      assert.notEqual(last.volume24h, null);
      assert.notEqual(last.atrPercent, null);
      assert.notEqual(last.previousEmaSlow, null);
      assert.notEqual(last.previousRsi, null);
      if (family === "breakout") assert.notEqual(last.breakoutHigh, null);
      if (family === "mean-reversion") assert.notEqual(last.previousMeanReversionZScore, null);
      if (family === "momentum") assert.notEqual(last.previousMomentumPercent, null);
    }
  }
});
