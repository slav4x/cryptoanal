import { makeExecutionPositionExitPolicy } from "../packages/application/src/execution-position-exit";
import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  executionEngineVersion,
  type ExecutionPosition,
  type ExecutionProfitProtectionPolicy,
  type ExecutionInstrumentRules,
} from "../packages/application/src/index";
import { hashTracePayload } from "../packages/persistence/src/position-trace";
import { replayRuntimeTrace } from "../apps/worker/src/runtime-trace-replay";
import {
  processRuntimePriceEvents,
  type RuntimePriceEvent,
  type RuntimeSignalEvent,
} from "../apps/worker/src/runtime-price-processor";
import { runtimeTraceInputs, type RuntimeTraceRecovery } from "../apps/worker/src/runtime-trace";
import { recoverRuntimeGap } from "../apps/worker/src/runtime-recovery";
import { recoverCausalRuntimeGap } from "../apps/worker/src/causal-recovery";

const at = new Date("2026-10-14T00:00:00Z");
const config = strategyConfigSchema.parse({
  ...fixture.config,
  exit: { stopLossPercent: 3, takeProfitPercent: 9, trailingStopPercent: 0 },
});
const policy = {
  enabledAt: at.toISOString(),
  breakEvenActivationR: 0.5,
  trailingActivationR: 1,
  trailingDistanceR: 0.5,
};
function event(index: number, price: number, offset = index, streamId = "same"): RuntimePriceEvent {
  return {
    id: BigInt(index),
    symbol: "BTCUSDT",
    price,
    observedAt: new Date(+at + offset),
    receivedAt: new Date(+at + offset),
    streamId,
  };
}
async function trace(
  side: "long" | "short",
  quotes: RuntimePriceEvent[],
  configured = config,
  protection: ExecutionProfitProtectionPolicy | null = policy,
  signals: RuntimeSignalEvent[] = [],
  instrumentRules?: ExecutionInstrumentRules,
  causal = false,
) {
  const positionExitPolicy = makeExecutionPositionExitPolicy(configured, {
    side,
    signalPrice: 100,
    breakoutLevel: 100,
  });
  const position: ExecutionPosition = {
    ...(positionExitPolicy ? { positionExitPolicy } : {}),
    ...(instrumentRules ? { instrumentRules } : {}),
    symbol: "BTCUSDT",
    side,
    entryRegime: "neutral",
    entrySession: "asia",
    openedAt: at,
    entryPrice: 100,
    quantity: 1,
    stopPrice: side === "long" ? 97 : 103,
    takePrice: side === "long" ? 109 : 91,
    trailingPrice: null,
    bestPrice: 100,
    entryFee: 0.06,
    entrySlippage: 0,
  };
  const snapshot = {
    version: 1,
    executionEngineVersion,
    config: configured,
    eventId: "1",
    streamId: "same",
    throughAt: at.toISOString(),
    markPrice: "100",
    signalCandleAt: null,
    profitProtectionState: null,
    profitProtectionPolicy: protection,
    funding: { status: "disabled" },
    position: {
      ...position,
      side: side === "long" ? "BUY" : "SELL",
      entryRegime: "NEUTRAL",
      entrySession: "ASIA",
      openedAt: at.toISOString(),
    },
  };
  const records: Array<{ eventId: bigint; kind: string; payload: unknown; payloadHash: string }> =
    [];
  const recoveries: RuntimeTraceRecovery[] = [];
  let historyIncomplete = false;
  await processRuntimePriceEvents({
    protectBeforeRecovery: causal,
    position,
    through: at,
    streamId: "same",
    events: quotes,
    config: configured,
    profitProtection: { policy: protection, state: null },
    signalIntervalMs: 900000,
    loadSignals: async () => signals,
    recover: async (p, since, quote, protectionState) => {
      const minutes = [0, 60000].map((offset) => ({
        symbol: "BTCUSDT",
        openTime: new Date(+at + offset),
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        turnover: 1,
      }));
      if (causal) {
        const source = {
          strictMinutes: true,
          anchorTradeId: "start",
          quoteTradeId: "end",
          recent: {
            sampledAt: quote.observedAt.toISOString(),
            trades: [
              { tradeId: "start", symbol: p.symbol, price: "100", observedAt: since.toISOString() },
              {
                tradeId: "peak",
                symbol: p.symbol,
                price: side === "long" ? "104" : "96",
                observedAt: new Date(+since + 1000).toISOString(),
              },
              {
                tradeId: "end",
                symbol: p.symbol,
                price: String(quote.price),
                observedAt: quote.observedAt.toISOString(),
              },
            ],
          },
        };
        recoveries.push({ eventId: quote.id, since, quote, minutes: [], causal: source });
        return recoverCausalRuntimeGap({
          position: p,
          since,
          quote,
          minutes: [],
          config: configured,
          protection: protectionState,
          ...source,
        });
      }
      recoveries.push({ eventId: quote.id, since, quote, minutes });
      return recoverRuntimeGap({ position: p, since, quote, minutes, config: configured });
    },
    checkpoint: async (checkpoint) => {
      historyIncomplete ||= checkpoint.historyIncomplete ?? false;
      const payload = {
        quotePrice: String(checkpoint.markPrice),
        quoteAt: checkpoint.through.toISOString(),
        signalCandleAt: checkpoint.signalCandleAt?.toISOString() ?? null,
        profitProtectionState: checkpoint.profitProtectionState ?? null,
        inputs: runtimeTraceInputs({
          protectBeforeRecovery: causal,
          firstEventId: quotes[0]!.id,
          policy: protection,
          signals,
          recoveries,
        }),
        action: checkpoint.settlement
          ? {
              kind: "close",
              settlement: { ...checkpoint.settlement },
              protection: {
                bestPrice: String(checkpoint.position.bestPrice),
                stopPrice: String(checkpoint.position.stopPrice),
                trailingPrice:
                  checkpoint.position.trailingPrice === null
                    ? null
                    : String(checkpoint.position.trailingPrice),
              },
            }
          : {
              kind: "update",
              bestPrice: String(checkpoint.position.bestPrice),
              stopPrice: String(checkpoint.position.stopPrice),
              trailingPrice:
                checkpoint.position.trailingPrice === null
                  ? null
                  : String(checkpoint.position.trailingPrice),
            },
      };
      records.push({
        eventId: checkpoint.event.id,
        kind: "journal",
        payload: JSON.parse(JSON.stringify(payload)),
        payloadHash: hashTracePayload(payload),
      });
      return true;
    },
  });
  const events = [
    { ...event(1, 100, 0), eventKey: "entry", price: "100" },
    ...quotes.map((e) => ({ ...e, eventKey: String(e.id), price: String(e.price) })),
  ];
  return {
    snapshot: JSON.parse(JSON.stringify(snapshot)),
    snapshotHash: hashTracePayload(snapshot),
    fullFromEntry: true,
    startEventId: 1n,
    endEventId: records.at(-1)!.eventId,
    expectedEventCount: historyIncomplete
      ? null
      : BigInt(quotes.filter((quote) => quote.id <= records.at(-1)!.eventId).length),
    records,
    loadEvents: async (cursor: bigint, through: bigint) =>
      events.filter((e) => e.id > cursor && e.id <= through),
    trade: null,
  };
}
test("new recovery replays the original public trades and restored protection across restart", async () => {
  for (const side of ["long", "short"] as const) {
    const value = side === "long" ? 104 : 96;
    const input = await trace(
      side,
      [event(2, value, 10000, "new"), event(3, 100, 11000, "new")],
      config,
      policy,
      [],
      undefined,
      true,
    );
    const result = await replayRuntimeTrace(input);
    assert.equal(result.status, "matched");
    assert.deepEqual(result.differences, []);
    assert.equal(result.recoveries, 1);
    assert.deepEqual(result.recoverySources, { "recent-public-trades": 1 });
    assert.equal(result.continuity, "recorded-public-trade-recovery");
    assert.ok(result.limits.every((limit) => !limit.includes("minute OHLC")));
  }
});
test("a protective exit before recovery remains explicitly incomplete in replay", async () => {
  const value = await trace(
    "long",
    [event(2, 96, 10000, "new")],
    config,
    policy,
    [],
    undefined,
    true,
  );
  const result = await replayRuntimeTrace(value);
  assert.equal(result.status, "incomplete");
  assert.ok(result.gaps.some((g) => g.includes("coverage count")));
});
for (const side of ["long", "short"] as const)
  test(`${side}: replay preserves profit-protection peaks and exact first exit from immutable records`, async () => {
    const input = await trace(side, [
      event(2, side === "long" ? 104 : 96),
      event(3, side === "long" ? 102 : 98),
    ]);
    const result = await replayRuntimeTrace(input);
    assert.equal(result.status, "matched");
    assert.equal(result.continuity, "continuous");
    assert.equal(result.settlement?.exitReason, "trailing-stop");
    assert.ok(result.settlement!.netPnl > 0);
  });
