import {
  executionEngineVersion,
  readExecutionProfitProtectionState,
  type ExecutionPosition,
  type ExecutionProfitProtectionPolicy,
  type EnrichedExecutionCandle,
  type ExecutionCandle,
  type ExecutionSettlement,
  readExecutionInstrumentRules,
} from "@cryptoanal/application";
import { strategyConfigSchema } from "@cryptoanal/contracts";
import { hashTracePayload, type ArchivedPriceEvent } from "@cryptoanal/persistence";
import { processRuntimePriceEvents, type RuntimeSignalEvent } from "./runtime-price-processor";
import { recoverRuntimeGap } from "./runtime-recovery";

type Snapshot = {
  version: 1;
  executionEngineVersion: string;
  config: unknown;
  position: Record<string, string | null>;
  eventId: string;
  streamId: string | null;
  throughAt: string;
  markPrice: string;
  signalCandleAt: string | null;
  profitProtectionState: unknown;
  profitProtectionPolicy: ExecutionProfitProtectionPolicy | null;
  funding: { status: string };
};
type TraceInputs = {
  version: 1;
  mode: string;
  firstEventId: string;
  policy: ExecutionProfitProtectionPolicy | null;
  signals: Array<{
    candle: Omit<EnrichedExecutionCandle, "openTime"> & { openTime: string };
    closedAt: string;
    availableAt: string;
  }>;
  recoveries: Array<{
    eventId: string;
    since: string;
    minutes: Array<Omit<ExecutionCandle, "openTime"> & { openTime: string }>;
  }>;
};
type TracePayload = {
  inputs: TraceInputs | null;
  action:
    | { kind: "update"; bestPrice: string; stopPrice: string; trailingPrice: string | null }
    | {
        kind: "close";
        settlement: Record<string, string>;
        protection?: { bestPrice: string; stopPrice: string; trailingPrice: string | null };
      };
  quotePrice: string;
  quoteAt: string;
  profitProtectionState: unknown;
  signalCandleAt: string | null;
};
class RuntimeTraceIncompleteError extends Error {}

