import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  executionStopRisk,
  remainingExecutionStopBudget,
  enrichExecutionCandles,
  limitExecutionPositionRisk,
  openExecutionPosition,
  openExecutionPositionAtQuote,
  settleExecutionPosition,
} from "../packages/application/src/index";

const baseConfig = strategyConfigSchema.parse(fixture.config);
const at = new Date("2026-10-04T17:00:00Z");
const enriched = enrichExecutionCandles(
  fixture.candles.map((candle) => ({ ...candle, openTime: new Date(candle.openTime) })),
  baseConfig,
).at(-1)!;

for (const side of ["long", "short"] as const) {
  for (const orderType of ["market", "limit"] as const) {
    for (const costs of [
      { makerFeeBps: 0, takerFeeBps: 0, slippageBps: 0 },
      { makerFeeBps: 2, takerFeeBps: 6, slippageBps: 5 },
      { makerFeeBps: 8, takerFeeBps: 30, slippageBps: 20 },
    ]) {
      test(`${side} ${orderType}: candle/quote size shares stop and exposure budget (${JSON.stringify(costs)})`, () => {
        const config = {
          ...baseConfig,
          costs,
          entry: { orderType, limitOffsetBps: 0 },
        };
        const signal = { side, signalPrice: 100 };
        for (const maximumNotional of [10_000, 300]) {
          const candle = {
            ...enriched,
            openTime: at,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
          };
          const historical = openExecutionPosition(signal, candle, 10_000, maximumNotional, config);
          const realtime = openExecutionPositionAtQuote(
            signal,
            { symbol: candle.symbol, price: candle.open, observedAt: at },
            historical!.entryRegime,
            10_000,
            maximumNotional,
            config,
          );
          assert.ok(historical);
          assert.ok(realtime);
          assert.deepEqual(realtime, historical);
          const stopped = settleExecutionPosition(
            realtime,
            realtime.stopPrice,
            at,
            "stop-loss",
            config,
          );
          assert.ok(-stopped.netPnl <= 100 + 1e-8);
          assert.ok(
            realtime.quantity * realtime.entryPrice + realtime.entryFee <= maximumNotional + 1e-8,
          );
          const expectedUnitLoss =
            (side === "long" ? 1 : -1) * (realtime.entryPrice - stopped.exitPrice) +
            realtime.entryFee / realtime.quantity +
            (stopped.exitPrice * costs.takerFeeBps) / 10_000;
          const expected = Math.min(
            100 / expectedUnitLoss,
            maximumNotional / (realtime.entryPrice + realtime.entryFee / realtime.quantity),
          );
          assert.ok(Math.abs(realtime.quantity - expected) < 1e-6);
          assert.deepEqual(
            limitExecutionPositionRisk(realtime, 10_000, maximumNotional, config),
            realtime,
          );
          const smaller = limitExecutionPositionRisk(realtime, 5_000, maximumNotional / 2, config);
          assert.ok(smaller);
          assert.ok(smaller.quantity <= realtime.quantity / 2 + 1e-8);
          assert.ok(
            -settleExecutionPosition(smaller, smaller.stopPrice, at, "stop-loss", config).netPnl <=
              50 + 1e-8,
          );
        }
      });
    }
  }
}

test("sizing rejects exhausted and invalid capital before either entry path", () => {
  const candle = { ...enriched, openTime: at, open: 100, high: 101, low: 99, close: 100 };
  const signal = { side: "long" as const, signalPrice: 100 };
  for (const [equity, maximumNotional] of [
    [0, 10_000],
    [-1, 10_000],
    [10_000, 0],
    [10_000, -1],
    [NaN, 10_000],
    [Infinity, 10_000],
    [10_000, Infinity],
  ]) {
    assert.equal(
      openExecutionPosition(signal, candle, equity!, maximumNotional!, baseConfig),
      null,
    );
    assert.equal(
      openExecutionPositionAtQuote(
        signal,
        { symbol: candle.symbol, price: 100, observedAt: at },
        "neutral",
        equity!,
        maximumNotional!,
        baseConfig,
      ),
      null,
    );
  }
});

test("aggregate stop budget caps sizing before admission, including both fees", () => {
  for (const side of ["long", "short"] as const) {
    const original = openExecutionPositionAtQuote(
      { side, signalPrice: 100 },
      { symbol: "BTCUSDT", price: 100, observedAt: at },
      "neutral",
      10_000,
      10_000,
      baseConfig,
    )!;
    const limited = limitExecutionPositionRisk(original, 10_000, 10_000, baseConfig, 30)!;
    assert.ok(limited.quantity < original.quantity);
    assert.ok(
      -settleExecutionPosition(limited, limited.stopPrice, at, "stop-loss", baseConfig).netPnl <=
        30 + 1e-8,
    );
    assert.equal(limitExecutionPositionRisk(original, 10_000, 10_000, baseConfig, 0), null);
    assert.equal(limitExecutionPositionRisk(original, 10_000, 10_000, baseConfig, NaN), null);
    const loss = executionStopRisk({
      side,
      entryPrice: limited.entryPrice,
      stopPrice: limited.stopPrice,
      quantity: limited.quantity,
      entryFee: limited.entryFee,
      ...baseConfig.costs,
    });
    assert.ok(loss !== null && Math.abs(loss - 30) < 1e-8);
  }
});

test("remaining stop budget cannot spend exhausted daily allowance or capital", () => {
  const budget = {
    dailyLimit: 100,
    dailyPnl: -30,
    equityWithoutFloatingGains: 1000,
    reservedStopRisk: 50,
  };
  assert.equal(remainingExecutionStopBudget(budget), 20);
  assert.equal(remainingExecutionStopBudget({ ...budget, dailyPnl: -100 }), 0);
  assert.equal(remainingExecutionStopBudget({ ...budget, equityWithoutFloatingGains: 60 }), 10);
  assert.equal(remainingExecutionStopBudget({ ...budget, equityWithoutFloatingGains: 0 }), 0);
  assert.equal(remainingExecutionStopBudget({ ...budget, reservedStopRisk: Infinity }), 0);
  assert.equal(
    executionStopRisk({
      side: "long",
      entryPrice: 100,
      stopPrice: 98,
      quantity: 1,
      entryFee: 0,
      takerFeeBps: 0,
      slippageBps: 10000,
    }),
    null,
  );
});