test("replay uses original recovery minutes and explicitly labels unknown intrabar order", async () => {
  const input = await trace(
    "long",
    [event(2, 101, 30000), event(3, 102, 90000, "new"), event(4, 96, 91000, "new")],
    config,
    null,
  );
  const result = await replayRuntimeTrace(input);
  assert.equal(result.status, "matched");
  assert.equal(result.recoveries, 1);
  assert.equal(result.continuity, "recorded-ohlc-recovery");
  assert.deepEqual(result.recoverySources, { "minute-ohlc": 1 });
  assert.ok(result.limits.length);
});
test("missing original gap inputs cannot be declared a successful replay", async () => {
  const input = await trace(
    "long",
    [event(2, 101, 30000), event(3, 102, 90000, "new"), event(4, 96, 91000, "new")],
    config,
    null,
  );
  input.records = input.records.map((record) => {
    const payload = JSON.parse(JSON.stringify(record.payload));
    payload.inputs.recoveries = [];
    return { ...record, payload, payloadHash: hashTracePayload(payload) };
  });
  const result = await replayRuntimeTrace(input);
  assert.equal(result.status, "incomplete");
  assert.match(result.gaps.join(" "), /recovery/);
});
test("late signal finality is reproduced at the eligible quote, not at candle close", async () => {
  const configured = {
    ...config,
    signal: { ...config.signal, family: "ema-crossover" as const },
    exit: { ...config.exit, exitOnSignalReversal: true },
  };
  const candle = {
    ...fixture.candles[0]!,
    symbol: "BTCUSDT",
    openTime: at,
    emaFast: 99,
    emaSlow: 100,
    previousEmaFast: 101,
    previousEmaSlow: 100,
    rsi: null,
    previousRsi: null,
    atrPercent: null,
    volume24h: null,
    breakoutHigh: null,
    breakoutLow: null,
    meanReversionZScore: null,
    previousMeanReversionZScore: null,
    momentumPercent: null,
    previousMomentumPercent: null,
  };
  const input = await trace(
    "long",
    [event(2, 101, 901000), event(3, 100.5, 903000)],
    configured,
    null,
    [{ candle, closedAt: new Date(+at + 900000), availableAt: new Date(+at + 902000) }],
  );
  const result = await replayRuntimeTrace(input);
  assert.equal(result.status, "matched");
  assert.equal(result.settlement?.closedAt, new Date(+at + 903000).toISOString());
});
test("missing entry data and partial coverage stay visible; changed snapshot/record checksums fail", async () => {
  const input = await trace("long", [event(2, 104), event(3, 102)]);
  const missing = await replayRuntimeTrace({
    ...input,
    loadEvents: async (cursor, through) =>
      (await input.loadEvents(cursor, through)).filter((e) => e.id !== 1n),
  });
  assert.equal(missing.status, "incomplete");
  const partial = await replayRuntimeTrace({ ...input, fullFromEntry: false });
  assert.equal(partial.coverage, "from-existing-checkpoint");
  assert.ok(partial.limits.length);
  await assert.rejects(replayRuntimeTrace({ ...input, snapshotHash: "changed" }), /checksum/);
  await assert.rejects(
    replayRuntimeTrace({
      ...input,
      records: input.records.map((record) => ({ ...record, payloadHash: "changed" })),
    }),
    /checksum/,
  );
});

