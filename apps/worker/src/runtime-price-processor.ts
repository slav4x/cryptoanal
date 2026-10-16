import { advanceExecutionQuoteProtection } from "@cryptoanal/application";
import {
  type ExecutionProfitProtectionState,
  type ExecutionProfitProtectionPolicy,
  evaluateExecutionPriceExit,
  evaluateExecutionSignalExit,
  settleExecutionPosition,
  type ExecutionPosition,
  type ExecutionQuote,
  type ExecutionSettlement,
  type ExecutionStrategyConfig,
  type EnrichedExecutionCandle,
} from "@cryptoanal/application";
import type { RuntimeRecoveryEvidence } from "./runtime-recovery";

export type RuntimePriceEvent = ExecutionQuote & {
  eventKey?: string;
  id: bigint;
  streamId: string;
  receivedAt: Date;
};
export type RuntimeSignalEvent = {
  candle: EnrichedExecutionCandle;
  closedAt: Date;
  availableAt: Date;
};
export type RuntimePriceCheckpoint = {
  historyIncomplete?: boolean;
  profitProtectionState?: ExecutionProfitProtectionState | null;
  position: ExecutionPosition;
  event: RuntimePriceEvent;
  through: Date;
  streamId: string;
  markPrice: number;
  settlement: ExecutionSettlement | null;
  recovered: boolean;
  recovery:
    | (RuntimeRecoveryEvidence & {
        reason: "stream-change" | "unconfirmed-stream" | "history-wait";
      })
    | null;
  signalCandleAt: Date | null;
  signalExit: {
    candleAt: string;
    closedAt: string;
    availableAt: string;
    quoteReceivedAt: string;
    delayMs: number;
  } | null;
};

export async function forEachConcurrent<T>(
  items: T[],
  concurrency: number,
  handle: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await handle(items[next++]!);
    }),
  );
}

