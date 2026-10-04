import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  enrichExecutionCandles,
  advanceExecutionIndicators,
  assertExecutionIndicatorHistory,
  readExecutionIndicatorCheckpoint,
  type ExecutionIndicatorCheckpoint,
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

function oscillatingHistory(length: number): ExecutionCandle[] {
  return history(length).map((candle, index) => ({
    ...candle,
    close: 100 + 10 * Math.sin(index * 0.037) + 2 * Math.sin(index * 0.31),
    high: 100.2 + 10 * Math.sin(index * 0.037) + 2 * Math.sin(index * 0.31),
    low: 99.8 + 10 * Math.sin(index * 0.037) + 2 * Math.sin(index * 0.31),
    turnover: 1000 + Math.sin(index * 0.13),
  }));
}

for (const family of ["ema-crossover", "breakout", "mean-reversion", "momentum"] as const) {
  test(`${family}: JSON restart and arbitrary batches reproduce every indicator and signal exactly`, () => {
    const configured = {
      ...config,
      signal: {
        ...config.signal,
        family,
        emaFastPeriod: 30,
        emaSlowPeriod: 100,
        rsiPeriod: 14,
        rsiOversold: family === "ema-crossover" ? 1 : 30,
        rsiOverbought: family === "ema-crossover" ? 99 : 70,
        meanReversionLookbackPeriod: 20,
        meanReversionEntryZScore: 1,
        breakoutLookbackPeriod: 20,
      },
    };
    const candles = oscillatingHistory(1500);
    const expected = enrichExecutionCandles(candles, configured);
    assert.ok(
      expected.some((candle) => getExecutionSignal(candle, configured)),
      `${family}: scenario must contain actual signals`,
    );
    for (const batchSize of [1, 13, 102, 287]) {
      let checkpoint: ExecutionIndicatorCheckpoint | null = null;
      const actual = [];
      for (let index = 0; index < candles.length; index += batchSize) {
        const result = advanceExecutionIndicators(
          candles.slice(index, index + batchSize),
          configured,
          checkpoint,
        );
        actual.push(...result.candles);
        checkpoint = JSON.parse(JSON.stringify(result.checkpoint));
        assert.ok(checkpoint);
        assert.ok(checkpoint.tail.length <= minimumExecutionCandleCount(configured));
      }
      assert.deepEqual(actual, expected);
      assert.deepEqual(
        actual.map((candle) => getExecutionSignal(candle, configured)),
        expected.map((candle) => getExecutionSignal(candle, configured)),
      );
    }
  });
}

test("checkpoint continues SMA-seeded EMA and Wilder RSI rather than reseeding the rolling window", () => {
  const configured = {
    ...config,
    signal: { ...config.signal, emaFastPeriod: 30, emaSlowPeriod: 100, rsiPeriod: 14 },
  };
  const candles = oscillatingHistory(1500);
  const expected = enrichExecutionCandles(candles, configured);
  const initial = advanceExecutionIndicators(candles.slice(0, 300), configured);
  const resumed = advanceExecutionIndicators(candles.slice(300), configured, initial.checkpoint);
  assert.deepEqual(resumed.candles, expected.slice(300));
  const truncated = enrichExecutionCandles(candles.slice(-102), configured).at(-1)!;
  assert.notEqual(truncated.emaSlow, expected.at(-1)!.emaSlow);
  assert.notEqual(truncated.rsi, expected.at(-1)!.rsi);
  // Independent reference keeps the original formulas and iteration order.
  let ema = candles.slice(0, 100).reduce((sum, candle) => sum + candle.close, 0) / 100;
  for (let index = 100; index < candles.length; index += 1)
    ema = (candles[index]!.close - ema) * (2 / 101) + ema;
  assert.equal(resumed.candles.at(-1)!.emaSlow, ema);
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= 14; index += 1) {
    const change = candles[index]!.close - candles[index - 1]!.close;
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  gain /= 14;
  loss /= 14;
  for (let index = 15; index < candles.length; index += 1) {
    const change = candles[index]!.close - candles[index - 1]!.close;
    gain = (gain * 13 + Math.max(change, 0)) / 14;
    loss = (loss * 13 + Math.max(-change, 0)) / 14;
  }
  assert.equal(resumed.candles.at(-1)!.rsi, 100 - 100 / (1 + gain / loss));
});

