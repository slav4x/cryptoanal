import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { signalAvailabilityTimes } from "../apps/worker/src/runtime-signal-order";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  openExecutionPositionAtQuote,
  type EnrichedExecutionCandle,
} from "../packages/application/src/index";
import {
  processRuntimePriceEvents,
  type RuntimePriceCheckpoint,
  type RuntimePriceEvent,
  type RuntimeSignalEvent,
} from "../apps/worker/src/runtime-price-processor";

const at = new Date("2026-01-01T12:00:00Z");
const intervalMs = 15 * 60_000;
const config = strategyConfigSchema.parse(fixture.config);
config.signal.family = "ema-crossover";
config.exit.exitOnSignalReversal = true;
const position = () =>
  openExecutionPositionAtQuote(
    { side: "long", signalPrice: 100 },
    { symbol: "BTCUSDT", price: 100, observedAt: at },
    "neutral",
    10000,
    10000,
    config,
  )!;
const event = (id: number, offset: number, price = 100): RuntimePriceEvent => ({
  id: BigInt(id),
  symbol: "BTCUSDT",
  price,
  streamId: "stream",
  observedAt: new Date(+at + offset),
  receivedAt: new Date(+at + offset),
});
function signal(availableOffset = intervalMs, reversed = true): RuntimeSignalEvent {
  const candle: EnrichedExecutionCandle = {
    symbol: "BTCUSDT",
    openTime: at,
    open: 100,
    high: 110,
    low: 90,
    close: 100,
    turnover: 1000,
    emaFast: reversed ? 1 : 3,
    emaSlow: 2,
    previousEmaFast: 3,
    previousEmaSlow: 2,
    rsi: null,
    previousRsi: null,
    atrPercent: null,
    volume24h: 1000,
    breakoutHigh: null,
    breakoutLow: null,
    meanReversionZScore: null,
    previousMeanReversionZScore: null,
    momentumPercent: null,
    previousMomentumPercent: null,
  };
  return {
    candle,
    closedAt: new Date(+at + intervalMs),
    availableAt: new Date(+at + availableOffset),
  };
}
async function replay(batches: RuntimePriceEvent[][], signals = [signal()]) {
  let state: RuntimePriceCheckpoint | null = null;
  let opened = position();
  let through = at;
  let signalCandleAt = new Date(+at - intervalMs);
  for (const events of batches) {
    await processRuntimePriceEvents({
      position: opened,
      through,
      streamId: "stream",
      events,
      config,
      signalCandleAt,
      signalIntervalMs: intervalMs,
      loadSignals: async () => signals,
      recover: async () => {
        throw new Error("unexpected recovery");
      },
      checkpoint: async (checkpoint) => {
        state = checkpoint;
        opened = checkpoint.position;
        through = checkpoint.through;
        signalCandleAt = checkpoint.signalCandleAt!;
        return true;
      },
    });
    if ((state as RuntimePriceCheckpoint | null)?.settlement) break;
  }
  assert.ok(state);
  return state as RuntimePriceCheckpoint;
}

test("late warmup inputs delay dependent signals but future candles cannot delay past signals", () => {
  const late = new Date(+at + intervalMs + 2000);
  const candles = [
    { openTime: new Date(+at - intervalMs), finalizedAt: late },
    { openTime: at, finalizedAt: new Date(+at + intervalMs) },
    { openTime: new Date(+at + intervalMs), finalizedAt: new Date(+at + 3 * intervalMs) },
  ];
  const full = signalAvailabilityTimes(candles, intervalMs, at);
  assert.equal(+full[1]!, +late);
  assert.deepEqual(full.slice(0, 2), signalAvailabilityTimes(candles.slice(0, 2), intervalMs, at));
  assert.equal(
    +signalAvailabilityTimes([{ openTime: at, finalizedAt: null }], intervalMs, late)[0]!,
    +late,
  );
});

test("a recorded reversal exits before a later SL independently of batching and restart", async () => {
  const events = [
    event(1, intervalMs - 1000),
    event(2, intervalMs + 1000),
    event(3, intervalMs + 2000, 97),
  ];
  const whole = await replay([events]);
  const split = await replay(events.map((quote) => [quote]));
  assert.deepEqual(split, whole);
  assert.equal(whole.settlement?.exitReason, "signal-exit");
  assert.equal(whole.event.id, 2n);
  assert.equal(whole.settlement?.closedAt, events[1]!.observedAt.toISOString());
  assert.equal(whole.signalExit?.delayMs, 1000);
});

test("SL before reversal wins and never loads later candle signals", async () => {
  let loaded = false;
  const checkpoints: RuntimePriceCheckpoint[] = [];
  await processRuntimePriceEvents({
    position: position(),
    through: at,
    streamId: "stream",
    config,
    events: [event(1, intervalMs - 1000, 97), event(2, intervalMs + 1000)],
    signalCandleAt: new Date(+at - intervalMs),
    signalIntervalMs: intervalMs,
    loadSignals: async () => {
      loaded = true;
      return [signal()];
    },
    recover: async () => {
      throw new Error("unexpected recovery");
    },
    checkpoint: async (state) => {
      checkpoints.push(state);
      return true;
    },
  });
  assert.equal(loaded, false);
  assert.equal(checkpoints[0]!.settlement?.exitReason, "stop-loss");
});

test("a price touch has priority over a signal at the same timestamp", async () => {
  const state = await replay([[event(1, intervalMs, 97)]]);
  assert.equal(state.settlement?.exitReason, "stop-loss");
  assert.equal(state.signalExit, null);
});

