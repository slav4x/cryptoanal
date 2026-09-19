import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createRequire } from "node:module";
import type * as WsTypes from "../packages/exchange-bybit/node_modules/@types/ws/index";
const { WebSocketServer } = createRequire(
  new URL("../packages/exchange-bybit/package.json", import.meta.url),
)("ws") as typeof WsTypes;
import { BybitPublicStreamClient } from "../packages/exchange-bybit/src/index";

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
              { T: Date.now(), s: "BTCUSDT", p: "97", i: "trade-1", seq: 123 },
              { T: Date.now(), s: "BTCUSDT", p: "100", i: "trade-2", seq: 123 },
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