export async function replayRuntimeTrace(input: {
  snapshot: unknown;
  snapshotHash: string;
  fullFromEntry: boolean;
  startEventId: bigint;
  endEventId: bigint;
  expectedEventCount: bigint | null;
  records: Array<{ eventId: bigint | null; kind: string; payload: unknown; payloadHash: string }>;
  loadEvents: (cursor: bigint, through: bigint) => Promise<ArchivedPriceEvent[]>;
  trade: null | {
    exitReason: string;
    closedAt: Date;
    averageExitPrice: string;
    grossPnl: string;
    netPnl: string;
    fees: string;
    slippage: string;
  };
}) {
  if (hashTracePayload(input.snapshot) !== input.snapshotHash)
    throw new Error("Trace snapshot checksum mismatch");
  const snapshot = input.snapshot as Snapshot;
  if (
    snapshot.version !== 1 ||
    (snapshot.executionEngineVersion !== executionEngineVersion &&
      !(
        snapshot.executionEngineVersion === "cryptoanal-execution@0.4.0" &&
        !snapshot.position.instrumentRules
      )) ||
    snapshot.funding?.status !== "disabled"
  )
    throw new Error("Unsupported execution trace version or funding policy");
  if (snapshot.eventId !== String(input.startEventId))
    throw new Error("Trace entry cursor mismatch");
  const config = strategyConfigSchema.parse(snapshot.config);
  const stored = snapshot.position;
  const number = (key: string) => {
    const value = Number(stored[key]);
    if (stored[key] === null || stored[key] === undefined || !Number.isFinite(value))
      throw new Error(`Invalid trace ${key}`);
    return value;
  };
  const date = (value: string) => {
    const result = new Date(value);
    if (!Number.isFinite(+result)) throw new Error("Invalid trace timestamp");
    return result;
  };
  let position: ExecutionPosition = {
    ...(stored.instrumentRules
      ? { instrumentRules: readExecutionInstrumentRules(stored.instrumentRules)! }
      : {}),
    symbol: stored.symbol!,
    side: stored.side === "BUY" ? "long" : "short",
    openedAt: date(stored.openedAt!),
    entryPrice: number("entryPrice"),
    quantity: number("quantity"),
    stopPrice: number("stopPrice"),
    takePrice: number("takePrice"),
    trailingPrice: stored.trailingPrice === null ? null : number("trailingPrice"),
    bestPrice: number("bestPrice"),
    entryFee: number("entryFee"),
    entrySlippage: number("entrySlippage"),
    entryRegime: stored.entryRegime!.toLowerCase() as ExecutionPosition["entryRegime"],
    entrySession: stored
      .entrySession!.toLowerCase()
      .replaceAll("_", "-") as ExecutionPosition["entrySession"],
  };
  let cursor = input.startEventId,
    through = date(snapshot.throughAt),
    streamId = snapshot.streamId;
  let markPrice = Number(snapshot.markPrice);
  let state = readExecutionProfitProtectionState(snapshot.profitProtectionState);
  let signalCandleAt = snapshot.signalCandleAt ? date(snapshot.signalCandleAt) : null;
  let policy = snapshot.profitProtectionPolicy;
  let signals: RuntimeSignalEvent[] = [];
  let settlement: ExecutionSettlement | null = null;
  let count = 0,
    recoveries = 0,
    checkpoints = 0;
  let availableEvents = 0,
    readThrough = input.startEventId;
  const differences: string[] = [],
    gaps: string[] = [];
  const initialEvent = await input.loadEvents(input.startEventId - 1n, input.startEventId);
  if (!initialEvent.some((event) => event.id === input.startEventId))
    gaps.push("Initial price event is missing");
  for (const record of input.records)
    if (hashTracePayload(record.payload) !== record.payloadHash)
      throw new Error("Trace record checksum mismatch");
  const records = input.records.filter((record) => record.kind === "journal");
  for (const record of [
    ...records,
    { eventId: input.endEventId, kind: "tail", payload: null, payloadHash: hashTracePayload(null) },
  ]) {
    const end = record.eventId;
    if (end === null || end < cursor || settlement) continue;
    const payload = record.payload as TracePayload | null;
    const inputs = payload?.inputs;
    if (payload && (!inputs || inputs.version !== 1 || inputs.mode !== "journal")) {
      gaps.push(`Missing replay inputs at ${end}`);
      break;
    }
    const effectiveFrom = inputs ? BigInt(inputs.firstEventId) : null;
    const recordedRecoveries = inputs?.recoveries ?? [];
    while (cursor < end && !settlement && !gaps.length) {
      const events = await input.loadEvents(cursor, end);
      if (!events.length) {
        gaps.push(`Missing journal tail after ${cursor}`);
        break;
      }
      availableEvents += events.filter((event) => event.id > readThrough).length;
      readThrough = events.at(-1)!.id;
      if (
        events[0]!.id <= cursor ||
        events.some(
          (event, index) => event.id > end || (index > 0 && event.id <= events[index - 1]!.id),
        )
      )
        throw new Error("Trace price event order is invalid");
      const boundary =
        effectiveFrom === null ? -1 : events.findIndex((event) => event.id >= effectiveFrom);
      const segments =
        boundary > 0 ? [events.slice(0, boundary), events.slice(boundary)] : [events];
      for (const segment of segments) {
        if (!segment.length || settlement) continue;
        if (inputs && segment[0]!.id >= effectiveFrom!) {
          policy = inputs.policy;
          signals = inputs.signals.map((signal) => ({
            candle: { ...signal.candle, openTime: date(signal.candle.openTime) },
            closedAt: date(signal.closedAt),
            availableAt: date(signal.availableAt),
          }));
        }
        try {
          await processRuntimePriceEvents({
            position,
            through,
            streamId,
            markPrice,
            events: segment.map((event) => ({ ...event, price: Number(event.price) })),
            config,
            profitProtection: { policy, state },
            signalCandleAt,
            signalIntervalMs:
              { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 }[config.universe.timeframe] *
              60000,
            ...(config.signal.family === "mean-reversion" ||
            (config.signal.family === "ema-crossover" && config.exit.exitOnSignalReversal)
              ? { loadSignals: async () => signals }
              : {}),
            recover: async (p, since, quote) => {
              const recovery = recordedRecoveries.find((item) => item.eventId === String(quote.id));
              if (!recovery || +date(recovery.since) !== +since)
                throw new RuntimeTraceIncompleteError(
                  `Missing original recovery input at ${quote.id}`,
                );
              recoveries++;
              return recoverRuntimeGap({
                position: p,
                since,
                quote,
                minutes: recovery.minutes.map((candle) => ({
                  ...candle,
                  openTime: date(candle.openTime),
                })),
                config,
              });
            },
            checkpoint: async (checkpoint) => {
              count += segment.filter(
                (event) => event.id > cursor && event.id <= checkpoint.event.id,
              ).length;
              cursor = checkpoint.event.id;
              position = checkpoint.position;
              through = checkpoint.through;
              streamId = checkpoint.streamId;
              markPrice = checkpoint.markPrice;
              state = checkpoint.profitProtectionState ?? null;
              signalCandleAt = checkpoint.signalCandleAt;
              settlement = checkpoint.settlement;
              return true;
            },
          });
        } catch (error) {
          if (error instanceof RuntimeTraceIncompleteError) {
            gaps.push(error.message);
            break;
          }
          throw error;
        }
      }
    }
    if (gaps.length) break;
    if (payload) {
      checkpoints++;
      const protection =
        payload.action.kind === "update" ? payload.action : payload.action.protection;
      const tolerance = Math.max(1e-9, position.entryPrice * 1e-12);
      if (
        protection &&
        (Math.abs(position.stopPrice - Number(protection.stopPrice)) > tolerance ||
          Math.abs(position.bestPrice - Number(protection.bestPrice)) > tolerance ||
          (position.trailingPrice === null) !== (protection.trailingPrice === null) ||
          (position.trailingPrice !== null &&
            protection.trailingPrice !== null &&
            Math.abs(position.trailingPrice - Number(protection.trailingPrice)) > tolerance))
      )
        differences.push(`Protection mismatch at ${end}`);
      if (payload.action.kind === "close" && !settlement)
        differences.push(`Missing automatic exit at ${end}`);
      if (payload.action.kind === "update" && settlement)
        differences.push(`Unexpected automatic exit at ${cursor}`);
      if (
        hashTracePayload(state) !== hashTracePayload(payload.profitProtectionState) ||
        (signalCandleAt?.toISOString() ?? null) !== payload.signalCandleAt
      )
        differences.push(`Protection state or signal cursor mismatch at ${end}`);
      if (
        Math.abs(markPrice - Number(payload.quotePrice)) > tolerance ||
        through.toISOString() !== payload.quoteAt
      )
        differences.push(`Price checkpoint mismatch at ${end}`);
      const checkpointSettlement = settlement as ExecutionSettlement | null;
      if (payload.action.kind === "close" && checkpointSettlement) {
        const recorded = payload.action.settlement;
        if (
          checkpointSettlement.exitReason !== recorded.exitReason ||
          checkpointSettlement.closedAt !== recorded.closedAt
        )
          differences.push(`Exit reason or time mismatch at ${end}`);
        for (const key of ["exitPrice", "grossPnl", "netPnl", "fees", "slippage"] as const)
          if (Math.abs(checkpointSettlement[key] - Number(recorded[key])) > 1e-7)
            differences.push(`Settlement ${key} mismatch at ${end}`);
      }
    }
  }
  const result = settlement as ExecutionSettlement | null;
  while (!gaps.length && readThrough < input.endEventId) {
    const events = await input.loadEvents(readThrough, input.endEventId);
    if (!events.length) break;
    availableEvents += events.length;
    readThrough = events.at(-1)!.id;
  }
  if (input.expectedEventCount === null) gaps.push("Event coverage count was not captured");
  else if (BigInt(availableEvents) !== input.expectedEventCount)
    gaps.push(
      `Event coverage mismatch: expected ${input.expectedEventCount}, available ${availableEvents}`,
    );
  if (input.trade && !gaps.length) {
    if (!result) gaps.push("Closure has no reproducible journal input");
    else {
      if (
        result.exitReason !== input.trade.exitReason ||
        result.closedAt !== input.trade.closedAt.toISOString()
      )
        differences.push("Trade reason or time mismatch");
      for (const [actual, expected] of [
        [result.exitPrice, input.trade.averageExitPrice],
        [result.grossPnl, input.trade.grossPnl],
        [result.netPnl, input.trade.netPnl],
        [result.fees, input.trade.fees],
        [result.slippage, input.trade.slippage],
      ] as const)
        if (Math.abs(actual - Number(expected)) > 1e-7)
          differences.push("Trade settlement mismatch");
    }
  }
  return {
    coverage: input.fullFromEntry ? "from-entry" : "from-existing-checkpoint",
    status: gaps.length ? "incomplete" : differences.length ? "mismatch" : "matched",
    events: count,
    availableEvents,
    checkpoints,
    recoveries,
    throughEventId: String(cursor),
    differences,
    gaps,
    settlement: result,
    continuity: gaps.length ? "incomplete" : recoveries ? "recorded-ohlc-recovery" : "continuous",
    limits: [
      ...(input.fullFromEntry
        ? []
        : ["Price history before the initial checkpoint was not retained"]),
      ...(recoveries
        ? [
            "Missing trade intervals use original recorded minute OHLC; intrabar order remains unknown",
          ]
        : []),
    ],
  };
}
