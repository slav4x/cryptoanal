import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  executionEngineVersion,
  type ExecutionPosition,
  type ExecutionProfitProtectionPolicy,
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
) {
  const position: ExecutionPosition = {
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
  await processRuntimePriceEvents({
    position,
    through: at,
    streamId: "same",
    events: quotes,
    config: configured,
    profitProtection: { policy: protection, state: null },
    signalIntervalMs: 900000,
    loadSignals: async () => signals,
    recover: async (p, since, quote) => {
      const minutes = [0, 60000].map((offset) => ({
        symbol: "BTCUSDT",
        openTime: new Date(+at + offset),
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        turnover: 1,
      }));
      recoveries.push({ eventId: quote.id, since, quote, minutes });
      return recoverRuntimeGap({ position: p, since, quote, minutes, config: configured });
    },
    checkpoint: async (checkpoint) => {
      const payload = {
        quotePrice: String(checkpoint.markPrice),
        quoteAt: checkpoint.through.toISOString(),
        signalCandleAt: checkpoint.signalCandleAt?.toISOString() ?? null,
        profitProtectionState: checkpoint.profitProtectionState ?? null,
        inputs: runtimeTraceInputs({
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
    expectedEventCount: BigInt(
      quotes.filter((quote) => quote.id <= records.at(-1)!.eventId).length,
    ),
    records,
    loadEvents: async (cursor: bigint, through: bigint) =>
      events.filter((e) => e.id > cursor && e.id <= through),
    trade: null,
  };
}
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
