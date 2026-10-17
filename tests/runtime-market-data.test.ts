import assert from "node:assert/strict";
import { test } from "node:test";
import { BybitOrderBookCache } from "../packages/exchange-bybit/src/orderbook";
import heartbeats from "./fixtures/bybit-l1-heartbeats.json";
import {
  executionBookFailure,
  readExecutionMarketData,
  storeExecutionMarketData,
  type ExecutionMarketData,
} from "../packages/application/src/execution-market-data";

export function marketDataFixture(at = Date.parse("2026-10-15T00:00:00Z")): ExecutionMarketData {
  return {
    source: "bybit-public",
    depth: 1,
    trade: {
      quantity: "0.123456789012345678",
      takerSide: "Sell",
      blockTrade: false,
      rpiTrade: null,
    },
    book: {
      bid: ["100.000000000000000001", "0.123456789012345678"],
      ask: ["100.000000000000000002", "3"],
      observedAt: at - 1,
      receivedAt: at,
      updateId: "9007199254740993",
      sequence: "9007199254740994",
    },
  };
}
function snapshot(at: number, u = 2, seq = u) {
  return {
    topic: "orderbook.1.BTCUSDT",
    type: "snapshot",
    ts: at + 1,
    cts: at,
    data: { s: "BTCUSDT", u, seq, b: [["99", "2"]], a: [["101", "3"]] },
  };
}
test("book selection uses matching time and receive time without lookahead", () => {
  const books = new BybitOrderBookCache();
  books.apply(snapshot(100), new Date(110));
  books.apply(snapshot(200, 4), new Date(220));
  assert.equal(books.atTrade("BTCUSDT", new Date(99), new Date(230)), null);
  assert.equal(books.atTrade("ETHUSDT", new Date(250), new Date(230)), null);
  assert.equal(books.atTrade("BTCUSDT", new Date(150), new Date(230))!.updateId, "2");
  assert.equal(books.atTrade("BTCUSDT", new Date(250), new Date(210))!.updateId, "2");
  const chosen = books.atTrade("BTCUSDT", new Date(250), new Date(230))!;
  assert.equal(chosen.updateId, "4");
  chosen.bid[0] = "1";
  assert.equal(books.atTrade("BTCUSDT", new Date(250), new Date(230))!.bid[0], "99");
});
test("book snapshots allow skipped IDs and unchanged heartbeat, but reject regression", () => {
  const books = new BybitOrderBookCache();
  books.apply(snapshot(100, 100, 200), new Date(110));
  books.apply(snapshot(200, 105, 205), new Date(210));
  books.apply(snapshot(300, 105, 205), new Date(310));
  assert.equal(+books.atTrade("BTCUSDT", new Date(320), new Date(330))!.receivedAt, 310);
  books.apply(snapshot(301, 105, 206), new Date(311));
  assert.throws(() => books.apply(snapshot(302, 106, 205), new Date(320)), /regressed/);
  assert.throws(() => books.apply(snapshot(300, 106, 207), new Date(320)), /regressed/);
  assert.throws(() => books.apply(snapshot(301, 104, 206), new Date(320)), /regressed/);
  const changed = snapshot(302, 105, 206);
  changed.data.b[0]![1] = "1";
  assert.throws(() => books.apply(changed, new Date(320)), /without an update/);
});

test("captured L1 heartbeats may advance cross-sequence without changing update ID or liquidity", () => {
  for (const { previous, current, receivedAt } of heartbeats.pairs) {
    const books = new BybitOrderBookCache(),
      received = new Date(receivedAt);
    books.apply(previous, received);
    books.apply(current, received);
    const selected = books.atTrade(current.data.s, new Date(current.cts), received)!;
    assert.equal(selected.updateId, String(previous.data.u));
    assert.equal(selected.sequence, String(current.data.seq));
    assert.ok(current.data.seq > previous.data.seq);
    assert.deepEqual(selected.bid, previous.data.b[0]);
    assert.deepEqual(selected.ask, previous.data.a[0]);
    assert.equal(+selected.observedAt, current.cts);
    assert.equal(
      books.atTrade(current.data.s, new Date(previous.cts), received)!.sequence,
      String(previous.data.seq),
    );
  }
});
test("service restart, unsubscribe and empty snapshot invalidate former book history", () => {
  const books = new BybitOrderBookCache();
  books.apply(snapshot(100, 100, 200), new Date(110));
  books.apply(snapshot(200, 1, 1), new Date(210));
  assert.equal(books.atTrade("BTCUSDT", new Date(150), new Date(230)), null);
  assert.equal(books.atTrade("BTCUSDT", new Date(250), new Date(230))!.updateId, "1");
  books.remove("BTCUSDT");
  assert.equal(books.atTrade("BTCUSDT", new Date(250), new Date(230)), null);
  books.apply(snapshot(300, 2, 2), new Date(310));
  const empty = snapshot(400, 3, 3);
  empty.data.a = [];
  books.apply(empty, new Date(410));
  assert.equal(books.atTrade("BTCUSDT", new Date(450), new Date(430)), null);
});
test("book rejects crossed/zero quotes, delta, wrong symbol, unsafe IDs and future time", () => {
  const books = new BybitOrderBookCache();
  const crossed = snapshot(100);
  crossed.data.b[0]![0] = "101";
  assert.throws(() => books.apply(crossed, new Date(110)), /Crossed/);
  const zero = snapshot(100);
  zero.data.b[0]![1] = "0";
  assert.throws(() => books.apply(zero, new Date(110)));
  assert.throws(() => books.apply({ ...snapshot(100), type: "delta" }, new Date(110)));
  const mismatch = snapshot(100);
  mismatch.data.s = "ETHUSDT";
  assert.throws(() => books.apply(mismatch, new Date(110)), /topic/);
  assert.throws(() => books.apply(snapshot(100, Number.MAX_SAFE_INTEGER + 1), new Date(110)));
  assert.throws(() => books.apply(snapshot(2000), new Date(100)), /time/);
});
test("market data storage preserves decimals, unknown flags and large identifiers exactly", () => {
  const input = marketDataFixture();
  assert.deepEqual(
    readExecutionMarketData(JSON.parse(JSON.stringify(storeExecutionMarketData(input)))),
    input,
  );
  assert.deepEqual(
    readExecutionMarketData(storeExecutionMarketData({ ...input, book: null })).book,
    null,
  );
  for (const value of [
    null,
    [],
    [2, "1", "Buy", false, false, null],
    [1, "0", "Buy", false, false, null],
    [1, "1e-8", "Buy", false, false, null],
    [1, "1", "BUY", false, false, null],
    [1, "1", "Buy", undefined, false, null],
    [1, "1", "Buy", false, false, ["2", "1", "1", "1", 0, 0, "1", "1"]],
  ])
    assert.throws(() => readExecutionMarketData(value), /Invalid/);
});
test("book freshness checks both clocks and classifies absent data and future snapshots", () => {
  const at = 10000,
    data = marketDataFixture(at);
  const event = { observedAt: new Date(at + 999), receivedAt: new Date(at + 1000) };
  assert.equal(executionBookFailure(data, event, 1000), null);
  assert.equal(
    executionBookFailure(data, { ...event, receivedAt: new Date(at + 1001) }, 1000),
    "BOOK_STALE",
  );
  assert.equal(executionBookFailure({ ...data, book: null }, event, 1000), "BOOK_UNAVAILABLE");
  assert.equal(
    executionBookFailure(data, { ...event, receivedAt: new Date(at - 1) }, 1000),
    "BOOK_FROM_FUTURE",
  );
  assert.throws(() => executionBookFailure(data, event, -1), /policy/);
});
