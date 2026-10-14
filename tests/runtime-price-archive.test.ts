import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  encodePriceArchive,
  decodePriceArchive,
  type ArchivedPriceEvent,
} from "../packages/persistence/src/price-archive-codec";
import { hashTracePayload } from "../packages/persistence/src/position-trace";

const at = new Date("2026-10-14T00:00:00Z");
function event(id: bigint): ArchivedPriceEvent {
  return {
    id,
    symbol: "BTCUSDT",
    eventKey: `trade:${id}`,
    price: "0.123456789012345678",
    observedAt: at,
    receivedAt: new Date(+at + 100),
    streamId: "continuous",
  };
}
test("compressed archive preserves exact decimals, large IDs, receive times and sequence across restart", async () => {
  const events = [
    event(9007199254740993n),
    { ...event(9007199254740995n), observedAt: new Date(+at - 1), streamId: "new" },
  ];
  const chunk = await encodePriceArchive(events);
  assert.deepEqual(
    decodePriceArchive({ ...chunk, payload: Uint8Array.from(chunk.payload) }),
    events,
  );
  assert.equal(+chunk.startsAt, +at - 1);
});
test("archive corruption, metadata changes and invalid decoded events fail closed", async () => {
  const chunk = await encodePriceArchive([event(1n)]);
  const changed = Uint8Array.from(chunk.payload);
  changed[10] = changed[10]! ^ 1;
  assert.throws(() => decodePriceArchive({ ...chunk, payload: changed }), /checksum/);
  assert.throws(() => decodePriceArchive({ ...chunk, lastEventId: 2n }), /bounds/);
  assert.throws(() => decodePriceArchive({ ...chunk, eventCount: 2 }), /envelope/);
  const payload = gzipSync(
    JSON.stringify({
      version: 1,
      symbol: "BTCUSDT",
      events: [["1", "key", "-1", at.toISOString(), at.toISOString(), "same"]],
    }),
  );
  assert.throws(
    () =>
      decodePriceArchive({
        ...chunk,
        payload,
        sha256: createHash("sha256").update(payload).digest("hex"),
      }),
    /event/,
  );
});
test("archive rejects duplicate/out-of-order IDs and mixed symbols", async () => {
  await assert.rejects(encodePriceArchive([event(2n), event(1n)]), /order/);
  await assert.rejects(encodePriceArchive([event(1n), event(1n)]), /order/);
  await assert.rejects(
    encodePriceArchive([event(1n), { ...event(2n), symbol: "ETHUSDT" }]),
    /symbol/,
  );
});
test("trace hashes survive JSONB key ordering and detect changes in nested policy", () => {
  assert.equal(
    hashTracePayload({ b: [1, { d: 2, c: 3 }], a: null }),
    hashTracePayload({ a: null, b: [1, { c: 3, d: 2 }] }),
  );
  assert.notEqual(hashTracePayload({ policy: { r: 0.5 } }), hashTracePayload({ policy: { r: 1 } }));
});
