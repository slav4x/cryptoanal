import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  evaluateHealth,
  openExecutionPositionAtQuote,
  type HealthMonitorInput,
} from "../packages/application/src/index";
import {
  forEachConcurrent,
  processRuntimePriceEvents,
  type RuntimePriceCheckpoint,
} from "../apps/worker/src/runtime-price-processor";
import { RecoveryRequestCache } from "../apps/worker/src/recovery-request-cache";

const config = strategyConfigSchema.parse(fixture.config);
const at = new Date("2026-01-01T12:00:00Z");
const position = () =>
  openExecutionPositionAtQuote(
    { side: "long", signalPrice: 100 },
    { symbol: "BTCUSDT", price: 100, observedAt: at },
    "neutral",
    10000,
    10000,
    config,
  )!;
const event = (id: number, price = 100, streamId = "original") => ({
  id: BigInt(id),
  symbol: "BTCUSDT",
  price,
  streamId,
  observedAt: new Date(+at + id * 1000),
});

test("recovery failure retains the known prefix and its protection before the network wait", async () => {
  const checkpoints: RuntimePriceCheckpoint[] = [];
  const managed = structuredClone(config);
  managed.exit.breakEvenActivationR = 1;
  await assert.rejects(
    processRuntimePriceEvents({
      position: position(),
      through: at,
      streamId: "original",
      events: [event(1, 103), event(2, 103, "new")],
      maximumGapMs: 10000,
      config: managed,
      checkpoint: async (state) => {
        checkpoints.push(state);
        return true;
      },
      recover: async () => {
        assert.equal(checkpoints.length, 1);
        assert.equal(checkpoints[0]!.event.id, 1n);
        assert.ok(checkpoints[0]!.position.stopPrice > 100);
        throw new Error("REST unavailable");
      },
    }),
    /REST unavailable/,
  );
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]!.streamId, "original");
});

test("a failed checkpoint stops replay without recovering or closing stale state", async () => {
  let recoveryCalled = false;
  await processRuntimePriceEvents({
    position: position(),
    through: at,
    streamId: "original",
    events: [event(1), event(2, 100, "new")],
    maximumGapMs: 10000,
    config,
    checkpoint: async () => false,
    recover: async () => {
      recoveryCalled = true;
      throw new Error("unreachable");
    },
  });
  assert.equal(recoveryCalled, false);
});

test("stop touch is settled once before a later rebound in the same batch", async () => {
  const checkpoints: RuntimePriceCheckpoint[] = [];
  await processRuntimePriceEvents({
    position: position(),
    through: at,
    streamId: "original",
    events: [event(1, 97), event(2)],
    maximumGapMs: 10000,
    config,
    recover: async () => {
      throw new Error("unreachable");
    },
    checkpoint: async (state) => {
      checkpoints.push(state);
      return true;
    },
  });
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]!.settlement?.exitReason, "stop-loss");
  assert.equal(checkpoints[0]!.event.id, 1n);
});

test("late pre-entry events advance the journal without changing the mark or protection", async () => {
  const checkpoints: RuntimePriceCheckpoint[] = [];
  const late = { ...event(1, 90), observedAt: new Date(+at - 1000) };
  await processRuntimePriceEvents({
    position: position(),
    through: at,
    streamId: "original",
    markPrice: 102,
    events: [late],
    maximumGapMs: 10000,
    config,
    recover: async () => {
      throw new Error("unreachable");
    },
    checkpoint: async (state) => {
      checkpoints.push(state);
      return true;
    },
  });
  assert.equal(checkpoints[0]!.event.id, 1n);
  assert.equal(checkpoints[0]!.markPrice, 102);
  assert.equal(+checkpoints[0]!.through, +at);
  assert.equal(checkpoints[0]!.settlement, null);
});

test("a blocked position does not prevent other positions from progressing", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completed: number[] = [];
  const processing = forEachConcurrent([1, 2, 3], 2, async (id) => {
    if (id === 1) await waiting;
    completed.push(id);
    if (id === 3) release();
  });
  await processing;
  assert.deepEqual(completed, [2, 3, 1]);
});

