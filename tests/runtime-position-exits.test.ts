import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  makeExecutionPositionExitPolicy,
  readExecutionPositionExitPolicy,
  executionHoldingDeadline,
  evaluateExecutionHoldingExit,
  executionFamilySignalExit,
  executionSignalExitEnabled,
  enrichExecutionCandles,
  getExecutionSignal,
  evaluateExecutionSignalExit,
  advanceExecutionCandlePosition,
  openExecutionPositionAtQuote,
  runRuntimeReplay,
  runValidationEngine,
  type ExecutionPosition,
  type ExecutionStrategyConfig,
} from "../packages/application/src/index";
import {
  processRuntimePriceEvents,
  type RuntimePriceCheckpoint,
  type RuntimeSignalEvent,
} from "../apps/worker/src/runtime-price-processor";
import { selectPriorityExit } from "../apps/worker/src/runtime-priority-exit";
import {
  defaultStrategyConfigDraft,
  draftToStrategyConfig,
  strategyConfigToDraft,
} from "../apps/dashboard/src/features/strategies/strategy-config-form";

const at = new Date("2026-10-16T00:00:00Z");
function config(
  family: ExecutionStrategyConfig["signal"]["family"] = "momentum",
  holding?: number,
) {
  return strategyConfigSchema.parse({
    ...fixture.config,
    universe: { ...fixture.config.universe, timeframe: "15m" },
    signal: { ...fixture.config.signal, family, direction: "long" },
    exit: {
      stopLossPercent: 10,
      takeProfitPercent: 50,
      trailingStopPercent: 0,
      exitOnSignalReversal: true,
      signalExitModel: "family-invalidation@1",
      ...(holding === undefined ? {} : { maxHoldingMinutes: holding }),
    },
  });
}
const seed = enrichExecutionCandles(
  fixture.candles.map((c) => ({ ...c, openTime: new Date(c.openTime) })),
  config(),
).at(-1)!;
function position(c = config(), side: "long" | "short" = "long"): ExecutionPosition {
  return {
    symbol: "BTCUSDT",
    side,
    openedAt: at,
    entryPrice: 100,
    quantity: 1,
    entryFee: 0.1,
    entrySlippage: 0,
    stopPrice: side === "long" ? 90 : 110,
    takePrice: side === "long" ? 150 : 50,
    trailingPrice: null,
    bestPrice: 100,
    entryRegime: "neutral",
    entrySession: "asia",
    positionExitPolicy: makeExecutionPositionExitPolicy(c, {
      side,
      signalPrice: 100,
      breakoutLevel: 100,
    })!,
  };
}
function event(id: number, ms: number, price = 100, streamId = "same") {
  return {
    id: BigInt(id),
    symbol: "BTCUSDT",
    price,
    streamId,
    observedAt: new Date(+at + ms),
    receivedAt: new Date(+at + ms),
  };
}
async function process(
  p: ExecutionPosition,
  c: ExecutionStrategyConfig,
  events: ReturnType<typeof event>[],
  extra: Partial<Parameters<typeof processRuntimePriceEvents>[0]> = {},
) {
  const checkpoints: RuntimePriceCheckpoint[] = [];
  await processRuntimePriceEvents({
    position: p,
    config: c,
    events,
    through: at,
    streamId: "same",
    recover: async () => {
      throw new Error("unexpected history recovery");
    },
    checkpoint: async (s) => {
      checkpoints.push(s);
      return true;
    },
    ...extra,
  });
  return checkpoints;
}
for (const side of ["long", "short"] as const) {
  test(`${side}: breakout exit uses the immutable original level without an opposite entry`, () => {
    const c = config("breakout"),
      p = position(c, side);
    const bar = {
      ...seed,
      symbol: p.symbol,
      openTime: at,
      close: 100,
      breakoutHigh: 110,
      breakoutLow: 90,
    };
    assert.equal(executionFamilySignalExit(p, bar), "breakout-invalidated");
    assert.equal(getExecutionSignal(bar, c), null);
    assert.equal(
      evaluateExecutionSignalExit(p, bar, c, new Date(+at + 900000))?.exitReason,
      "signal-exit",
    );
    assert.equal(
      executionFamilySignalExit(p, { ...bar, close: side === "long" ? 100.01 : 99.99 }),
      null,
    );
  });
  test(`${side}: momentum exits on zero or loss of direction, independently of entry threshold`, () => {
    const c = config(),
      p = position(c, side),
      bar = { ...seed, symbol: p.symbol, openTime: at, momentumPercent: 0 };
    assert.equal(executionFamilySignalExit(p, bar), "momentum-invalidated");
    assert.equal(
      executionFamilySignalExit(p, { ...bar, momentumPercent: side === "long" ? 0.001 : -0.001 }),
      null,
    );
    assert.equal(
      executionFamilySignalExit(p, { ...bar, momentumPercent: side === "long" ? -0.001 : 0.001 }),
      "momentum-invalidated",
    );
  });
  test(`${side}: mean-return is configurable in the new model and unchanged in legacy`, () => {
    const c = config("mean-reversion"),
      p = position(c, side),
      bar = { ...seed, symbol: p.symbol, openTime: at, meanReversionZScore: 0 };
    assert.equal(evaluateExecutionSignalExit(p, bar, c)?.exitReason, "signal-exit");
    const disabled = {
      ...p,
      positionExitPolicy: { ...p.positionExitPolicy!, signalEnabled: false },
    };
    assert.equal(executionSignalExitEnabled(disabled, c), false);
    assert.equal(evaluateExecutionSignalExit(disabled, bar, c), null);
    const legacy: ExecutionPosition = { ...disabled };
    delete legacy.positionExitPolicy;
    assert.equal(
      evaluateExecutionSignalExit(legacy, bar, {
        ...c,
        exit: { ...c.exit, exitOnSignalReversal: false },
      })?.exitReason,
      "signal-exit",
    );
  });
}
test("EMA exits require the reverse crossover and ignore entry-only RSI and direction filters", () => {
  const c = config("ema-crossover"),
    p = position(c);
  const bar = {
    ...seed,
    symbol: p.symbol,
    openTime: at,
    emaFast: 99,
    emaSlow: 100,
    previousEmaFast: 101,
    previousEmaSlow: 100,
    rsi: 100,
  };
  assert.equal(evaluateExecutionSignalExit(p, bar, c)?.exitReason, "signal-exit");
  assert.equal(evaluateExecutionSignalExit(p, { ...bar, previousEmaFast: 99 }, c), null);
});
test("old positions and configs do not acquire new exits, deadlines, or hash-changing defaults", () => {
  const original = strategyConfigSchema.parse(fixture.config);
  assert.equal("signalExitModel" in original.exit, false);
  assert.equal("maxHoldingMinutes" in original.exit, false);
  assert.deepEqual(draftToStrategyConfig(strategyConfigToDraft(original)), original);
  assert.equal(
    draftToStrategyConfig(defaultStrategyConfigDraft).exit.signalExitModel,
    "family-invalidation@1",
  );
  assert.equal(makeExecutionPositionExitPolicy(original, { side: "long", signalPrice: 100 }), null);
  const old = position();
  delete old.positionExitPolicy;
  assert.equal(executionHoldingDeadline(old), null);
  assert.equal(evaluateExecutionSignalExit(old, { ...seed, momentumPercent: -5 }, config()), null);
  for (const minutes of [0, -1, 1.5, 525601, Infinity])
    assert.equal(
      strategyConfigSchema.safeParse({
        ...original,
        exit: { ...original.exit, maxHoldingMinutes: minutes },
      }).success,
      false,
    );
  assert.throws(
    () => makeExecutionPositionExitPolicy(config("breakout"), { side: "long", signalPrice: 100 }),
    /policy/,
  );
  assert.throws(
    () => readExecutionPositionExitPolicy({ ...position().positionExitPolicy, version: "future" }),
    /policy/,
  );
});
test("deadline starts at the executed quote rather than signal time", () => {
  const c = config("momentum", 1),
    openedAt = new Date(+at + 34567);
  const p = openExecutionPositionAtQuote(
    { side: "long", signalPrice: 99 },
    { symbol: "BTCUSDT", price: 100, observedAt: openedAt },
    "neutral",
    10000,
    1000,
    c,
  )!;
  assert.equal(+executionHoldingDeadline(p)!, +openedAt + 60000);
  assert.equal(
    evaluateExecutionHoldingExit(
      p,
      { symbol: p.symbol, price: 101, observedAt: new Date(+openedAt + 59999) },
      c,
    ),
    null,
  );
  assert.equal(
    evaluateExecutionHoldingExit(
      p,
      { symbol: p.symbol, price: 101, observedAt: new Date(+openedAt + 60000) },
      c,
    )?.exitReason,
    "holding-timeout",
  );
});
test("no price at the deadline leaves the position open; first later quote supplies actual time and price", async () => {
  const c = config("momentum", 1),
    p = position(c);
  assert.equal((await process(p, c, [])).length, 0);
  const steps = await process(p, c, [event(1, 59999), event(2, 91000, 101)]);
  assert.equal(steps.at(-1)?.settlement?.exitReason, "holding-timeout");
  assert.equal(steps.at(-1)?.settlement?.closedAt, new Date(+at + 91000).toISOString());
  assert.equal(steps.at(-1)?.settlement?.exitPrice, 101 * (1 - c.costs.slippageBps / 10000));
});
test("known protection precedes a deadline, which closes without waiting for signal history", async () => {
  const c = config("momentum", 1),
    p = { ...position(c), exitPolicy: defaultExecutionExitPolicy };
  const stop = await process(p, c, [event(1, 60000, 89)], {
    signalIntervalMs: 900000,
    loadSignals: async () => {
      throw new Error("history blocked");
    },
  });
  assert.equal(stop.at(-1)?.settlement?.exitReason, "stop-loss");
  const timed = await process(p, c, [event(1, 900000)], {
    signalIntervalMs: 900000,
    loadSignals: async () => {
      throw new Error("history blocked");
    },
  });
  assert.equal(timed.at(-1)?.settlement?.exitReason, "holding-timeout");
  const gap = await process(p, c, [event(1, 900000, 101, "new")], { protectBeforeRecovery: true });
  assert.equal(gap.at(-1)?.settlement?.exitReason, "holding-timeout");
  assert.equal(gap.at(-1)?.historyIncomplete, true);
});
test("priority watcher can close at the deadline while history is blocked", () => {
  const c = config("momentum", 1),
    p = { ...position(c), exitPolicy: defaultExecutionExitPolicy },
    latest = event(3, 900000);
  assert.equal(
    selectPriorityExit({ position: p, through: at, config: c, events: [event(2, 59999)], latest })
      ?.settlement.exitReason,
    "holding-timeout",
  );
});
test("signal finality waits for the eligible quote; restart preserves the original policy and progress", async () => {
  const c = config(),
    p = position(c);
  const signal: RuntimeSignalEvent = {
    candle: { ...seed, symbol: p.symbol, openTime: at, momentumPercent: 0 },
    closedAt: new Date(+at + 900000),
    availableAt: new Date(+at + 902000),
  };
  const first = (
    await process(p, c, [event(2, 901000)], {
      signalIntervalMs: 900000,
      loadSignals: async () => [signal],
    })
  ).at(-1)!;
  assert.equal(first.settlement, null);
  const restarted = (
    await process(structuredClone(first.position), c, [event(3, 903000)], {
      through: first.through,
      streamId: first.streamId,
      signalCandleAt: first.signalCandleAt,
      signalIntervalMs: 900000,
      loadSignals: async () => [signal],
    })
  ).at(-1)!;
  assert.equal(restarted.settlement?.exitReason, "signal-exit");
  assert.equal(restarted.signalExit?.reason, "momentum-invalidated");
  assert.equal(restarted.settlement?.closedAt, new Date(+at + 903000).toISOString());
});
test("OHLC checks an overdue opening before later extremes and uses candle close for intrabar deadlines", () => {
  const c = config("momentum", 1),
    p = position(c);
  const bar = {
    ...seed,
    symbol: p.symbol,
    openTime: new Date(+at + 60000),
    open: 100,
    high: 200,
    low: 1,
    close: 101,
  };
  assert.equal(advanceExecutionCandlePosition(p, bar, c).settlement?.exitReason, "holding-timeout");
  const intrabar = advanceExecutionCandlePosition(
    p,
    { ...bar, openTime: at, high: 101, low: 99 },
    c,
  ).settlement!;
  assert.equal(intrabar.exitReason, "holding-timeout");
  assert.equal(intrabar.closedAt, new Date(+at + 900000).toISOString());
});
test("validation and candle replay agree on configured holding exits and immutable entry policies", () => {
  const c = config("momentum", 1),
    candles = fixture.candles.map((x) => ({ ...x, openTime: new Date(x.openTime) }));
  const replay = runRuntimeReplay({ config: c, candles, initialCapital: 10000 });
  const validation = runValidationEngine({
    config: c,
    candles,
    initialCapital: 10000,
    kind: "backtest",
    walkForward: null,
  });
  assert.ok(replay.trades.some((t) => t.exitReason === "holding-timeout"));
  assert.deepEqual(validation.trades, replay.trades);
});

