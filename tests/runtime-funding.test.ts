import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  fundingAmount,
  fundingExposure,
  allocateFunding,
  enabledFundingPolicy,
  validateFundingDataset,
  advanceFundedCandle,
  type ExecutionFundingDataset,
} from "../packages/application/src/execution-funding";
import {
  runValidationEngine,
  runRuntimeReplay,
  executionBreakEvenPrice,
  settleExecutionPosition,
  type ExecutionPosition,
} from "../packages/application/src/index";
import { BybitPublicMarketClient } from "../packages/exchange-bybit/src/index";
const at = "2026-01-02T08:00:00.000Z";
const event = {
  symbol: "BTCUSDT",
  settledAt: at,
  rate: "0.001",
  markPrice: "100",
  markInterval: "60" as const,
};
const config = strategyConfigSchema.parse(fixture.config);
const position: ExecutionPosition = {
  symbol: "BTCUSDT",
  side: "long",
  openedAt: new Date("2026-01-02T07:00:00Z"),
  quantity: 3,
  entryPrice: 100,
  entryFee: 0.18,
  entrySlippage: 0,
  entryRegime: "neutral",
  entrySession: "us",
  stopPrice: 90,
  takePrice: 150,
  bestPrice: 100,
  trailingPrice: null,
};
const dataset = (events: ExecutionFundingDataset["events"] = [event]): ExecutionFundingDataset => ({
  version: 1,
  policy: enabledFundingPolicy,
  symbols: ["BTCUSDT"],
  startsAt: "2026-01-01T00:00:00.000Z",
  throughAt: "2026-02-01T00:00:00.000Z",
  coverage: "complete",
  events,
});
test("funding debits and credits both sides, exact 18 places and final allocation residual", () => {
  assert.equal(fundingAmount("long", "3", event), "0.3");
  assert.equal(fundingAmount("short", "3", event), "-0.3");
  assert.equal(fundingAmount("long", "3", { ...event, rate: "-0.001" }), "-0.3");
  assert.equal(fundingAmount("short", "3", { ...event, rate: "-0.001" }), "0.3");
  assert.equal(fundingAmount("long", "0.000000000000000001", { ...event, rate: "0.000001" }), "0");
  assert.equal(allocateFunding("-1", "1", "3"), "-0.333333333333333333");
  assert.equal(allocateFunding("-0.666666666666666667", "2", "2"), "-0.666666666666666667");
  assert.throws(() => allocateFunding("1", "4", "3"));
});
test("funding boundary excludes same-time entry, includes same-time exit, uses partial volume", () => {
  const basis = {
    quantity: "3",
    openedAt: "2026-01-02T07:00:00Z",
    exits: [
      { quantity: "1", filledAt: "2026-01-02T07:59:59Z" },
      { quantity: "1", filledAt: at },
    ],
  };
  assert.equal(fundingExposure(basis, at), "2");
  assert.equal(fundingExposure({ ...basis, openedAt: at, exits: [] }, at), "0");
  assert.equal(
    fundingExposure(
      { ...basis, exits: [...basis.exits, { quantity: "1", filledAt: "2026-01-02T08:00:01Z" }] },
      "2026-01-02T09:00:00Z",
    ),
    "0",
  );
});
test("funding coverage rejects missing symbols, dates, duplicates and invalid mark", () => {
  for (const data of [
    dataset([event, event]),
    { ...dataset(), symbols: ["ETHUSDT"] },
    dataset([{ ...event, markPrice: "0" }]),
    { ...dataset(), throughAt: "2026-01-01T00:00:00Z" },
  ])
    assert.throws(() => validateFundingDataset(data, ["BTCUSDT"], new Date(at), new Date(at)));
});
test("break-even and final PnL include signed funding", () => {
  const funded = { ...position, fundingPaid: 0.3 };
  const baseline = settleExecutionPosition(position, 101, new Date(at), "manual", config),
    paid = settleExecutionPosition(funded, 101, new Date(at), "manual", config);
  assert.ok(Math.abs(baseline.netPnl - paid.netPnl - 0.3) < 1e-8);
  assert.equal(paid.funding, 0.3);
  assert.ok(executionBreakEvenPrice(funded, config) > executionBreakEvenPrice(position, config));
  assert.ok(
    executionBreakEvenPrice({ ...funded, side: "short" }, config) <
      executionBreakEvenPrice({ ...position, side: "short" }, config),
  );
});
test("candle funding uses recorded exit timestamp and does not charge after early stop", () => {
  const candle = {
    symbol: "BTCUSDT",
    openTime: new Date("2026-01-02T07:45:00Z"),
    open: 100,
    high: 101,
    low: 80,
    close: 100,
    turnover: 1000,
  } as Parameters<typeof advanceFundedCandle>[1];
  const early = advanceFundedCandle(position, candle, config, dataset());
  assert.equal(early.settlement!.funding, 0);
  assert.deepEqual(early.charges, []);
  const holding = advanceFundedCandle(position, { ...candle, low: 99 }, config, dataset());
  assert.equal(holding.position.fundingPaid, 0.3);
  const again = advanceFundedCandle(
    holding.position,
    { ...candle, openTime: new Date(at), low: 99 },
    config,
    dataset(),
  );
  assert.deepEqual(again.charges, []);
});
test("validation and candle replay share funded trades and equity without double debit", () => {
  const candles = fixture.candles.map((c) => ({ ...c, openTime: new Date(c.openTime) }));
  const startsAt = candles[0]!.openTime.toISOString(),
    throughAt = new Date(+candles.at(-1)!.openTime + 900000).toISOString();
  const events = candles.map((c) => ({
    ...event,
    settledAt: c.openTime.toISOString(),
    markInterval: "1" as const,
    rate: "0.0002",
  }));
  const funding = { ...dataset(events), startsAt, throughAt };
  const input = { config, candles, initialCapital: 10000, funding };
  const a = runValidationEngine({ ...input, kind: "backtest", walkForward: null }),
    b = runRuntimeReplay(input);
  assert.deepEqual(a.trades, b.trades);
  assert.ok(a.trades.some((t) => t.funding !== 0));
  assert.equal(a.metrics.totalFunding, b.metrics.totalFunding);
  assert.ok(Math.abs(b.metrics.endingEquity - (10000 + a.metrics.netPnl)) < 0.00000002);
  assert.equal(a.metrics.equitySeries.at(-1)!.equity, b.metrics.endingEquity);
  assert.throws(
    () => runRuntimeReplay({ ...input, funding: { ...funding, throughAt: startsAt } }),
    /coverage/,
  );
});
test("public funding loader pins rate and matching mark open, rejects unavailable mark or source", async (t) => {
  let missing = false,
    invalid = false;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    const u = new URL(String(url));
    requests.push(u.pathname);
    return Response.json(
      invalid
        ? { retCode: 10006, retMsg: "limited", result: {} }
        : {
            retCode: 0,
            retMsg: "OK",
            time: Date.now(),
            result: u.pathname.includes("funding")
              ? {
                  category: "linear",
                  list: [
                    {
                      symbol: "BTCUSDT",
                      fundingRate: "0.001",
                      fundingRateTimestamp: String(Date.parse(at)),
                    },
                  ],
                }
              : {
                  category: "linear",
                  symbol: "BTCUSDT",
                  list: missing ? [] : [[String(Date.parse(at)), "100", "101", "99", "100"]],
                },
          },
    );
  });
  const client = new BybitPublicMarketClient("https://example.invalid");
  const load = () =>
    client.getLinearFundingHistory(
      "BTCUSDT",
      new Date("2026-01-02T07:00:00Z"),
      new Date("2026-01-02T09:00:00Z"),
    );
  assert.deepEqual(await load(), [event]);
  assert.ok(requests.includes("/v5/market/mark-price-kline"));
  missing = true;
  await assert.rejects(load, /mark/i);
  invalid = true;
  await assert.rejects(load, /10006|limited/);
});