test("a late finality is executed at the first eligible received quote, not the old close", async () => {
  const events = [event(1, intervalMs + 1000, 101), event(2, intervalMs + 3000, 100)];
  const whole = await replay([events], [signal(intervalMs + 2000)]);
  const split = await replay(
    events.map((quote) => [quote]),
    [signal(intervalMs + 2000)],
  );
  assert.deepEqual(split, whole);
  assert.equal(whole.event.id, 2n);
  assert.equal(whole.settlement?.exitReason, "signal-exit");
  assert.equal(whole.settlement?.closedAt, events[1]!.observedAt.toISOString());
  assert.equal(whole.signalExit?.delayMs, 3000);
});

test("future OHLC extremes never close or tighten a realtime position", async () => {
  const state = await replay([[event(1, intervalMs + 1000)]], [signal(intervalMs, false)]);
  assert.equal(state.settlement, null);
  assert.equal(state.position.stopPrice, position().stopPrice);
  assert.equal(state.position.bestPrice, position().bestPrice);
  assert.equal(+state.signalCandleAt!, +at);
});

test("a pre-entry closed signal cannot close an intrabar entry", async () => {
  const stale = signal(-intervalMs);
  stale.candle.openTime = new Date(+at - intervalMs);
  stale.closedAt = at;
  const state = await replay([[event(1, intervalMs + 1000)]], [stale, signal(intervalMs, false)]);
  assert.equal(state.settlement, null);
});

test("missing signal history preserves the safe price prefix and leaves the boundary unprocessed", async () => {
  const checkpoints: RuntimePriceCheckpoint[] = [];
  await assert.rejects(
    processRuntimePriceEvents({
      position: position(),
      through: at,
      streamId: "stream",
      config,
      events: [event(1, intervalMs - 1000), event(2, intervalMs + 1000)],
      signalCandleAt: new Date(+at - intervalMs),
      signalIntervalMs: intervalMs,
      loadSignals: async () => {
        throw new Error("missing history");
      },
      recover: async () => {
        throw new Error("unexpected recovery");
      },
      checkpoint: async (state) => {
        checkpoints.push(state);
        return true;
      },
    }),
    /missing history/,
  );
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]!.event.id, 1n);
  assert.equal(+checkpoints[0]!.signalCandleAt!, +at - intervalMs);
});

test("reconnect recovery cannot skip a signal whose finality arrived after the last managed quote", async () => {
  let state: RuntimePriceCheckpoint | null = null;
  await processRuntimePriceEvents({
    position: position(),
    through: new Date(+at + intervalMs + 1000),
    streamId: "old-stream",
    config,
    events: [event(1, intervalMs + 3000)],
    signalCandleAt: new Date(+at - intervalMs),
    signalIntervalMs: intervalMs,
    loadSignals: async () => [signal(intervalMs + 2000)],
    recover: async (position) => ({ position, settlement: null }),
    checkpoint: async (checkpoint) => {
      state = checkpoint;
      return true;
    },
  });
  assert.equal((state as RuntimePriceCheckpoint | null)?.settlement?.exitReason, "signal-exit");
  assert.equal((state as RuntimePriceCheckpoint | null)?.signalExit?.delayMs, 3000);
});

test("short reversal exits before a later upward stop touch", async () => {
  const short = openExecutionPositionAtQuote(
    { side: "short", signalPrice: 100 },
    { symbol: "BTCUSDT", price: 100, observedAt: at },
    "neutral",
    10000,
    10000,
    config,
  )!;
  const reversed = signal();
  reversed.candle.emaFast = 3;
  reversed.candle.previousEmaFast = 1;
  let state: RuntimePriceCheckpoint | null = null;
  await processRuntimePriceEvents({
    position: short,
    through: at,
    streamId: "stream",
    config,
    events: [event(1, intervalMs + 1000), event(2, intervalMs + 2000, 103)],
    signalCandleAt: new Date(+at - intervalMs),
    signalIntervalMs: intervalMs,
    loadSignals: async () => [reversed],
    recover: async () => {
      throw new Error("unexpected recovery");
    },
    checkpoint: async (checkpoint) => {
      state = checkpoint;
      return true;
    },
  });
  assert.equal((state as RuntimePriceCheckpoint | null)?.settlement?.exitReason, "signal-exit");
  assert.equal((state as RuntimePriceCheckpoint | null)?.event.id, 1n);
});

test("a failed price checkpoint prevents a signal close computed from stale state", async () => {
  let loaded = false;
  await processRuntimePriceEvents({
    position: position(),
    through: at,
    streamId: "stream",
    config,
    events: [event(1, intervalMs - 1000), event(2, intervalMs + 1000)],
    signalCandleAt: new Date(+at - intervalMs),
    signalIntervalMs: intervalMs,
    loadSignals: async () => {
      loaded = true;
      return [signal()];
    },
    recover: async () => {
      throw new Error("unexpected recovery");
    },
    checkpoint: async () => false,
  });
  assert.equal(loaded, false);
});

test("mean-reversion exits use the same ordered quote pipeline", async () => {
  const meanConfig = structuredClone(config);
  meanConfig.signal.family = "mean-reversion";
  const reverted = signal();
  reverted.candle.meanReversionZScore = 0;
  let settlement: RuntimePriceCheckpoint["settlement"] = null;
  await processRuntimePriceEvents({
    position: position(),
    through: at,
    streamId: "stream",
    config: meanConfig,
    events: [event(1, intervalMs + 1000)],
    signalCandleAt: new Date(+at - intervalMs),
    signalIntervalMs: intervalMs,
    loadSignals: async () => [reverted],
    recover: async () => {
      throw new Error("unexpected recovery");
    },
    checkpoint: async (state) => {
      settlement = state.settlement;
      return true;
    },
  });
  assert.equal((settlement as RuntimePriceCheckpoint["settlement"])?.exitReason, "signal-exit");
});