test("recovery requests share an in-flight result and retry only after backoff", async () => {
  let now = 0;
  const cache = new RecoveryRequestCache<number>(() => now);
  let calls = 0;
  const load = async () => {
    calls += 1;
    throw new Error("network down");
  };
  const a = cache.get("same-range", load);
  assert.equal(cache.get("same-range", load), a);
  await assert.rejects(a, /network down/);
  await assert.rejects(cache.get("same-range", load), /network down/);
  assert.equal(calls, 1);
  now = 2000;
  await assert.rejects(cache.get("same-range", load), /network down/);
  assert.equal(calls, 2);
  now = 5999;
  await assert.rejects(cache.get("same-range", load));
  assert.equal(calls, 2);
  now = 6000;
  assert.equal(
    await cache.get("same-range", async () => {
      calls += 1;
      return 42;
    }),
    42,
  );
  assert.equal(await cache.get("same-range", load), 42);
  assert.equal(calls, 3);
});

function healthInput(): HealthMonitorInput {
  return {
    now: at,
    initialCapital: 10000,
    thresholds: {
      workerStaleMs: 45000,
      marketStaleMs: 90000,
      accountStaleMs: 600000,
      queueLagMs: 300000,
      outboxLagMs: 300000,
      exchangeVerificationOverdueMs: 180000,
      runtimeLagMs: 10000,
    },
    workerLastSeenAt: at,
    markets: [{ symbol: "BTCUSDT", enabled: true, status: "Trading", observedAt: at }],
    accountObservedAt: at,
    failedJobs24h: 0,
    oldestQueuedJobAt: null,
    rejectedOrders24h: 0,
    runtimeFailures: [],
    pendingOutbox: 0,
    oldestPendingOutboxAt: null,
    riskStops24h: 0,
    exchangeConnections: [],
    driftCandidates: [],
    runtimeProgress: [
      {
        positionId: "position",
        executionRunId: "run",
        symbol: "BTCUSDT",
        managedThroughAt: new Date(+at - 120000),
        priceEventId: "1",
        latestEventId: "3",
        latestEventAt: at,
        latestReceivedAt: at,
        oldestPendingReceivedAt: new Date(+at - 30000),
        streamMatches: true,
        pendingEvents: 2,
        pendingEventsCapped: false,
      },
    ],
  };
}

test("fresh heartbeat and price source cannot hide an overdue position backlog", () => {
  const input = healthInput();
  const result = evaluateHealth(input);
  assert.equal(result.overallStatus, "critical");
  assert.ok(result.conditions.some((condition) => condition.code === "RUNTIME_POSITION_BACKLOG"));
  input.runtimeProgress[0]!.pendingEvents = 1;
  assert.ok(
    evaluateHealth(input).conditions.some(
      (condition) => condition.code === "RUNTIME_POSITION_BACKLOG",
    ),
  );
  input.runtimeProgress[0]!.pendingEvents = 0;
  input.runtimeProgress[0]!.oldestPendingReceivedAt = null;
  assert.equal(evaluateHealth(input).overallStatus, "healthy");
});

test("a quiet source is reported separately and does not invent a processing backlog", () => {
  const input = healthInput();
  input.runtimeProgress[0]!.pendingEvents = 0;
  input.runtimeProgress[0]!.oldestPendingReceivedAt = null;
  input.runtimeProgress[0]!.latestEventAt = new Date(+at - 60000);
  const result = evaluateHealth(input);
  assert.equal(result.overallStatus, "degraded");
  assert.ok(result.conditions.some((condition) => condition.code === "RUNTIME_PRICE_SOURCE_STALE"));
  assert.ok(!result.conditions.some((condition) => condition.code === "RUNTIME_POSITION_BACKLOG"));
});

test("unprocessed stream change is critical even before a backlog timeout", () => {
  const input = healthInput();
  input.runtimeProgress[0]!.oldestPendingReceivedAt = at;
  input.runtimeProgress[0]!.streamMatches = false;
  assert.ok(
    evaluateHealth(input).conditions.some(
      (condition) => condition.code === "RUNTIME_POSITION_RECOVERY_PENDING",
    ),
  );
});