test("checkpoint rejects replays, incompatible config/version and corrupt state without resetting silently", () => {
  const candles = oscillatingHistory(120);
  const state = advanceExecutionIndicators(candles, config).checkpoint!;
  assert.throws(() => advanceExecutionIndicators(candles.slice(-1), config, state), /advance/);
  assert.throws(
    () => readExecutionIndicatorCheckpoint({ ...state, version: "unknown" }, config, "BTCUSDT"),
    /checkpoint/,
  );
  assert.throws(
    () =>
      readExecutionIndicatorCheckpoint(
        { ...state, fast: { ...state.fast, value: Infinity } },
        config,
        "BTCUSDT",
      ),
    /checkpoint/,
  );
  assert.throws(() => readExecutionIndicatorCheckpoint(state, config, "ETHUSDT"), /checkpoint/);
  assert.throws(
    () =>
      readExecutionIndicatorCheckpoint(
        state,
        { ...config, signal: { ...config.signal, rsiPeriod: 7 } },
        "BTCUSDT",
      ),
    /checkpoint/,
  );
  assert.throws(
    () =>
      readExecutionIndicatorCheckpoint(
        { ...state, fast: { ...state.fast, count: 0, value: null } },
        config,
        "BTCUSDT",
      ),
    /checkpoint/,
  );
  assert.throws(
    () => readExecutionIndicatorCheckpoint({ ...state, tail: [] }, config, "BTCUSDT"),
    /checkpoint/,
  );
});

test("gap on restart resets state exactly like batch and restores full warmup", () => {
  const before = oscillatingHistory(120);
  const after = history(120, 121);
  const initial = advanceExecutionIndicators(before, config);
  const resumed = advanceExecutionIndicators(after, config, initial.checkpoint);
  assert.deepEqual(
    resumed.candles,
    enrichExecutionCandles([...before, ...after], config).slice(120),
  );
  assert.equal(resumed.candles[0]!.previousEmaSlow, null);
  assert.equal(resumed.candles[94]!.volume24h, null);
  assert.equal(resumed.candles[95]!.volume24h, 960);
});

test("z-score stays finite and reproducible for high prices with tiny variance", () => {
  const candles = history(120).map((candle, index) => ({
    ...candle,
    close: 1e9 + (index % 7) * 0.000001,
  }));
  const batch = enrichExecutionCandles(candles, config);
  const first = advanceExecutionIndicators(candles.slice(0, 100), config);
  const replay = advanceExecutionIndicators(candles.slice(100), config, first.checkpoint);
  assert.deepEqual(replay.candles, batch.slice(100));
  assert.ok(batch.slice(10).every((candle) => Number.isFinite(candle.meanReversionZScore)));
  assert.ok(batch.slice(10).some((candle) => Math.abs(candle.meanReversionZScore!) > 0.5));
});

test("revised checkpoint tail refuses continuation instead of silently mixing histories", () => {
  const candles = oscillatingHistory(120);
  const checkpoint = advanceExecutionIndicators(candles, config).checkpoint;
  assert.doesNotThrow(() => assertExecutionIndicatorHistory(candles.slice(-20), checkpoint));
  assert.throws(
    () => assertExecutionIndicatorHistory([{ ...candles[119]!, close: 99 }], checkpoint),
    /revised/,
  );
  assert.throws(
    () => assertExecutionIndicatorHistory([{ ...candles[119]!, turnover: 99 }], checkpoint),
    /revised/,
  );
});

test("EMA crossing and RSI threshold retain identical decisions after a checkpoint restart", () => {
  const configured = {
    ...config,
    signal: {
      ...config.signal,
      family: "ema-crossover" as const,
      emaFastPeriod: 30,
      emaSlowPeriod: 100,
      rsiPeriod: 14,
      rsiOversold: 0,
      rsiOverbought: 100,
    },
  };
  const candles = oscillatingHistory(1500);
  const batch = enrichExecutionCandles(candles, configured);
  const index = batch.findIndex(
    (candle, index) =>
      index > 300 &&
      candle.previousEmaFast! <= candle.previousEmaSlow! &&
      candle.emaFast! > candle.emaSlow!,
  );
  assert.ok(index > 300);
  const initial = advanceExecutionIndicators(candles.slice(0, index), configured);
  const resumed = advanceExecutionIndicators([candles[index]!], configured, initial.checkpoint)
    .candles[0]!;
  assert.deepEqual(resumed, batch[index]);
  for (const offset of [-1e-12, 0, 1e-12]) {
    const threshold = {
      ...configured,
      signal: { ...configured.signal, rsiOverbought: resumed.rsi! + offset },
    };
    assert.deepEqual(
      getExecutionSignal(resumed, threshold),
      getExecutionSignal(batch[index]!, threshold),
    );
    assert.equal(getExecutionSignal(resumed, threshold)?.side ?? null, offset > 0 ? "long" : null);
  }
});
