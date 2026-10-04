import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { advanceExecutionIndicators } from "../packages/application/src/index";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  positionIndicatorCheckpoint,
  replayPositionIndicators,
} from "../apps/worker/src/runtime-position-indicators";
import { processRuntimePriceEvents } from "../apps/worker/src/runtime-price-processor";
import { openExecutionPositionAtQuote } from "../packages/application/src/index";

const config = strategyConfigSchema.parse(fixture.config);
const intervalMs = 900_000;
const history = Array.from({ length: 160 }, (_, index) => ({
  symbol: "BTCUSDT",
  openTime: new Date(Date.UTC(2026, 0, 1) + index * intervalMs),
  open: 100,
  high: 101,
  low: 99,
  close: 100 + Math.sin(index / 8),
  turnover: 1000,
}));
const seed = advanceExecutionIndicators(history.slice(0, 124), config).checkpoint!;
const available = history.slice(124).map((candle) => new Date(+candle.openTime + intervalMs));

test("position owns its signal state even when the deployment cursor is ahead", () => {
  const ahead = advanceExecutionIndicators(history, config).checkpoint!;
  assert.deepEqual(
    positionIndicatorCheckpoint(seed, ahead, new Date(seed.lastCandleAt), config, "BTCUSDT"),
    seed,
  );
  assert.equal(
    positionIndicatorCheckpoint(null, ahead, new Date(seed.lastCandleAt), config, "BTCUSDT"),
    null,
  );
  assert.deepEqual(
    positionIndicatorCheckpoint(null, seed, new Date(seed.lastCandleAt), config, "BTCUSDT"),
    seed,
  );
  assert.throws(() => positionIndicatorCheckpoint(seed, null, null, config, "BTCUSDT"));
  assert.throws(() =>
    positionIndicatorCheckpoint({}, seed, new Date(seed.lastCandleAt), config, "BTCUSDT"),
  );
});

test("position checkpoint advances only through consumed signals and resumes exactly after JSON restart", () => {
  const replay = replayPositionIndicators(history.slice(124), available, intervalMs, config, seed);
  const at = history[130]!.openTime;
  const expected = advanceExecutionIndicators(history.slice(0, 131), config).checkpoint!;
  expected.availableAt = new Date(+at + intervalMs).toISOString();
  assert.deepEqual(replay.checkpointThrough(at), expected);
  assert.equal(replay.checkpointThrough(history[123]!.openTime), null);
  const restarted = replayPositionIndicators(
    history.slice(131),
    available.slice(7),
    intervalMs,
    config,
    JSON.parse(JSON.stringify(replay.checkpointThrough(at))),
  );
  assert.deepEqual(restarted.signals, replay.signals.slice(7));
  assert.deepEqual(
    restarted.checkpointThrough(history.at(-1)!.openTime),
    replay.checkpointThrough(history.at(-1)!.openTime),
  );
  assert.equal(seed.lastCandleAt, history[123]!.openTime.toISOString());
});

test("future finality cannot advance the persisted position indicator state", async () => {
  const openedAt = new Date(+history[123]!.openTime + intervalMs);
  const position = openExecutionPositionAtQuote(
    { side: "long", signalPrice: 100 },
    { symbol: "BTCUSDT", price: 100, observedAt: openedAt },
    "neutral",
    10000,
    10000,
    config,
  )!;
  const delay = new Date(+available[1]! + 5000);
  const availability = available.map((at, index) =>
    index >= 1 ? new Date(Math.max(+at, +delay)) : at,
  );
  const replay = replayPositionIndicators(
    history.slice(124),
    availability,
    intervalMs,
    config,
    seed,
  );
  const quoteAt = available[1]!;
  let committed = false;
  await processRuntimePriceEvents({
    position,
    through: openedAt,
    streamId: "stream",
    config,
    signalCandleAt: history[123]!.openTime,
    signalIntervalMs: intervalMs,
    events: [
      {
        id: 1n,
        symbol: "BTCUSDT",
        streamId: "stream",
        price: 100,
        observedAt: quoteAt,
        receivedAt: quoteAt,
      },
    ],
    loadSignals: async () => replay.signals,
    recover: async () => {
      throw new Error("Unexpected recovery");
    },
    checkpoint: async (state) => {
      committed = true;
      assert.equal(+state.signalCandleAt!, +history[124]!.openTime);
      assert.equal(
        replay.checkpointThrough(state.signalCandleAt!)!.lastCandleAt,
        history[124]!.openTime.toISOString(),
      );
      return true;
    },
  });
  assert.equal(committed, true);
});
