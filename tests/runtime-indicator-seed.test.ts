import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  advanceExecutionIndicators,
  enrichExecutionCandles,
  getExecutionSignal,
  runValidationEngine,
} from "../packages/application/src/index";
import {
  loadValidationIndicatorSeed,
  validationIndicatorSource,
} from "../apps/worker/src/runtime-indicator-seed";

const config = strategyConfigSchema.parse(fixture.config);
const hash = "a".repeat(64);
const source = {
  datasetSnapshotId: "snapshot",
  contentHash: hash,
  validationRunId: "validation",
  validationEngineVersion: "current",
};
const start = Date.parse("2026-01-01T00:00:00Z");
function candles(length: number) {
  return Array.from({ length }, (_, index) => ({
    symbol: "BTCUSDT",
    openTime: new Date(start + index * 900000),
    open: 100,
    high: 115,
    low: 85,
    close: 100 + Math.sin(index * 0.04) * 10 + Math.sin(index * 0.31),
    turnover: 1000 + Math.sin(index),
  }));
}
function snapshot(history = candles(1500)) {
  return {
    id: "snapshot",
    schemaVersion: 1,
    contentHash: hash,
    timeframe: "15m",
    source: "bybit-public-linear-klines",
    exchange: "bybit",
    instrumentType: "linear-perpetual",
    candles: history,
  };
}
const availableAt = new Date(start + 1500 * 900000 + 1000);

test("new contexts pin the snapshot hash; old snapshot references remain readable and non-snapshot runs are explicit legacy", () => {
  assert.deepEqual(
    validationIndicatorSource({
      validation: {
        datasetSnapshotId: "snapshot",
        datasetContentHash: hash,
        runId: "validation",
        engineVersion: "current",
      },
    }),
    source,
  );
  assert.equal(
    validationIndicatorSource({ validation: { datasetId: "dataset-snapshot:snapshot" } })
      ?.datasetSnapshotId,
    "snapshot",
  );
  assert.equal(
    validationIndicatorSource({ validation: { datasetId: "market-candles-request:legacy" } }),
    null,
  );
  assert.equal(validationIndicatorSource(null), null);
});

for (const family of ["ema-crossover", "breakout", "mean-reversion", "momentum"] as const) {
  test(`${family}: snapshot seed plus new candles equals the full validation prefix after JSON restart`, async () => {
    const configured = {
      ...config,
      signal: { ...config.signal, family, emaFastPeriod: 30, emaSlowPeriod: 100, rsiPeriod: 14 },
    };
    const history = candles(1800);
    const seed = await loadValidationIndicatorSeed({
      source,
      symbol: "BTCUSDT",
      config: configured,
      availableAt,
      loadSnapshot: async () => snapshot(history.slice(0, 1500)),
    });
    const expected = enrichExecutionCandles(history, configured);
    assert.deepEqual(seed.candle, expected[1499]);
    assert.equal(seed.checkpoint.availableAt, availableAt.toISOString());
    assert.equal(seed.checkpoint.anchor?.datasetSnapshotId, "snapshot");
    assert.equal(seed.checkpoint.anchor?.contentHash, hash);
    let state = JSON.parse(JSON.stringify(seed.checkpoint));
    const actual = [];
    for (let index = 1500; index < history.length; index += 13) {
      const result = advanceExecutionIndicators(
        history.slice(index, index + 13),
        configured,
        state,
      );
      actual.push(...result.candles);
      state = JSON.parse(JSON.stringify(result.checkpoint));
    }
    assert.deepEqual(actual, expected.slice(1500));
    assert.deepEqual(
      actual.map((candle) => getExecutionSignal(candle, configured)),
      expected.slice(1500).map((candle) => getExecutionSignal(candle, configured)),
    );
    assert.deepEqual(state.anchor, seed.checkpoint.anchor);
  });
}

test("missing snapshot, wrong hash, timeframe or symbol fail instead of reseeding a new window", async () => {
  const base = { source, symbol: "BTCUSDT", config, availableAt };
  await assert.rejects(
    loadValidationIndicatorSeed({ ...base, loadSnapshot: async () => null }),
    /missing/,
  );
  await assert.rejects(
    loadValidationIndicatorSeed({
      ...base,
      loadSnapshot: async () => ({ ...snapshot(), contentHash: "b".repeat(64) }),
    }),
    /incompatible/,
  );
  await assert.rejects(
    loadValidationIndicatorSeed({
      ...base,
      loadSnapshot: async () => ({ ...snapshot(), timeframe: "4h" }),
    }),
    /incompatible/,
  );
  await assert.rejects(
    loadValidationIndicatorSeed({
      ...base,
      symbol: "ETHUSDT",
      loadSnapshot: async () => snapshot(),
    }),
    /usable/,
  );
});

test("future snapshot bars and a short final continuous segment cannot seed runtime", async () => {
  const base = { source, symbol: "BTCUSDT", config, availableAt };
  await assert.rejects(
    loadValidationIndicatorSeed({ ...base, loadSnapshot: async () => snapshot(candles(1501)) }),
    /closed/,
  );
  const history = candles(1500);
  history.splice(1450, 1);
  await assert.rejects(
    loadValidationIndicatorSeed({ ...base, loadSnapshot: async () => snapshot(history) }),
    /warmup/,
  );
});

test("walk-forward windows continue the common dataset seed instead of reseeding too-short training windows", () => {
  const configured = {
    ...config,
    universe: { ...config.universe, timeframe: "4h" as const },
    signal: {
      ...config.signal,
      family: "ema-crossover" as const,
      emaFastPeriod: 30,
      emaSlowPeriod: 100,
      rsiPeriod: 14,
      rsiOversold: 1,
      rsiOverbought: 99,
    },
  };
  const history = candles(360).map((candle, index) => ({
    ...candle,
    openTime: new Date(start + index * 4 * 3600000),
  }));
  // Each 7+7-day window has only 84 candles, fewer than the 100-candle EMA seed.
  const result = runValidationEngine({
    config: configured,
    candles: history,
    initialCapital: 10000,
    kind: "walk-forward",
    walkForward: { trainingDays: 7, testDays: 7 },
  });
  assert.ok(result.metrics.windows > 1);
  assert.ok(result.trades.length > 0);
  assert.ok(result.trades.every((trade) => Date.parse(trade.openedAt) >= start + 14 * 86400000));
});
