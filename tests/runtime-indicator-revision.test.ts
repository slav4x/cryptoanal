import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  advanceExecutionIndicators,
  assertExecutionIndicatorHistory,
  readExecutionIndicatorCheckpoint,
} from "../packages/application/src/index";
import { loadValidationIndicatorSeed } from "../apps/worker/src/runtime-indicator-seed";
import { restoreRevisedIndicators } from "../apps/worker/src/runtime-indicator-revision";
import { replayPositionIndicators } from "../apps/worker/src/runtime-position-indicators";

const config = strategyConfigSchema.parse(fixture.config);
const start = Date.parse("2026-01-01T00:00:00Z");
const interval = 900_000;
const availableAt = new Date(start + 1801 * interval);
const revisionAt = new Date(+availableAt - 1000);
async function scenario(index = 1799) {
  const history = Array.from({ length: 1801 }, (_, index) => ({
    symbol: "BTCUSDT",
    openTime: new Date(start + index * interval),
    open: 100,
    high: 115,
    low: 85,
    close: 100 + Math.sin(index * 0.04) * 10 + Math.sin(index * 0.31),
    turnover: 1000 + Math.sin(index),
  }));
  const seed = (
    await loadValidationIndicatorSeed({
      source: {
        datasetSnapshotId: "snapshot",
        contentHash: "a".repeat(64),
        validationRunId: "validation",
        validationEngineVersion: "current",
      },
      symbol: "BTCUSDT",
      config,
      availableAt,
      loadSnapshot: async () => ({
        id: "snapshot",
        schemaVersion: 1,
        contentHash: "a".repeat(64),
        timeframe: "15m",
        source: "bybit-public-linear-klines",
        exchange: "bybit",
        instrumentType: "linear-perpetual",
        candles: history.slice(0, 1500),
      }),
    })
  ).checkpoint;
  const checkpoint = JSON.parse(
    JSON.stringify(advanceExecutionIndicators(history.slice(1500, 1800), config, seed).checkpoint!),
  );
  history[index] = {
    ...history[index]!,
    close: history[index]!.close + 0.01,
    turnover: history[index]!.turnover + 10,
  };
  return { history, seed, checkpoint };
}

for (const index of [1799, 1501]) {
  test(`revision at candle ${index} rebuilds the full pinned prefix without moving the decision boundary`, async () => {
    const { history, seed, checkpoint } = await scenario(index);
    checkpoint.anchor = Object.fromEntries(Object.entries(checkpoint.anchor!).reverse());
    const original = JSON.stringify(checkpoint);
    if (index === 1501)
      assert.doesNotThrow(() =>
        assertExecutionIndicatorHistory(history.slice(1700, 1800), checkpoint),
      );
    else
      assert.throws(
        () => assertExecutionIndicatorHistory(history.slice(1700, 1800), checkpoint),
        /history was revised/,
      );
    const restored = await restoreRevisedIndicators({
      checkpoint,
      history: history.slice(1700, 1800),
      revisionAt: index === 1799 ? null : revisionAt,
      availableAt,
      config,
      loadSeed: async () => seed,
      loadHistory: async (start, end) =>
        history.filter((candle) => +candle.openTime >= +start && +candle.openTime <= +end),
    });
    assert.equal(restored.restored, true);
    assert.equal(JSON.stringify(checkpoint), original);
    const expected = advanceExecutionIndicators(
      history.slice(1500, 1800),
      config,
      seed,
    ).checkpoint!;
    assert.deepEqual(restored.checkpoint, {
      ...expected,
      availableAt: availableAt.toISOString(),
      sourceRevisionAt: index === 1799 ? null : revisionAt.toISOString(),
    });
    assert.equal(restored.checkpoint.lastCandleAt, checkpoint.lastCandleAt);
    assert.deepEqual(restored.checkpoint.anchor, checkpoint.anchor);
    assert.deepEqual(
      readExecutionIndicatorCheckpoint(
        JSON.parse(JSON.stringify(restored.checkpoint)),
        config,
        "BTCUSDT",
      ),
      restored.checkpoint,
    );
    const next = replayPositionIndicators(
      history.slice(1800),
      [new Date(start + 1801 * interval - 5000)],
      interval,
      config,
      restored.checkpoint,
    );
    assert.equal(next.signals.length, 1);
    assert.equal(+next.signals[0]!.candle.openTime, start + 1800 * interval);
    assert.equal(+next.signals[0]!.availableAt, +availableAt);
    assert.equal(
      next.checkpointThrough(history[1800]!.openTime)?.sourceRevisionAt,
      restored.checkpoint.sourceRevisionAt,
    );
    const repeated = await restoreRevisedIndicators({
      checkpoint: restored.checkpoint,
      history: history.slice(1700, 1800),
      revisionAt: index === 1799 ? null : revisionAt,
      availableAt,
      config,
      loadSeed: async () => {
        throw new Error("unnecessary seed read");
      },
      loadHistory: async () => {
        throw new Error("unnecessary history read");
      },
    });
    assert.equal(repeated.restored, false);
  });
}

test("seed snapshot remains authoritative when only the mutable seed prefix changes", async () => {
  const { history, seed, checkpoint } = await scenario(1499);
  const result = await restoreRevisedIndicators({
    checkpoint: seed,
    history: history.slice(1400, 1500),
    revisionAt: null,
    availableAt,
    config,
    loadSeed: async () => {
      throw new Error("seed should not change");
    },
    loadHistory: async () => [],
  });
  assert.equal(result.restored, false);
  assert.deepEqual(result.checkpoint, seed);
  assert.ok(checkpoint.anchor);
});

for (const failure of [
  "missing candle",
  "different anchor",
  "no anchor",
  "excessive range",
] as const) {
  test(`revision recovery fails closed with ${failure}`, async () => {
    const { history, seed, checkpoint } = await scenario();
    if (failure === "no anchor") delete checkpoint.anchor;
    if (failure === "excessive range")
      checkpoint.lastCandleAt = new Date(start + 52_000 * interval).toISOString();
    const original = JSON.stringify(checkpoint);
    await assert.rejects(
      restoreRevisedIndicators({
        checkpoint,
        history: history.slice(1700, 1800),
        revisionAt,
        availableAt,
        config,
        loadSeed: async () =>
          failure === "different anchor"
            ? { ...seed, anchor: { ...seed.anchor!, contentHash: "b".repeat(64) } }
            : seed,
        loadHistory: async () =>
          failure === "missing candle" ? history.slice(1501, 1800) : history.slice(1500, 1800),
      }),
    );
    assert.equal(JSON.stringify(checkpoint), original);
  });
}
