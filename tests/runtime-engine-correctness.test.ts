import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  enrichExecutionCandles,
  evaluateExecutionExit,
  updateExecutionTrailing,
  updateExecutionTrailingAtPrice,
  settleExecutionPosition,
  runRuntimeReplay,
  runValidationEngine,
  getExecutionSignal,
  openExecutionPositionAtQuote,
  advanceExecutionCandlePosition,
  readExecutionProfitProtectionState,
  type ExecutionProfitProtectionState,
  type ExecutionPosition,
} from "../packages/application/src/index";
import {
  processRuntimePriceEvents,
  type RuntimePriceCheckpoint,
} from "../apps/worker/src/runtime-price-processor";
import { recoverRuntimeGap } from "../apps/worker/src/runtime-recovery";

const at = new Date("2026-10-14T00:00:00Z");
const config = strategyConfigSchema.parse({
  ...fixture.config,
  exit: {
    stopLossPercent: 3,
    takeProfitPercent: 9,
    trailingStopPercent: 1,
    trailingActivationR: 0.5,
    breakEvenActivationR: 0,
  },
});
const seed = enrichExecutionCandles(
  fixture.candles.map((c) => ({ ...c, openTime: new Date(c.openTime) })),
  config,
).at(-1)!;
function position(side: "long" | "short"): ExecutionPosition {
  return {
    symbol: "BTCUSDT",
    side,
    openedAt: at,
    entryPrice: 100,
    quantity: 10,
    stopPrice: side === "long" ? 97 : 103,
    takePrice: side === "long" ? 109 : 91,
    trailingPrice: null,
    bestPrice: 100,
    entryFee: 0.6,
    entrySlippage: 0,
    entryRegime: "neutral",
    entrySession: "asia",
  };
}

for (const side of ["long", "short"] as const) {
  test(`${side}: a close beyond the newly activated trailing exits within the same candle`, () => {
    const configured = { ...config, signal: { ...config.signal, direction: side } };
    const candles = fixture.candles.map((c) => ({ ...c, openTime: new Date(c.openTime) }));
    const enriched = enrichExecutionCandles(candles, configured);
    const index = enriched.findIndex((c) => getExecutionSignal(c, configured)?.side === side);
    assert.ok(index >= 0 && index + 1 < candles.length);
    const entry = getExecutionSignal(enriched[index]!, configured)!.signalPrice;
    const history = candles.slice(0, index + 2);
    history[index + 1] = {
      ...history[index + 1]!,
      open: entry,
      high: entry * (side === "long" ? 1.02 : 1.005),
      low: entry * (side === "long" ? 0.995 : 0.98),
      close: entry,
    };
    const replay = runRuntimeReplay({
      config: configured,
      candles: history,
      initialCapital: 10000,
    });
    const validation = runValidationEngine({
      config: configured,
      candles: history,
      initialCapital: 10000,
      kind: "backtest",
      walkForward: null,
    });
    assert.equal(replay.trades.length, 1);
    assert.equal(replay.trades[0]!.exitReason, "trailing-stop");
    assert.equal(
      replay.trades[0]!.closedAt,
      new Date(+history[index + 1]!.openTime + 900000).toISOString(),
    );
    assert.deepEqual(validation.trades, replay.trades);
  });

  test(`${side}: fees cannot place a newly activated break-even beyond the favorable peak`, () => {
    const expensive = {
      ...config,
      costs: { makerFeeBps: 100, takerFeeBps: 100, slippageBps: 500 },
      exit: { ...config.exit, trailingStopPercent: 0, breakEvenActivationR: 0.5 },
    };
    const p = position(side);
    const updated = updateExecutionTrailingAtPrice(p, side === "long" ? 102 : 98, expensive);
    assert.equal(updated.stopPrice, p.stopPrice);
    const enough = updateExecutionTrailingAtPrice(updated, side === "long" ? 110 : 90, expensive);
    assert.notEqual(enough.stopPrice, p.stopPrice);
    assert.ok(
      Math.abs(
        settleExecutionPosition(enough, enough.stopPrice, at, "stop-loss", expensive).netPnl,
      ) < 1e-8,
    );
  });
}