test("public funding pagination uses actual timestamps and never returns partial success", async (t) => {
  const start = Date.parse("2026-01-01T00:00:00Z"),
    end = start + 200 * 3600000;
  let fail = false;
  const ends: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    const u = new URL(String(url));
    if (u.pathname.includes("funding")) {
      const through = Number(u.searchParams.get("endTime"));
      ends.push(through);
      if (through < end && fail)
        return Response.json({ retCode: 10006, retMsg: "limited", result: {} });
      const list = Array.from({ length: through === end ? 200 : 1 }, (_, index) => ({
        symbol: "BTCUSDT",
        fundingRate: "0.001",
        fundingRateTimestamp: String(through === end ? end - index * 3600000 : start),
      }));
      return Response.json({
        retCode: 0,
        retMsg: "OK",
        time: Date.now(),
        result: { category: "linear", list },
      });
    }
    const list = Array.from({ length: 201 }, (_, i) => [
      String(end - i * 3600000),
      "100",
      "101",
      "99",
      "100",
    ]);
    return Response.json({
      retCode: 0,
      retMsg: "OK",
      result: { category: "linear", symbol: "BTCUSDT", list },
    });
  });
  const client = new BybitPublicMarketClient("https://example.invalid"),
    load = () => client.getLinearFundingHistory("BTCUSDT", new Date(start), new Date(end));
  const events = await load();
  assert.equal(events.length, 201);
  assert.equal(events[0]!.settledAt, new Date(start).toISOString());
  assert.equal(ends[1], start + 3600000 - 1);
  fail = true;
  await assert.rejects(load, /limited/);
});
test("empty confirmed funding history does not request invented mark prices", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({
      retCode: 0,
      retMsg: "OK",
      time: Date.now(),
      result: { category: "linear", list: [] },
    });
  });
  assert.deepEqual(
    await new BybitPublicMarketClient("https://example.invalid").getLinearFundingHistory(
      "BTCUSDT",
      new Date(at),
      new Date(at),
    ),
    [],
  );
  assert.equal(requests, 1);
});
test("funding on variable minute boundary uses a minute mark and rejects another symbol", async (t) => {
  const settledAt = Date.parse("2026-01-02T08:05:00Z");
  let wrong = false;
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    const u = new URL(String(url));
    if (u.pathname.includes("funding"))
      return Response.json({
        retCode: 0,
        retMsg: "OK",
        time: Date.now(),
        result: {
          category: "linear",
          list: [
            {
              symbol: wrong ? "ETHUSDT" : "BTCUSDT",
              fundingRate: "-0.001",
              fundingRateTimestamp: String(settledAt),
            },
          ],
        },
      });
    assert.equal(u.searchParams.get("interval"), "1");
    return Response.json({
      retCode: 0,
      retMsg: "OK",
      result: {
        category: "linear",
        symbol: "BTCUSDT",
        list: [[String(settledAt), "100", "101", "99", "100"]],
      },
    });
  });
  const client = new BybitPublicMarketClient("https://example.invalid"),
    load = () =>
      client.getLinearFundingHistory("BTCUSDT", new Date(settledAt - 60000), new Date(settledAt));
  assert.equal((await load())[0]!.markInterval, "1");
  wrong = true;
  await assert.rejects(load, /Invalid funding history/);
});
