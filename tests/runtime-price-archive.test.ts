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
import {
  readExecutionMarketData,
  type StoredExecutionMarketData,
} from "../packages/application/src/execution-market-data";

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

test("archive v2 preserves book provenance and liquidity; v1 remains readable without inventing data", async () => {
  const executionData: StoredExecutionMarketData = [
    1,
    "0.123456789012345678",
    "Sell",
    false,
    null,
    [
      "100.000000000000000001",
      "2.123456789012345678",
      "100.000000000000000002",
      "3",
      +at - 1,
      +at,
      "9007199254740993",
      "9007199254740994",
    ],
  ];
  const events = [
    { ...event(1n), executionData },
    { ...event(2n), executionData: [1, "1", "Buy", null, true, null] as StoredExecutionMarketData },
    event(3n),
  ];
  const chunk = await encodePriceArchive(events);
  assert.deepEqual(decodePriceArchive(chunk), events);
  assert.equal(
    readExecutionMarketData(decodePriceArchive(chunk)[0]!.executionData).book!.bid[1],
    "2.123456789012345678",
  );
  const old = event(4n);
  const payload = gzipSync(
    JSON.stringify({
      version: 1,
      symbol: old.symbol,
      events: [
        [
          String(old.id),
          old.eventKey,
          old.price,
          old.observedAt.toISOString(),
          old.receivedAt.toISOString(),
          old.streamId,
        ],
      ],
    }),
  );
  assert.deepEqual(
    decodePriceArchive({
      ...chunk,
      payload,
      firstEventId: 4n,
      lastEventId: 4n,
      eventCount: 1,
      sha256: createHash("sha256").update(payload).digest("hex"),
    }),
    [old],
  );
  const noncausal = structuredClone(executionData);
  noncausal[5]![4] = +at + 1;
  await assert.rejects(
    encodePriceArchive([{ ...event(1n), executionData: noncausal }]),
    /Non-causal/,
  );
});