test("settlement preserves executable price and quantity precision for ledger reconciliation", () => {
  const p = { ...position("long"), entryPrice: 0.12345678901234, quantity: 123456.78901234 };
  const settled = settleExecutionPosition(p, 0.12456789123456, at, "manual", config);
  assert.equal(settled.entryPrice, p.entryPrice);
  assert.equal(settled.quantity, p.quantity);
  assert.ok(
    Math.abs((settled.exitPrice - settled.entryPrice) * settled.quantity - settled.grossPnl) < 1e-8,
  );
});

test("reconnect keeps unavailable reversals pending and exits only at an eligible journal quote", async () => {
  const intervalMs = 900000;
  const configured = {
    ...config,
    signal: { ...config.signal, family: "ema-crossover" as const },
    exit: { ...config.exit, trailingStopPercent: 0, exitOnSignalReversal: true },
  };
  const reversal = {
    ...seed,
    symbol: "BTCUSDT",
    openTime: at,
    open: 100,
    high: 100.1,
    low: 99.9,
    close: 100,
    emaFast: 99,
    emaSlow: 100,
    previousEmaFast: 101,
    previousEmaSlow: 100,
  };
  const signal = {
    candle: reversal,
    closedAt: new Date(+at + intervalMs),
    availableAt: new Date(+at + intervalMs + 2000),
  };
  const events = [100, 101].map((price, index) => ({
    id: BigInt(index + 1),
    symbol: "BTCUSDT",
    streamId: "new",
    price,
    observedAt: new Date(+at + intervalMs + 1000 + index * 2000),
    receivedAt: new Date(+at + intervalMs + 1000 + index * 2000),
  }));
  const checkpoints: RuntimePriceCheckpoint[] = [];
  await processRuntimePriceEvents({
    position: position("long"),
    through: new Date(+at + intervalMs - 60000),
    streamId: "old",
    events,
    config: configured,
    signalCandleAt: new Date(+at - intervalMs),
    signalIntervalMs: intervalMs,
    loadSignals: async () => [signal],
    recover: async (p, since, quote) =>
      recoverRuntimeGap({
        position: p,
        since,
        quote,
        minutes: [intervalMs - 60000, intervalMs].map((offset) => ({
          symbol: "BTCUSDT",
          openTime: new Date(+at + offset),
          open: 100,
          high: 100.1,
          low: 99.9,
          close: 100,
          turnover: 1,
        })),
        config: configured,
      }),
    checkpoint: async (state) => {
      checkpoints.push(state);
      return true;
    },
  });
  assert.equal(checkpoints.at(-1)!.event.id, 2n);
  assert.equal(checkpoints.at(-1)!.settlement!.exitReason, "signal-exit");
  assert.equal(checkpoints.at(-1)!.settlement!.closedAt, events[1]!.observedAt.toISOString());
  assert.equal(checkpoints.at(-1)!.signalExit!.availableAt, signal.availableAt.toISOString());
});

test("OHLC extrema alone cannot prove the order of a newly activated trailing touch", () => {
  const candle = {
    ...seed,
    symbol: "BTCUSDT",
    openTime: at,
    open: 100,
    high: 102,
    low: 99.5,
    close: 101.5,
  };
  assert.equal(evaluateExecutionExit(position("long"), candle, config), null);
  const updated = updateExecutionTrailing(position("long"), candle, config);
  assert.ok(updated.trailingPrice! > candle.low && updated.trailingPrice! < candle.close);
  assert.equal(advanceExecutionCandlePosition(position("long"), candle, config).settlement, null);
});