test("loss of a complete middle archive chunk is detected even when the exit still matches", async () => {
  const input = await trace("long", [event(2, 101), event(3, 104), event(4, 102)]);
  const result = await replayRuntimeTrace({
    ...input,
    loadEvents: async (cursor, through) =>
      (await input.loadEvents(cursor, through)).filter((item) => item.id !== 2n),
  });
  assert.equal(result.settlement?.exitReason, "trailing-stop");
  assert.equal(result.status, "incomplete");
  assert.match(result.gaps.join(" "), /Event coverage mismatch/);
});

test("normalized traces replay their pinned rules; legacy version remains reproducible without new rules", async () => {
  const instrumentRules: ExecutionInstrumentRules = {
    version: 1,
    symbol: "BTCUSDT",
    observedAt: at.toISOString(),
    tickSize: "0.1",
    qtyStep: "0.001",
    minOrderQty: "0.001",
    minNotional: "5",
    minPrice: "0.1",
    maxPrice: "1000000",
    maxOrderQty: "1000",
    maxMarketOrderQty: "1000",
  };
  const normalized = await trace(
    "long",
    [event(2, 104), event(3, 102)],
    config,
    policy,
    [],
    instrumentRules,
  );
  assert.equal((await replayRuntimeTrace(normalized)).status, "matched");
  const legacy = await trace("long", [event(2, 104), event(3, 102)]);
  legacy.snapshot.executionEngineVersion = "cryptoanal-execution@0.4.0";
  legacy.snapshotHash = hashTracePayload(legacy.snapshot);
  assert.equal((await replayRuntimeTrace(legacy)).status, "matched");
  normalized.snapshot.executionEngineVersion = "cryptoanal-execution@0.4.0";
  normalized.snapshotHash = hashTracePayload(normalized.snapshot);
  await assert.rejects(replayRuntimeTrace(normalized), /Unsupported/);
});

