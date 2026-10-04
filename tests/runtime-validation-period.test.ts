import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import {
  minimumExecutionCandleCount,
  runValidationEngine,
  type ValidationEngineInput,
} from "../packages/application/src/index";
import {
  strategyConfigSchema,
  validationMetricsSummarySchema,
} from "../packages/contracts/src/index";

const config = strategyConfigSchema.parse(fixture.config);
const step = 900000;
const candles = fixture.candles.map((candle) => ({
  ...candle,
  openTime: new Date(candle.openTime),
}));
const input: ValidationEngineInput = {
  config,
  candles,
  initialCapital: 10000,
  kind: "backtest",
  walkForward: null,
};

function flatHistory(count: number, start = Date.UTC(2026, 0, 1)) {
  return Array.from({ length: count }, (_, index) => ({
    symbol: "BTCUSDT",
    openTime: new Date(start + index * step),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    turnover: 1000,
  }));
}

test("backtest excludes automatic warmup from counts and equity while preserving golden trades", () => {
  const result = runValidationEngine(input);
  const count = minimumExecutionCandleCount(config);
  assert.equal(result.metrics.candleCount, candles.length - count);
  assert.equal(result.metrics.evaluation.warmupCandleCount, count);
  assert.equal(result.metrics.evaluation.datasetCandleCount, candles.length);
  assert.equal(result.metrics.evaluation.excludedCandleCount, 0);
  assert.equal(result.metrics.equitySeries[0]!.observedAt, candles[count]!.openTime.toISOString());
  assert.equal(result.metrics.netPnl, fixture.expected.metrics.netPnl);
  assert.equal(result.trades.length, 3);
  assert.ok(
    result.metrics.equitySeries.every(
      (point) => Date.parse(point.observedAt) >= +candles[count]!.openTime,
    ),
  );
});

test("warmup alone is not an evaluated period or an equity sample", () => {
  const result = runValidationEngine({ ...input, candles: candles.slice(0, 80) });
  assert.equal(result.metrics.candleCount, 0);
  assert.equal(result.metrics.evaluation.warmupCandleCount, 80);
  assert.equal(result.metrics.evaluation.startsAt, null);
  assert.deepEqual(result.metrics.equitySeries, []);
  assert.equal(result.verdict, "failed");
});

test("explicit period excludes earlier trades and future candles from execution and end-of-data settlement", () => {
  const startsAt = candles[115]!.openTime;
  const endsAt = new Date(+candles[121]!.openTime + step - 1);
  const result = runValidationEngine({ ...input, evaluationPeriod: { startsAt, endsAt } });
  const truncated = runValidationEngine({
    ...input,
    candles: candles.slice(0, 122),
    evaluationPeriod: { startsAt, endsAt },
  });
  assert.deepEqual(result.trades, truncated.trades);
  assert.deepEqual(result.metrics.equitySeries, truncated.metrics.equitySeries);
  assert.equal(result.metrics.candleCount, 7);
  assert.equal(result.metrics.evaluation.warmupCandleCount, 115);
  assert.equal(result.metrics.evaluation.excludedCandleCount, 2);
  assert.ok(
    result.trades.every(
      (trade) => Date.parse(trade.openedAt) >= +startsAt && Date.parse(trade.closedAt) <= +endsAt,
    ),
  );
  assert.ok(
    result.metrics.equitySeries.every(
      (point) =>
        Date.parse(point.observedAt) >= +startsAt && Date.parse(point.observedAt) <= +endsAt,
    ),
  );
});

test("every symbol requires a complete continuous prefix for the explicit evaluation period", () => {
  const startsAt = candles[98]!.openTime;
  const endsAt = new Date(+candles.at(-1)!.openTime + step - 1);
  const second = candles.map((candle) => ({ ...candle, symbol: "ETHUSDT" }));
  const result = runValidationEngine({
    ...input,
    candles: [...candles, ...second],
    evaluationPeriod: { startsAt, endsAt },
  });
  assert.equal(result.metrics.candleCount, 52);
  assert.equal(result.metrics.evaluation.warmupCandleCount, 196);
  assert.throws(
    () =>
      runValidationEngine({
        ...input,
        candles: [...candles, ...second.filter((_, index) => index !== 4)],
        evaluationPeriod: { startsAt, endsAt },
      }),
    /Incomplete evaluation warmup for ETHUSDT/,
  );
  assert.throws(
    () =>
      runValidationEngine({ ...input, evaluationPeriod: { startsAt: endsAt, endsAt: startsAt } }),
    /Invalid validation evaluation period/,
  );
});

