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