test("replay compares original settlement and profit-protection state without a trade row", async () => {
  const input = await trace("long", [event(2, 104), event(3, 102)]);
  const payload = JSON.parse(JSON.stringify(input.records.at(-1)!.payload));
  payload.action.settlement.netPnl += 1;
  payload.profitProtectionState.bestPrice += 1;
  input.records.at(-1)!.payload = payload;
  input.records.at(-1)!.payloadHash = hashTracePayload(payload);
  const result = await replayRuntimeTrace(input);
  assert.equal(result.status, "mismatch");
  assert.match(result.differences.join(" "), /Settlement netPnl mismatch/);
  assert.match(result.differences.join(" "), /Protection state/);
});

for (const side of ["long", "short"] as const) {
  test(`${side}: holding deadline and versioned breakout level replay from the original snapshot`, async () => {
    const timed = { ...config, exit: { ...config.exit, maxHoldingMinutes: 1 } };
    const value = await replayRuntimeTrace(
      await trace(side, [event(2, 100, 59999), event(3, 100, 90000)], timed, null),
    );
    assert.equal(value.status, "matched");
    assert.equal(value.settlement?.exitReason, "holding-timeout");
    assert.equal(value.settlement?.closedAt, new Date(+at + 90000).toISOString());
    const family = strategyConfigSchema.parse({
      ...config,
      signal: { ...config.signal, family: "breakout" },
      exit: {
        ...config.exit,
        signalExitModel: "family-invalidation@1",
        exitOnSignalReversal: true,
      },
    });
    const candle = {
      ...fixture.candles[0]!,
      symbol: "BTCUSDT",
      openTime: at,
      emaFast: null,
      emaSlow: null,
      previousEmaFast: null,
      previousEmaSlow: null,
      rsi: null,
      previousRsi: null,
      atrPercent: null,
      volume24h: null,
      breakoutHigh: 110,
      breakoutLow: 90,
      meanReversionZScore: null,
      previousMeanReversionZScore: null,
      momentumPercent: null,
      previousMomentumPercent: null,
      close: 100,
    };
    const signals = [
      { candle, closedAt: new Date(+at + 900000), availableAt: new Date(+at + 902000) },
    ];
    const result = await replayRuntimeTrace(
      await trace(side, [event(2, 100, 901000), event(3, 100, 903000)], family, null, signals),
    );
    assert.equal(result.status, "matched");
    assert.equal(result.settlement?.exitReason, "signal-exit");
    assert.equal(result.settlement?.closedAt, new Date(+at + 903000).toISOString());
  });
}