test("equity sampling starts at evaluation instead of depending on prefix length", () => {
  const history = flatHistory(300);
  const startsAt = history[105]!.openTime;
  const endsAt = new Date(+history.at(-1)!.openTime + step - 1);
  const full = runValidationEngine({
    ...input,
    candles: history,
    evaluationPeriod: { startsAt, endsAt },
  });
  const shorter = runValidationEngine({
    ...input,
    candles: history.slice(7),
    evaluationPeriod: { startsAt, endsAt },
  });
  assert.deepEqual(full.metrics.equitySeries, shorter.metrics.equitySeries);
  assert.equal(full.metrics.equitySeries[0]!.observedAt, startsAt.toISOString());
  assert.equal(Date.parse(full.metrics.equitySeries[1]!.observedAt), +startsAt + 96 * step);
});

test("walk-forward counts test windows once, excludes training and unused tail, and ignores prefix for window dates", () => {
  const warmup = minimumExecutionCandleCount(config);
  const start = Date.UTC(2026, 0, 1);
  const history = flatHistory(warmup + 16 * 96 + 48, start - warmup * step);
  const result = runValidationEngine({
    ...input,
    candles: history,
    kind: "walk-forward",
    walkForward: { trainingDays: 7, testDays: 3 },
    evaluationPeriod: { startsAt: new Date(start), endsAt: new Date(start + 16.5 * 86400000 - 1) },
  });
  assert.equal(result.metrics.windows, 3);
  assert.equal(result.metrics.candleCount, 9 * 96);
  assert.equal(result.metrics.evaluation.warmupCandleCount, warmup + 7 * 96);
  assert.equal(result.metrics.evaluation.excludedCandleCount, 48);
  assert.equal(result.metrics.evaluation.startsAt, new Date(start + 7 * 86400000).toISOString());
  assert.equal(result.metrics.evaluation.endsAt, new Date(start + 16 * 86400000).toISOString());
  assert.ok(
    result.metrics.equitySeries.every(
      (point) =>
        Date.parse(point.observedAt) >= start + 7 * 86400000 &&
        Date.parse(point.observedAt) < start + 16 * 86400000,
    ),
  );
});

test("walk-forward refuses an incomplete final test window instead of extending coverage by a day", () => {
  const result = runValidationEngine({
    ...input,
    candles: flatHistory(9 * 96 + 48),
    kind: "walk-forward",
    walkForward: { trainingDays: 7, testDays: 3 },
  });
  assert.equal(result.metrics.windows, 0);
  assert.equal(result.metrics.candleCount, 0);
  assert.deepEqual(result.metrics.equitySeries, []);
  assert.equal(result.verdict, "failed");
  const requestedLonger = runValidationEngine({
    ...input,
    candles: flatHistory(9 * 96 + 48),
    kind: "walk-forward",
    walkForward: { trainingDays: 7, testDays: 3 },
    evaluationPeriod: {
      startsAt: new Date(Date.UTC(2026, 0, 1)),
      endsAt: new Date(Date.UTC(2026, 1, 1)),
    },
  });
  assert.equal(requestedLonger.metrics.windows, 0);
  assert.throws(
    () =>
      runValidationEngine({
        ...input,
        kind: "walk-forward",
        walkForward: { trainingDays: 7, testDays: 0 },
      }),
    /Invalid walk-forward windows/,
  );
});

test("legacy metric summaries remain readable without evaluation metadata", () => {
  const { evaluation, ...metrics } = fixture.expected.metrics;
  assert.ok(evaluation);
  assert.equal(
    validationMetricsSummarySchema.parse({ ...metrics, gateReasons: [] }).evaluation,
    undefined,
  );
  const current = runValidationEngine(input);
  assert.deepEqual(
    validationMetricsSummarySchema.parse({ ...current.metrics, gateReasons: current.gateReasons })
      .evaluation,
    current.metrics.evaluation,
  );
});
