import {
  evaluateExecutionPriceExit,
  updateExecutionTrailingAtPrice,
  type ExecutionPosition,
  type ExecutionQuote,
  type ExecutionSettlement,
  type ExecutionStrategyConfig,
} from "@cryptoanal/application";
import type { RuntimeRecoveryEvidence } from "./runtime-recovery";

export type RuntimePriceEvent = ExecutionQuote & { id: bigint; streamId: string };
export type RuntimePriceCheckpoint = {
  position: ExecutionPosition;
  event: RuntimePriceEvent;
  through: Date;
  streamId: string;
  markPrice: number;
  settlement: ExecutionSettlement | null;
  recovered: boolean;
  recovery: (RuntimeRecoveryEvidence & { reason: "stream-change" | "unconfirmed-stream" }) | null;
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
  position: ExecutionPosition;
  through: Date;
  streamId: string | null;
  markPrice?: number;
  events: RuntimePriceEvent[];
  config: ExecutionStrategyConfig;
  recover: (
    position: ExecutionPosition,
    since: Date,
    quote: ExecutionQuote,
  ) => Promise<{
    position: ExecutionPosition;
    settlement: ExecutionSettlement | null;
    evidence?: RuntimeRecoveryEvidence;
  }>;
  checkpoint: (state: RuntimePriceCheckpoint) => Promise<boolean>;
}) {
  let position = input.position;
  let through = input.through;
  let streamId = input.streamId;
  let markPrice = input.markPrice ?? position.entryPrice;
  let pending: RuntimePriceCheckpoint | null = null;
  let recovered = false;
  let recovery: RuntimePriceCheckpoint["recovery"] = null;
  for (const event of input.events) {
    if (event.observedAt < position.openedAt) {
      pending = {
        position,
        event,
        through,
        streamId: streamId ?? event.streamId,
        markPrice,
        settlement: null,
        recovered,
        recovery,
      };
      continue;
    }
    const quote = { ...event, observedAt: new Date(Math.max(+event.observedAt, +through)) };
    let settlement: ExecutionSettlement | null = null;
    if (streamId !== event.streamId) {
      // Commit the known prefix before waiting for an independent recovery source.
      if (pending && !(await input.checkpoint(pending))) return;
      const result = await input.recover(position, through, quote);
      recovery = result.evidence
        ? { ...result.evidence, reason: streamId === null ? "unconfirmed-stream" : "stream-change" }
        : null;
      position = result.position;
      settlement = result.settlement;
      recovered = true;
    }
    settlement ??= evaluateExecutionPriceExit(position, quote, input.config);
    if (!settlement) position = updateExecutionTrailingAtPrice(position, quote.price, input.config);
    through = quote.observedAt;
    streamId = event.streamId;
    markPrice = quote.price;
    pending = { position, event, through, streamId, markPrice, settlement, recovered, recovery };
    if (settlement) break;
  }
  if (pending) await input.checkpoint(pending);
}
