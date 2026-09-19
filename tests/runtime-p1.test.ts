import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  evaluateExecutionPriceExit,
  openExecutionPositionAtQuote,
  settleExecutionPosition,
} from "../packages/application/src/index";
import { OrderedPriceJournal } from "../apps/worker/src/price-journal";
import {
  recoverRuntimeGap,
  RuntimeRecoveryIncompleteError,
  limitRuntimePositionRisk,
} from "../apps/worker/src/runtime-recovery";

const config = strategyConfigSchema.parse(fixture.config);
const at = new Date("2026-01-01T12:00:00Z");
function position() {
  const value = openExecutionPositionAtQuote(
    { side: "long", signalPrice: 100 },
    { symbol: "BTCUSDT", price: 100, observedAt: at },
    "neutral",
    10000,
    10000,
    config,
  );
  assert.ok(value);
  return value;
}
function minute(offset: number, high = 101, low = 99) {
  return {
    symbol: "BTCUSDT",
    openTime: new Date(at.getTime() + offset * 60_000),
    open: 100,
    high,
    low,
    close: 100,
    turnover: 1000,
  };
}
function recovery(minutes = [minute(0), minute(1), minute(2)]) {
  return {
    position: position(),
    since: at,
    quote: { symbol: "BTCUSDT", price: 100, observedAt: new Date(at.getTime() + 120_000) },
    minutes,
    signals: [],
    signalIntervalMs: 900_000,
    config,
  };
}

test("journal retries the same ordered batch and retains events queued during writes", async () => {
  let release!: () => void;
  let fail = true;
  const written: number[][] = [];
  const journal = new OrderedPriceJournal<number>(async (batch) => {
    written.push([...batch]);
    if (fail) {
      fail = false;
      throw new Error("database unavailable");
    }
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  journal.enqueue(1);
  journal.enqueue(2);
  await assert.rejects(journal.flush());
  assert.equal(journal.healthy, false);
  const first = journal.flush();
  journal.enqueue(3);
  assert.equal(journal.flush(), first);
  release();
  await first;
  const second = journal.flush();
  release();
  await second;
  assert.deepEqual(written, [[1, 2], [1, 2], [3]]);
  assert.equal(journal.healthy, true);
});

test("queue overflow blocks entries until durable progress resumes", async () => {
  const journal = new OrderedPriceJournal<number>(async () => {}, 2);
  assert.equal(journal.enqueue(1), true);
  assert.equal(journal.enqueue(2), true);
  assert.equal(journal.enqueue(3), false);
  assert.equal(journal.healthy, false);
  await journal.flushAll();
  assert.equal(journal.healthy, true);
});

test("stop touch followed by rebound is retained in a single journal batch", async () => {
  const p = position();
  let exit: ReturnType<typeof evaluateExecutionPriceExit> = null;
  const journal = new OrderedPriceJournal<number>(async (prices) => {
    for (const price of prices) {
      exit ??= evaluateExecutionPriceExit(p, { symbol: p.symbol, price, observedAt: at }, config);
    }
  });
  journal.enqueue(97);
  journal.enqueue(100);
  await journal.flushAll();
  assert.equal((exit as ReturnType<typeof evaluateExecutionPriceExit>)?.exitReason, "stop-loss");
});

test("complete recovery minute replays the stop before later rebound", () => {
  const result = recoverRuntimeGap(recovery([minute(0, 101, 97), minute(1), minute(2)]));
  assert.equal(result.settlement?.exitReason, "stop-loss");
  assert.equal(result.settlement?.closedAt, new Date(at.getTime() + 60_000).toISOString());
});

test("recovery refuses missing or invalid minute history", () => {
  assert.throws(
    () => recoverRuntimeGap(recovery([minute(0), minute(2)])),
    RuntimeRecoveryIncompleteError,
  );
  assert.throws(
    () => recoverRuntimeGap(recovery([minute(0), minute(1, 99), minute(2)])),
    RuntimeRecoveryIncompleteError,
  );
});

test("partial-bar touch exits at known recovery quote without inventing a historical fill", () => {
  const input = recovery([minute(0, 105, 97), minute(1), minute(2)]);
  input.since = new Date(at.getTime() + 30_000);
  const result = recoverRuntimeGap(input);
  assert.equal(result.settlement?.exitReason, "recovery-exit");
  assert.equal(result.settlement?.closedAt, input.quote.observedAt.toISOString());
});

test("partial future extrema never silently tighten protection", () => {
  const input = recovery([minute(0, 100.05, 99.5), minute(1, 100.05, 99.5), minute(2, 103)]);
  const result = recoverRuntimeGap(input);
  assert.equal(result.settlement?.exitReason, "recovery-exit");
  assert.equal(result.position.bestPrice, input.position.bestPrice);
});

test("runtime sizing budgets stop fees and slippage as well as account exposure", () => {
  const limited = limitRuntimePositionRisk(position(), 10000, 3000, config);
  assert.ok(limited);
  const stopped = settleExecutionPosition(limited, limited.stopPrice, at, "stop-loss", config);
  assert.ok(-stopped.netPnl <= 100 + 1e-8);
  assert.ok(limited.quantity * limited.entryPrice + limited.entryFee <= 3000 + 1e-8);
  assert.equal(limitRuntimePositionRisk(position(), 0, 3000, config), null);
});