export async function processRuntimePriceEvents(input: {
  protectBeforeRecovery?: boolean;
  cursorEventId?: bigint | null;
  latestProtectiveEvent?: RuntimePriceEvent;
  position: ExecutionPosition;
  through: Date;
  profitProtection?: {
    policy: ExecutionProfitProtectionPolicy | null;
    state: ExecutionProfitProtectionState | null;
  };
  streamId: string | null;
  markPrice?: number;
  events: RuntimePriceEvent[];
  signalCandleAt?: Date | null;
  signalIntervalMs?: number;
  loadSignals?: () => Promise<RuntimeSignalEvent[]>;
  config: ExecutionStrategyConfig;
  recover: (
    position: ExecutionPosition,
    since: Date,
    quote: RuntimePriceEvent,
    protection: {
      policy: ExecutionProfitProtectionPolicy | null;
      state: ExecutionProfitProtectionState | null;
      anchorEventId: bigint | null;
    },
  ) => Promise<{
    position: ExecutionPosition;
    settlement: ExecutionSettlement | null;
    evidence?: RuntimeRecoveryEvidence;
    profitProtectionState?: ExecutionProfitProtectionState | null;
  }>;
  checkpoint: (state: RuntimePriceCheckpoint) => Promise<boolean>;
}) {
  let profitProtectionState = input.profitProtection?.state ?? null;
  let anchorEventId = input.cursorEventId ?? null;
  let position = input.position;
  let through = input.through;
  let streamId = input.streamId;
  let markPrice = input.markPrice ?? position.entryPrice;
  let pending: RuntimePriceCheckpoint | null = null;
  let recovered = false;
  let recovery: RuntimePriceCheckpoint["recovery"] = null;
  let signalCandleAt = input.signalCandleAt ?? null;
  let signalExit: RuntimePriceCheckpoint["signalExit"] = null;
  let signals: RuntimeSignalEvent[] | null = null;
  for (const rawEvent of input.events) {
    const event = { ...rawEvent, source: rawEvent.source ?? ("LastPrice" as const) };
    if (event.observedAt < position.openedAt) {
      pending = {
        ...(input.profitProtection ? { profitProtectionState } : {}),
        position,
        event,
        through,
        streamId: streamId ?? event.streamId,
        markPrice,
        settlement: null,
        recovered,
        recovery,
        signalCandleAt,
        signalExit,
      };
      continue;
    }
    const quote = { ...event, observedAt: new Date(Math.max(+event.observedAt, +through)) };
    let settlement: ExecutionSettlement | null = null;
    if (streamId !== event.streamId && input.protectBeforeRecovery) {
      const candidates = input.events.filter((e) => e.id >= event.id);
      if (
        input.latestProtectiveEvent &&
        input.latestProtectiveEvent.id > (candidates.at(-1)?.id ?? event.id)
      )
        candidates.push(input.latestProtectiveEvent);
      for (const candidate of candidates) {
        if (candidate.observedAt < through || candidate.observedAt < position.openedAt) continue;
        const exit = evaluateExecutionPriceExit(
          position,
          { ...candidate, source: candidate.source ?? "LastPrice" },
          input.config,
        );
        if (!exit) continue;
        await input.checkpoint({
          position,
          event: candidate,
          through: candidate.observedAt,
          streamId: candidate.streamId,
          markPrice: candidate.price,
          settlement: exit,
          recovered: true,
          historyIncomplete: true,
          recovery: {
            reason: streamId === null ? "unconfirmed-stream" : "stream-change",
            fromAt: through.toISOString(),
            toAt: candidate.observedAt.toISOString(),
            source: "journal-protection",
            quality: "incomplete",
            ambiguity: "unreconstructed-gap",
          },
          signalCandleAt,
          signalExit,
          ...(input.profitProtection ? { profitProtectionState } : {}),
        });
        return;
      }
    }
    if (streamId !== event.streamId && !settlement) {
      // Commit the known prefix before waiting for an independent recovery source.
      if (pending && !(await input.checkpoint(pending))) return;
      pending = null;
      const result = await input.recover(position, through, quote, {
        policy: input.profitProtection?.policy ?? null,
        state: profitProtectionState,
        anchorEventId,
      });
      recovery = result.evidence
        ? { ...result.evidence, reason: streamId === null ? "unconfirmed-stream" : "stream-change" }
        : null;
      position = result.position;
      if ("profitProtectionState" in result)
        profitProtectionState = result.profitProtectionState ?? null;
      settlement = result.settlement;
      recovered = true;
    }
    settlement ??= evaluateExecutionPriceExit(position, quote, input.config);
    if (!settlement && input.loadSignals && input.signalIntervalMs) {
      const lastClosed =
        Math.floor(+quote.observedAt / input.signalIntervalMs) * input.signalIntervalMs -
        input.signalIntervalMs;
      const baseline =
        signalCandleAt ??
        new Date(
          Math.floor(+position.openedAt / input.signalIntervalMs) * input.signalIntervalMs -
            input.signalIntervalMs,
        );
      if (lastClosed > +baseline) {
        if (!signals) {
          if (pending && !(await input.checkpoint(pending))) return;
          signals = await input.loadSignals();
        }
        for (const signal of signals) {
          if (signal.candle.openTime <= baseline) continue;
          if (+signal.candle.openTime > lastClosed || signal.availableAt > event.receivedAt) break;
          signalCandleAt = signal.candle.openTime;
          if (signal.closedAt <= position.openedAt) continue;
          if (!evaluateExecutionSignalExit(position, signal.candle, input.config, signal.closedAt))
            continue;
          signalExit = {
            candleAt: signal.candle.openTime.toISOString(),
            closedAt: signal.closedAt.toISOString(),
            availableAt: signal.availableAt.toISOString(),
            quoteReceivedAt: event.receivedAt.toISOString(),
            delayMs: Math.max(0, +event.receivedAt - +signal.closedAt),
          };
          settlement = settleExecutionPosition(
            position,
            quote.price,
            quote.observedAt,
            "signal-exit",
            input.config,
          );
          break;
        }
      }
    }
    if (!settlement) {
      const protection = advanceExecutionQuoteProtection(
        position,
        event,
        input.config,
        input.profitProtection?.policy ?? null,
        profitProtectionState,
      );
      position = protection.position;
      profitProtectionState = protection.state;
    }
    through = quote.observedAt;
    anchorEventId = event.id;
    streamId = event.streamId;
    markPrice = quote.price;
    pending = {
      ...(input.profitProtection ? { profitProtectionState } : {}),
      position,
      event,
      through,
      streamId,
      markPrice,
      settlement,
      recovered,
      recovery,
      signalCandleAt,
      signalExit,
    };
    if (settlement) break;
  }
  if (pending) await input.checkpoint(pending);
}
