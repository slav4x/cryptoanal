import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BybitPublicMarketClient,
  BybitPublicRequestError,
} from "../packages/exchange-bybit/src/index";
import { RecoveryRequestCache } from "../apps/worker/src/recovery-request-cache";

const klineResult = {
  category: "linear",
  symbol: "BTCUSDT",
  list: [["1767225600000", "100", "101", "99", "100", "1", "100"]],
};

test("recent public trade recovery is capped, abortable and validates every source record", async (t) => {
  let trades = [
    {
      execId: "anchor",
      symbol: "BTCUSDT",
      price: "100",
      size: "1",
      side: "Buy",
      time: "1767225600000",
    },
  ];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(url.pathname, "/v5/market/recent-trade");
    assert.equal(url.searchParams.get("limit"), "1000");
    assert.ok(init.signal);
    return Response.json({
      retCode: 0,
      retMsg: "OK",
      time: 1767225601000,
      result: { category: "linear", list: trades },
    });
  });
  const client = new BybitPublicMarketClient("https://example.invalid");
  assert.equal((await client.getLinearRecentTrades("BTCUSDT")).trades[0]!.tradeId, "anchor");
  trades = [{ ...trades[0]!, symbol: "ETHUSDT" }];
  await assert.rejects(client.getLinearRecentTrades("BTCUSDT"), /Invalid recent/);
  trades = [{ ...trades[0]!, symbol: "BTCUSDT", time: "1767225609000" }];
  await assert.rejects(client.getLinearRecentTrades("BTCUSDT"), /Invalid recent/);
  trades = [{ ...trades[0]!, time: "1767225600000", price: "0" }];
  await assert.rejects(client.getLinearRecentTrades("BTCUSDT"), /Invalid recent/);
});

for (const endpoint of ["kline", "tickers", "instruments"] as const) {
  test(`Bybit ${endpoint} preserves API rejection before parsing result`, async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({ retCode: 10006, retMsg: "Too many visits!", result: {} }),
    );
    const client = new BybitPublicMarketClient("https://example.invalid");
    const request = () =>
      endpoint === "kline"
        ? client.getLinearKlines("BTCUSDT")
        : endpoint === "tickers"
          ? client.getLinearTickers()
          : client.getLinearInstruments();
    await assert.rejects(request, (error: unknown) => {
      assert.ok(error instanceof BybitPublicRequestError);
      assert.equal(error.endpoint, endpoint);
      assert.equal(error.retCode, 10006);
      assert.equal(error.retMsg, "Too many visits!");
      return true;
    });
  });
}

test("Bybit invalid envelopes and incomplete successes fail closed", async (t) => {
  let body: unknown = { retCode: "0", retMsg: "OK", result: klineResult };
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const client = new BybitPublicMarketClient("https://example.invalid");
  await assert.rejects(client.getLinearKlines("BTCUSDT"), /invalid response envelope/);
  body = { retCode: 0, retMsg: "OK", result: {} };
  await assert.rejects(client.getLinearKlines("BTCUSDT"), /invalid success payload/);
});

test("Bybit instrument metadata preserves price ranges and separate limit/market maximum sizes", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      retCode: 0,
      retMsg: "OK",
      result: {
        category: "linear",
        nextPageCursor: "",
        list: [
          {
            symbol: "BTCUSDT",
            contractType: "LinearPerpetual",
            status: "Trading",
            baseCoin: "BTC",
            quoteCoin: "USDT",
            settleCoin: "USDT",
            priceFilter: { tickSize: "0.1", minPrice: "0.1", maxPrice: "1999999.8" },
            lotSizeFilter: {
              qtyStep: "0.001",
              minOrderQty: "0.001",
              minNotionalValue: "5",
              maxOrderQty: "100",
              maxMktOrderQty: "20",
            },
          },
        ],
      },
    }),
  );
  const [instrument] = await new BybitPublicMarketClient(
    "https://example.invalid",
  ).getLinearInstruments();
  assert.equal(instrument?.maxOrderQty, "100");
  assert.equal(instrument?.maxMarketOrderQty, "20");
  assert.equal(instrument?.minPrice, "0.1");
  assert.equal(instrument?.maxPrice, "1999999.8");
});

test("Bybit cannot feed another symbol or category into requested candle history", async (t) => {
  let result = { ...klineResult, symbol: "ETHUSDT" };
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ retCode: 0, retMsg: "OK", result }),
  );
  const client = new BybitPublicMarketClient("https://example.invalid");
  await assert.rejects(client.getLinearKlines("BTCUSDT"), /unexpected symbol/);
  result = { ...klineResult, category: "spot" };
  await assert.rejects(client.getLinearKlines("BTCUSDT"), /unexpected market category/);
});

test("Bybit range failure never returns partial history; recovery retries after backoff", async (t) => {
  let now = 0;
  let requests = 0;
  let recovered = false;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    if (requests === 1) {
      return Response.json({
        retCode: 0,
        retMsg: "OK",
        result: {
          ...klineResult,
          list: Array.from({ length: 1000 }, (_, index) => [
            String(1767225600000 + (2000 - index) * 60_000),
            "100",
            "101",
            "99",
            "100",
            "1",
            "100",
          ]),
        },
      });
    }
    if (!recovered) return Response.json({ retCode: 10000, retMsg: "Server Timeout", result: {} });
    return Response.json({ retCode: 0, retMsg: "OK", result: klineResult });
  });
  const client = new BybitPublicMarketClient("https://example.invalid");
  const cache = new RecoveryRequestCache<Awaited<ReturnType<typeof client.getLinearKlinesRange>>>(
    () => now,
  );
  const load = () =>
    client.getLinearKlinesRange(
      "BTCUSDT",
      "1",
      new Date(1767225600000),
      new Date(1767225600000 + 2000 * 60_000),
    );
  await assert.rejects(cache.get("BTCUSDT:history", load), BybitPublicRequestError);
  assert.equal(requests, 2);
  await assert.rejects(cache.get("BTCUSDT:history", load), BybitPublicRequestError);
  assert.equal(requests, 2);
  now = 2000;
  recovered = true;
  const candles = await cache.get("BTCUSDT:history", load);
  assert.equal(requests, 3);
  assert.equal(candles.length, 1);
  assert.equal(candles[0]?.symbol, "BTCUSDT");
});