test("fixed-slippage timeout receipt proves the deadline and durable price event", () => {
  const c = config("momentum", 1),
    p = { ...position(c), exitPolicy: defaultExecutionExitPolicy };
  const quote = { ...event(2, 60000, 101), source: "LastPrice" as const };
  const settled = evaluateExecutionHoldingExit(p, quote, c)!;
  const settlement = {
    ...settled,
    exitPrice: String(settled.exitPrice),
    grossPnl: String(settled.grossPnl),
    netPnl: String(settled.netPnl),
    fees: String(settled.fees),
    slippage: String(settled.slippage),
    closedAt: new Date(settled.closedAt),
  };
  const input = {
    position: p,
    config: c,
    event: { ...quote, price: { toFixed: () => "101" } },
    settlement,
  };
  const proof = buildExitTriggerProof(input);
  assert.equal(proof.payload.triggerLevel, null);
  const matched = verifyExitTriggerProof(
    {
      quantity: String(p.quantity),
      price: settlement.exitPrice,
      fee: String(new Prisma.Decimal(settlement.fees).minus(p.entryFee)),
      filledAt: settlement.closedAt,
      execution: proof,
    },
    c,
    p.exitPolicy,
  );
  assert.equal(matched.reason, "holding-timeout");
  assert.throws(
    () =>
      buildExitTriggerProof({
        ...input,
        event: { ...input.event, observedAt: new Date(+at + 59999) },
      }),
    /trigger/,
  );
});
import { defaultExecutionExitPolicy } from "../packages/application/src/execution-exit-policy";
import {
  buildExitTriggerProof,
  verifyExitTriggerProof,
} from "../packages/persistence/src/exit-trigger-proof";
import { Prisma } from "../packages/persistence/src/generated/prisma/client";
