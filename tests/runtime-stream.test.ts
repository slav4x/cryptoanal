import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createRequire } from "node:module";
import type * as WsTypes from "../packages/exchange-bybit/node_modules/@types/ws/index";
const { WebSocketServer } = createRequire(
  new URL("../packages/exchange-bybit/package.json", import.meta.url),
)("ws") as typeof WsTypes;
import {
  BybitPublicStreamClient,
  type BybitPublicTrade,
  type BybitPublicStreamHandlers,
} from "../packages/exchange-bybit/src/index";

test(
  "public trade stream preserves all same-sequence trades and reconnects after rejection",
  { timeout: 5000 },
  async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const abort = new AbortController();
    const prices: string[] = [];
    const errors: string[] = [];
    let connections = 0;
    let resolveTrades!: () => void;
    const received = new Promise<void>((resolve) => {
      resolveTrades = resolve;
    });
    server.on("connection", (socket) => {
      connections++;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { op: string; args: string[] };
        if (message.op !== "subscribe") return;
        assert.deepEqual(message.args, ["publicTrade.BTCUSDT"]);
        if (connections === 1) {
          socket.send(JSON.stringify({ op: "subscribe", success: false }));
          return;
        }
        socket.send(JSON.stringify({ op: "subscribe", success: true }));
        socket.send(
          JSON.stringify({
            topic: "publicTrade.BTCUSDT",
            data: [
              {
                T: Date.now(),
                s: "BTCUSDT",
                p: "97",
                i: "trade-1",
                seq: 123,
                S: "Buy",
                v: "0.001",
              },
              {
                T: Date.now(),
                s: "BTCUSDT",
                p: "100",
                i: "trade-2",
                seq: 123,
                S: "Sell",
                v: "0.002",
              },
            ],
          }),
        );
      });
    });
    const running = new BybitPublicStreamClient(`ws://127.0.0.1:${address.port}`, 1000, 10).run(
      {
        getSubscriptions: async () => ({
          tickerSymbols: [],
          tradeSymbols: ["BTCUSDT"],
          klines: [],
        }),
        onQuote: () => {},
        onClosedCandle: () => {},
        onError: (error) => {
          errors.push(error.message);
        },
        onTrade: (trade) => {
          prices.push(trade.price);
          if (prices.length === 2) resolveTrades();
        },
      },
      abort.signal,
    );
    try {
      await received;
      assert.deepEqual(prices, ["97", "100"]);
      assert.equal(connections, 2);
      assert.ok(errors.includes("Bybit subscription rejected"));
    } finally {
      abort.abort();
      for (const client of server.clients) client.terminate();
      await running;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test(
  "trade callbacks preserve volume and causal books; reconnect discards previous book",
  { timeout: 5000 },
  async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const abort = new AbortController();
    const trades: BybitPublicTrade[] = [],
      errors: string[] = [];
    let connections = 0,
      done!: () => void;
    const received = new Promise<void>((resolve) => {
      done = resolve;
    });
    server.on("connection", (socket) => {
      const connection = ++connections;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { op: string; args: string[] };
        if (message.op !== "subscribe") return;
        assert.deepEqual(message.args, ["publicTrade.BTCUSDT", "orderbook.1.BTCUSDT"]);
        const at = Date.now() - 100;
        const book = (cts: number, u: number) => ({
          topic: "orderbook.1.BTCUSDT",
          type: "snapshot",
          ts: cts + 1,
          cts,
          data: { s: "BTCUSDT", b: [["99", "2"]], a: [["101", "3"]], u, seq: u },
        });
        const trade = (T: number, i: string) => ({
          topic: "publicTrade.BTCUSDT",
          data: [
            {
              T,
              s: "BTCUSDT",
              p: "100",
              S: "Sell",
              v: "0.123456789012345678",
              i,
              BT: false,
              RPI: true,
            },
          ],
        });
        if (connection === 1) {
          socket.send(JSON.stringify(book(at, 100)));
          socket.send(JSON.stringify(book(at + 50, 105)));
          socket.send(JSON.stringify(trade(at + 25, "first")));
          const invalid = trade(at + 75, "invalid");
          invalid.data[0]!.v = "0";
          socket.send(JSON.stringify(invalid));
        } else {
          socket.send(JSON.stringify(trade(at + 25, "after-reconnect")));
          socket.send(JSON.stringify(book(at + 50, 2)));
          socket.send(JSON.stringify(trade(at + 75, "after-book")));
        }
      });
    });
    const running = new BybitPublicStreamClient(`ws://127.0.0.1:${address.port}`, 1000, 10).run(
      {
        getSubscriptions: async () => ({
          tickerSymbols: [],
          tradeSymbols: ["BTCUSDT"],
          orderbookSymbols: ["BTCUSDT"],
          klines: [],
        }),
        onQuote: () => {},
        onClosedCandle: () => {},
        onTrade: (trade) => {
          trades.push(trade);
          if (trades.length === 3) done();
        },
        onError: (error) => {
          errors.push(error.message);
        },
      },
      abort.signal,
    );
    try {
      await received;
      assert.equal(connections, 2);
      assert.deepEqual(
        trades.map((trade) => trade.tradeId),
        ["first", "after-reconnect", "after-book"],
      );
      assert.equal(trades[0]!.book!.updateId, "100");
      assert.equal(trades[1]!.book, null);
      assert.equal(trades[2]!.book!.updateId, "2");
      for (const trade of trades) {
        assert.equal(trade.quantity, "0.123456789012345678");
        assert.equal(trade.takerSide, "Sell");
        assert.equal(trade.blockTrade, false);
        assert.equal(trade.rpiTrade, true);
        assert.ok(trade.receivedAt instanceof Date);
        if (trade.book) {
          assert.ok(trade.book.observedAt <= trade.observedAt);
          assert.ok(trade.book.receivedAt <= trade.receivedAt);
        }
      }
      assert.ok(errors.includes("Bybit stream returned invalid trade data"));
    } finally {
      abort.abort();
      for (const client of server.clients) client.terminate();
      await running;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test(
  "removed book subscription cannot repopulate history from late messages",
  { timeout: 5000 },
  async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const abort = new AbortController();
    const trades: BybitPublicTrade[] = [];
    let calls = 0,
      resolveDone!: () => void;
    const received = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    server.on("connection", (socket) => {
      let subscriptions = 0;
      const at = Date.now() - 100;
      const book = {
        topic: "orderbook.1.BTCUSDT",
        type: "snapshot",
        ts: at + 1,
        cts: at,
        data: { s: "BTCUSDT", b: [["99", "2"]], a: [["101", "3"]], u: 2, seq: 2 },
      };
      const sendTrade = (i: string) =>
        socket.send(
          JSON.stringify({
            topic: "publicTrade.BTCUSDT",
            data: [{ T: at + 5, s: "BTCUSDT", p: "100", S: "Buy", v: "1", i }],
          }),
        );
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { op: string };
        if (message.op === "subscribe") {
          if (++subscriptions === 1) {
            socket.send(JSON.stringify(book));
            sendTrade("before-removal");
          } else sendTrade("after-addition");
        }
        if (message.op === "unsubscribe") {
          socket.send(JSON.stringify(book));
          sendTrade("after-removal");
        }
      });
    });
    const running = new BybitPublicStreamClient(`ws://127.0.0.1:${address.port}`, 20, 10).run(
      {
        getSubscriptions: async () => ({
          tickerSymbols: [],
          tradeSymbols: ["BTCUSDT"],
          orderbookSymbols: ++calls === 2 ? [] : ["BTCUSDT"],
          klines: [],
        }),
        onQuote: () => {},
        onClosedCandle: () => {},
        onTrade: (trade) => {
          trades.push(trade);
          if (trades.length === 3) resolveDone();
        },
      },
      abort.signal,
    );
    try {
      await received;
      assert.equal(trades[0]!.book!.updateId, "2");
      assert.equal(trades[1]!.book, null);
      assert.equal(trades[2]!.book, null);
    } finally {
      abort.abort();
      for (const socket of server.clients) socket.terminate();
      await running;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test(
  "unusable book invalidates liquidity without interrupting public trades",
  { timeout: 5000 },
  async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const abort = new AbortController();
    const trades: BybitPublicTrade[] = [];
    const errors: string[] = [],
      unavailable: string[] = [];
    const failures: Parameters<
      NonNullable<BybitPublicStreamHandlers["onOrderbookUnavailable"]>
    >[0][] = [];
    let connections = 0,
      done!: () => void;
    const received = new Promise<void>((resolve) => {
      done = resolve;
    });
    server.on("connection", (socket) => {
      connections++;
      socket.on("message", (raw) => {
        if ((JSON.parse(raw.toString()) as { op: string }).op !== "subscribe") return;
        const at = Date.now() - 100;
        const book = {
          topic: "orderbook.1.BTCUSDT",
          type: "snapshot",
          ts: at + 1,
          cts: at,
          data: { s: "BTCUSDT", b: [["99", "2"]], a: [["101", "3"]], u: 2, seq: 2 },
        };
        const sendTrade = (i: string) =>
          socket.send(
            JSON.stringify({
              topic: "publicTrade.BTCUSDT",
              data: [
                {
                  T: at + 5,
                  s: "BTCUSDT",
                  p: "100",
                  S: "Buy",
                  v: "1",
                  i,
                },
              ],
            }),
          );
        socket.send(JSON.stringify(book));
        sendTrade("before");
        const invalid = structuredClone(book);
        invalid.data.b[0]![1] = "1";
        socket.send(JSON.stringify(invalid));
        sendTrade("without-book");
        socket.send(JSON.stringify(book));
        sendTrade("restored");
      });
    });
    const running = new BybitPublicStreamClient(`ws://127.0.0.1:${address.port}`, 1000, 10).run(
      {
        getSubscriptions: async () => ({
          tickerSymbols: [],
          tradeSymbols: ["BTCUSDT"],
          orderbookSymbols: ["BTCUSDT"],
          klines: [],
        }),
        onQuote: () => {},
        onClosedCandle: () => {},
        onError: (error) => {
          errors.push(error.message);
        },
        onOrderbookUnavailable: (failure) => {
          unavailable.push(failure.symbol);
          failures.push(failure);
        },
        onTrade: (trade) => {
          trades.push(trade);
          if (trades.length === 3) done();
        },
      },
      abort.signal,
    );
    try {
      await received;
      assert.equal(connections, 1);
      assert.deepEqual(errors, []);
      assert.deepEqual(unavailable, ["BTCUSDT"]);
      assert.ok(failures[0]!.error.cause instanceof Error);
      const continuity = failures[0]!.continuity!;
      assert.deepEqual(continuity.reasons, ["changed-without-update"]);
      assert.deepEqual(continuity.previous.bid, ["99", "2"]);
      assert.deepEqual(continuity.current.data.b, [["99", "1"]]);
      assert.equal(continuity.previous.updateId, String(continuity.current.data.u));
      assert.ok(continuity.previous.receivedAt <= continuity.current.receivedAt);
      assert.ok(trades[0]!.book);
      assert.equal(trades[1]!.book, null);
      assert.ok(trades[2]!.book);
    } finally {
      abort.abort();
      for (const socket of server.clients) socket.terminate();
      await running;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
