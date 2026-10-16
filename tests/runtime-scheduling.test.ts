import assert from "node:assert/strict";
import { test } from "node:test";
import { runRuntimeLane } from "../apps/worker/src/runtime-lane";
import {
  RuntimeProtectionWatch,
  RuntimeProtectionPreempted,
} from "../apps/worker/src/runtime-protection-watch";
import { RuntimeLatency } from "../apps/worker/src/runtime-latency";
import { OrderedPriceJournal } from "../apps/worker/src/price-journal";
import { selectPriorityExit } from "../apps/worker/src/runtime-priority-exit";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import fixture from "../research/golden/v1/momentum-reversal.json";
import type { ExecutionPosition } from "../packages/application/src/execution-engine";

for (const side of ["long", "short"] as const) {
  test(`${side}: priority protection preserves transient touches and the first retained exit`, () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const position: ExecutionPosition = {
      symbol: "BTCUSDT",
      side,
      openedAt: at,
      entryPrice: 100,
      quantity: 1,
      stopPrice: side === "long" ? 98 : 102,
      takePrice: side === "long" ? 104 : 96,
      trailingPrice: null,
      bestPrice: 100,
      entryFee: 0.06,
      entrySlippage: 0,
      entryRegime: "neutral",
      entrySession: "asia",
    };
    const event = (id: number, price: number) => ({
      symbol: position.symbol,
      id: BigInt(id),
      price,
      streamId: "stream",
      observedAt: new Date(+at + id * 100),
      receivedAt: new Date(+at + id * 100),
    });
    const stop = event(2, side === "long" ? 97 : 103),
      rebound = event(3, 100);
    const base = {
      position,
      through: at,
      config: strategyConfigSchema.parse(fixture.config),
      latest: rebound,
    };
    assert.equal(selectPriorityExit({ ...base, events: [stop, rebound] })?.event.id, 2n);
    const tp = event(1, side === "long" ? 105 : 95);
    assert.equal(
      selectPriorityExit({ ...base, events: [tp, stop, rebound] })?.settlement.exitReason,
      "take-profit",
    );
    assert.equal(
      selectPriorityExit({ ...base, through: new Date(+at + 250), events: [stop, rebound] }),
      null,
    );
    assert.equal(selectPriorityExit({ ...base, events: [event(4, stop.price)] }), null);
    assert.equal(position.bestPrice, 100);
    assert.equal(position.trailingPrice, null);
  });
}

test("pending entries keep running while every position slot waits for history", async () => {
  const visited: number[] = [];
  let stopped = false,
    release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const positions = runRuntimeLane({
    stopping: () => stopped,
    concurrency: 2,
    intervalMs: 1,
    load: async () => [1, 2],
    process: async () => {
      await blocked;
    },
    onError: (e) => {
      throw e;
    },
    wait: async () => {
      stopped = true;
    },
  });
  let cycles = 0;
  await runRuntimeLane({
    stopping: () => stopped,
    concurrency: 1,
    intervalMs: 1,
    load: async () => [++cycles],
    process: async (entry) => {
      visited.push(entry);
    },
    onError: (e) => {
      throw e;
    },
    wait: async () => {
      if (cycles === 3) {
        stopped = true;
        release();
      }
    },
  });
  await positions;
  assert.deepEqual(visited, [1, 2, 3]);
});

test("priority protection interrupts a history request only after its CAS commit", async () => {
  const watch = new RuntimeProtectionWatch();
  let touched = false,
    calls = 0,
    commit!: () => void;
  const committing = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const work = watch.during(
    "position",
    async () => {
      if (!touched) return false;
      calls++;
      await committing;
      return true;
    },
    async (signal) => {
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
  );
  const rejected = assert.rejects(work, RuntimeProtectionPreempted);
  await watch.poll(2, (e) => {
    throw e;
  });
  assert.equal(watch.size, 1);
  touched = true;
  const first = watch.poll(2, (e) => {
    throw e;
  });
  await watch.poll(2, (e) => {
    throw e;
  });
  assert.equal(calls, 1);
  assert.equal(watch.size, 1);
  commit();
  await first;
  await rejected;
  assert.equal(watch.size, 0);
});

test("failed protection persistence leaves history active and can be retried", async () => {
  const watch = new RuntimeProtectionWatch();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const work = watch.during(
    "position",
    async () => {
      throw new Error("DB unavailable");
    },
    async (signal) => {
      await waiting;
      assert.equal(signal.aborted, false);
      return 5;
    },
  );
  const errors: unknown[] = [];
  await watch.poll(1, (e) => {
    errors.push(e);
  });
  assert.equal(errors.length, 1);
  finish();
  assert.equal(await work, 5);
  assert.equal(watch.size, 0);
});

test("rolling latency reports bounded quantiles and expires old observations", () => {
  let now = 0;
  const metrics = new RuntimeLatency(() => now);
  for (const value of [1, 2, 3, 4, 8, 10, 12, 20, 100, 200]) metrics.observe("journal", value);
  metrics.observe("journal", -1);
  const first = metrics.snapshot();
  assert.equal(first.metrics.journal!.count, 10);
  assert.equal(first.metrics.journal!.p50Ms, 10);
  assert.equal(first.metrics.journal!.p95Ms, 250);
  assert.equal(first.metrics.journal!.p99Ms, 250);
  assert.equal(first.counters["clock.negativeDuration"], 1);
  now = 300000;
  assert.deepEqual(metrics.snapshot().metrics, {});
  metrics.observe("new", 70000);
  assert.equal(metrics.snapshot().metrics.new!.p99Ms, 70000);
});

test("bounded journal retries a burst in order without dropping its failed batch", async () => {
  const batches: number[][] = [],
    saved: number[] = [];
  let attempt = 0;
  const journal = new OrderedPriceJournal<number>(
    async (batch) => {
      batches.push([...batch]);
      if (++attempt === 2) throw new Error("temporary database failure");
      saved.push(...batch);
    },
    2000,
    500,
  );
  for (let i = 0; i < 1201; i++) assert.equal(journal.enqueue(i), true);
  await journal.flush();
  await assert.rejects(journal.flush());
  assert.equal(journal.oldest, 500);
  assert.equal(journal.size, 701);
  await journal.flushAll();
  assert.deepEqual(
    saved,
    Array.from({ length: 1201 }, (_, i) => i),
  );
  assert.deepEqual(
    batches.map((b) => b.length),
    [500, 500, 500, 201],
  );
  assert.equal(journal.healthy, true);
});

test("a prolonged overflow emits one gap per episode instead of flooding stream metadata", async () => {
  let gaps = 0;
  const journal = new OrderedPriceJournal<number>(
    async () => {},
    2,
    1,
    () => {
      gaps++;
    },
  );
  journal.enqueue(1);
  journal.enqueue(2);
  for (let i = 0; i < 10000; i++) assert.equal(journal.enqueue(i), false);
  assert.equal(gaps, 1);
  assert.equal(journal.size, 2);
  await journal.flush();
  assert.equal(journal.enqueue(3), true);
  assert.equal(journal.enqueue(4), false);
  assert.equal(gaps, 2);
  await journal.flushAll();
  assert.equal(journal.healthy, true);
});
