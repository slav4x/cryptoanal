import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeEntryQuoteWaitReason } from "../packages/persistence/src/runtime-entry-wait";
import { replayPendingEntryEvents } from "../apps/worker/src/runtime-pending-entry";

const now = Date.UTC(2026, 9, 4);
const base = {
  streamConnected: true,
  journalHealthy: true,
  streamId: "active",
  now,
  maximumQuoteAgeMs: 10_000,
};
const quote = { streamId: "active", observedAt: new Date(now) };

test("entry waits distinguish stream, journal, absent, old-stream, stale and future quotes", () => {
  assert.equal(
    runtimeEntryQuoteWaitReason({ ...base, streamConnected: false }),
    "ENTRY_STREAM_UNAVAILABLE",
  );
  assert.equal(
    runtimeEntryQuoteWaitReason({ ...base, journalHealthy: false }),
    "ENTRY_JOURNAL_UNAVAILABLE",
  );
  assert.equal(runtimeEntryQuoteWaitReason(base), "ENTRY_QUOTE_MISSING");
  assert.equal(
    runtimeEntryQuoteWaitReason({ ...base, quote: { ...quote, streamId: "old" } }),
    "ENTRY_QUOTE_STREAM_MISMATCH",
  );
  assert.equal(
    runtimeEntryQuoteWaitReason({
      ...base,
      quote: { ...quote, observedAt: new Date(now - 10_001) },
    }),
    "STALE_ENTRY_QUOTE",
  );
  assert.equal(
    runtimeEntryQuoteWaitReason({ ...base, quote: { ...quote, observedAt: new Date(now + 1001) } }),
    "ENTRY_QUOTE_IN_FUTURE",
  );
  assert.equal(runtimeEntryQuoteWaitReason({ ...base, quote }), null);
});

test("pending replay explains skipped events and limit no-touch without rejecting a valid signal", async () => {
  const event = {
    id: 1n,
    symbol: "BTCUSDT",
    price: 101,
    streamId: "active",
    observedAt: new Date(now),
    receivedAt: new Date(now),
  };
  const replay = {
    cursor: null,
    streamId: "active",
    detectedAt: new Date(now - 1000),
    availableAt: new Date(now - 1000),
    expiresAt: new Date(now + 10000),
    maximumQuoteAgeMs: 10000,
    now: () => now,
  };
  const cases = [
    { event: { ...event, streamId: "old" }, reason: "ENTRY_QUOTE_STREAM_MISMATCH" },
    {
      event: { ...event, receivedAt: new Date(now - 2000) },
      reason: "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY",
    },
    {
      event: { ...event, observedAt: new Date(now - 20000) },
      reason: "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY",
    },
    { event: { ...event, observedAt: new Date(now + 2000) }, reason: "ENTRY_QUOTE_IN_FUTURE" },
    { event, reason: "ENTRY_LIMIT_NOT_TOUCHED" },
  ];
  for (const item of cases) {
    const result = await replayPendingEntryEvents({
      ...replay,
      events: [item.event],
      tryFill: async () => ({ status: "no-touch" }),
    });
    assert.equal(result.status, "pending");
    assert.equal("waitingReason" in result && result.waitingReason, item.reason);
    assert.equal(result.throughEventId, 1n);
  }
  const stale = await replayPendingEntryEvents({
    ...replay,
    detectedAt: new Date(now - 30000),
    availableAt: new Date(now - 30000),
    events: [{ ...event, observedAt: new Date(now - 20000) }],
    tryFill: async () => {
      throw new Error("stale event reached fill");
    },
  });
  assert.equal("waitingReason" in stale && stale.waitingReason, "STALE_ENTRY_QUOTE");
  const empty = await replayPendingEntryEvents({
    ...replay,
    events: [],
    tryFill: async () => ({ status: "no-touch" }),
  });
  assert.equal("waitingReason" in empty && empty.waitingReason, undefined);
});