for (const side of ["long", "short"] as const) {
  test(`${side}: 12000 journal events produce the same first exit across batching and JSON restarts`, async () => {
    const configured = { ...config, exit: { ...config.exit, trailingStopPercent: 0 } };
    const policy = {
      enabledAt: at.toISOString(),
      breakEvenActivationR: 0.5,
      trailingActivationR: 1,
      trailingDistanceR: 0.5,
    };
    const events = Array.from({ length: 12000 }, (_, index) => ({
      id: BigInt(index + 1),
      symbol: "BTCUSDT",
      streamId: "same",
      observedAt: new Date(+at + index),
      receivedAt: new Date(+at + index),
      price:
        side === "long"
          ? index < 6000
            ? 100
            : index < 11000
              ? 104
              : index === 11000
                ? 102
                : 105
          : index < 6000
            ? 100
            : index < 11000
              ? 96
              : index === 11000
                ? 98
                : 95,
    }));
    async function replay(batchSize: number) {
      let p = position(side),
        through = at;
      let state: ExecutionProfitProtectionState | null = null;
      let last: RuntimePriceCheckpoint | null = null;
      for (let offset = 0; offset < events.length; offset += batchSize) {
        await processRuntimePriceEvents({
          position: p,
          through,
          streamId: "same",
          config: configured,
          profitProtection: { policy, state },
          events: events.slice(offset, offset + batchSize),
          recover: async () => {
            throw new Error("unexpected recovery");
          },
          checkpoint: async (checkpoint) => {
            last = checkpoint;
            p = {
              ...JSON.parse(JSON.stringify(checkpoint.position)),
              openedAt: new Date(checkpoint.position.openedAt),
            };
            through = new Date(checkpoint.through);
            state = readExecutionProfitProtectionState(
              JSON.parse(JSON.stringify(checkpoint.profitProtectionState)),
            );
            return true;
          },
        });
        if ((last as RuntimePriceCheckpoint | null)?.settlement) break;
      }
      return last as RuntimePriceCheckpoint | null;
    }
    const whole = await replay(12000);
    assert.ok(whole?.settlement);
    assert.equal(whole.event.id, 11001n);
    assert.equal(whole.settlement.exitReason, "trailing-stop");
    assert.ok(whole.settlement.netPnl > 0);
    assert.deepEqual(await replay(2000), whole);
    assert.deepEqual(await replay(1), whole);
  });
}

test("a newly triggered protective close has priority over a simultaneous reversal", () => {
  const configured = {
    ...config,
    signal: { ...config.signal, family: "ema-crossover" as const },
    exit: { ...config.exit, exitOnSignalReversal: true },
  };
  const candle = {
    ...seed,
    symbol: "BTCUSDT",
    openTime: at,
    open: 100,
    high: 102,
    low: 99.5,
    close: 100,
    emaFast: 99,
    emaSlow: 100,
    previousEmaFast: 101,
    previousEmaSlow: 100,
  };
  assert.equal(
    advanceExecutionCandlePosition(position("long"), candle, configured).settlement?.exitReason,
    "trailing-stop",
  );
});

test("direction-specific exit percentages cannot create zero or negative order prices", () => {
  const configured = (
    direction: "long" | "short" | "both",
    stopLossPercent: number,
    takeProfitPercent: number,
  ) => ({
    ...config,
    signal: { ...config.signal, direction },
    exit: { ...config.exit, stopLossPercent, takeProfitPercent },
  });
  for (const direction of ["short", "both"] as const)
    for (const take of [100, 150])
      assert.equal(strategyConfigSchema.safeParse(configured(direction, 3, take)).success, false);
  for (const direction of ["long", "both"] as const)
    assert.equal(strategyConfigSchema.safeParse(configured(direction, 100, 9)).success, false);
  assert.equal(strategyConfigSchema.safeParse(configured("long", 3, 150)).success, true);
  assert.equal(strategyConfigSchema.safeParse(configured("short", 100, 9)).success, true);
  assert.equal(
    openExecutionPositionAtQuote(
      { side: "short", signalPrice: 100 },
      { symbol: "BTCUSDT", price: 100, observedAt: at },
      "neutral",
      10000,
      10000,
      configured("short", 3, 100),
    ),
    null,
  );
});
