import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import { openExecutionPositionAtQuote } from "../packages/application/src/index";
import { replayPendingEntryEvents } from "../apps/worker/src/runtime-pending-entry";
import type { RuntimePriceEvent } from "../apps/worker/src/runtime-price-processor";

const now = Date.UTC(2026, 9, 4, 14);
const config = strategyConfigSchema.parse(fixture.config);
config.entry.orderType = "limit";
config.entry.limitOffsetBps = 100;
function event(id: number, price: number, offset = 0): RuntimePriceEvent {
  return {
    id: BigInt(id),
    price,
    symbol: "BTCUSDT",
    streamId: "current",
    observedAt: new Date(now + offset),
    receivedAt: new Date(now + offset),
  };
}
const base = {
  cursor: null,
  streamId: "current",
  detectedAt: new Date(now - 1000),
  availableAt: new Date(now - 1000),
  expiresAt: new Date(now + 10000),
  maximumQuoteAgeMs: 10000,
  now: () => now,
};

test("quick limit touch/rebound fills at the first event for long and short, independent of batch size", async () => {
  for (const side of ["long", "short"] as const) {
    const series = side === "long" ? [101, 98.9, 101] : [99, 101.1, 99];
    for (const size of [1, 3]) {
      let cursor: bigint | null = null,
        fills = 0;
      for (let index = 0; index < series.length; index += size) {
        const result = await replayPendingEntryEvents({
          ...base,
          cursor,
          events: series
            .slice(index, index + size)
            .map((price, offset) => event(index + offset + 1, price)),
          tryFill: async (quote) => {
            const position = openExecutionPositionAtQuote(
              { side, signalPrice: 100 },
              quote,
              "neutral",
              10000,
              10000,
              config,
            );
            if (!position) return { status: "no-touch" };
            fills++;
            assert.equal(quote.id, 2n);
            return { status: "filled" };
          },
        });
        cursor = result.throughEventId;
        if (result.status === "filled") break;
      }
      assert.equal(fills, 1);
    }
  }
});

test("restart and repeated batch do not repeat already consumed events", async () => {
  const first = await replayPendingEntryEvents({
    ...base,
    events: [event(1, 101)],
    tryFill: async () => ({ status: "no-touch" }),
  });
  const seen: bigint[] = [];
  const second = await replayPendingEntryEvents({
    ...base,
    cursor: first.throughEventId,
    events: [event(1, 101), event(2, 98.9), event(3, 101)],
    tryFill: async (quote) => {
      seen.push(quote.id);
      return { status: "filled" };
    },
  });
  assert.equal(second.status, "filled");
  assert.deepEqual(seen, [2n]);
});

test("old stream, pre-finality, expired event, stale and future quotes cannot create retrospective entries", async () => {
  const result = await replayPendingEntryEvents({
    ...base,
    events: [
      { ...event(1, 98.9), streamId: "old" },
      event(2, 98.9, -2000),
      event(3, 98.9, 10000),
      event(4, 98.9, -20000),
      event(5, 98.9, 2000),
    ],
    tryFill: async () => {
      throw new Error("Ineligible event reached execution");
    },
  });
  assert.equal(result.status, "pending");
  assert.equal(result.throughEventId, 5n);
});

test("expiry during processing stops before the next event; conflicts and risk rejections stop the batch", async () => {
  let time = now;
  const expired = await replayPendingEntryEvents({
    ...base,
    now: () => time,
    events: [event(1, 101), event(2, 98.9)],
    tryFill: async () => {
      time = +base.expiresAt;
      return { status: "no-touch" };
    },
  });
  assert.equal(expired.status, "expired");
  assert.equal(expired.throughEventId, 1n);
  for (const result of [
    { status: "conflict" as const },
    { status: "rejected" as const, reason: "KILL_SWITCH" },
  ]) {
    let attempts = 0;
    const outcome = await replayPendingEntryEvents({
      ...base,
      events: [event(1, 98.9), event(2, 98.9)],
      tryFill: async () => {
        attempts++;
        return result;
      },
    });
    assert.equal(outcome.status, result.status);
    assert.equal(attempts, 1);
  }
});

test("journal retention preserves the oldest pending entry cursor even without open positions", async () => {
  const { PriceEventRepository } =
    await import("../packages/persistence/src/price-event-repository");
  let retained: unknown;
  const repository = new PriceEventRepository({
    runtimeCursor: { aggregate: async () => ({ _min: { pendingPriceEventId: 5n } }) },
    position: { aggregate: async () => ({ _min: { priceEventId: null } }) },
    marketPriceEvent: {
      deleteMany: async (input: unknown) => {
        retained = input;
        return { count: 0 };
      },
    },
  } as unknown as ConstructorParameters<typeof PriceEventRepository>[0]);
  const before = new Date(now);
  await repository.prune(before);
  assert.deepEqual(retained, { where: { observedAt: { lt: before }, id: { lt: 5n } } });
});
