import type { RuntimeEntryWaitReason } from "@cryptoanal/persistence";
import type { RuntimePriceEvent } from "./runtime-price-processor";

export async function replayPendingEntryEvents(input: {
  events: RuntimePriceEvent[];
  cursor: bigint | null;
  streamId: string;
  detectedAt: Date;
  availableAt: Date;
  expiresAt: Date;
  maximumQuoteAgeMs: number;
  now: () => number;
  tryFill: (
    event: RuntimePriceEvent,
  ) => Promise<
    | { status: "filled" | "conflict" }
    | { status: "no-touch"; reason?: RuntimeEntryWaitReason }
    | { status: "rejected"; reason: string }
  >;
}) {
  let throughEventId = input.cursor;
  let waitingReason: RuntimeEntryWaitReason | undefined;
  for (const event of input.events) {
    if (throughEventId !== null && event.id <= throughEventId) continue;
    const now = input.now();
    if (now >= +input.expiresAt) return { status: "expired" as const, throughEventId };
    throughEventId = event.id;
    const unavailable: RuntimeEntryWaitReason | null =
      event.streamId !== input.streamId
        ? "ENTRY_QUOTE_STREAM_MISMATCH"
        : event.receivedAt < input.availableAt || event.observedAt < input.detectedAt
          ? "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY"
          : now - +event.observedAt > input.maximumQuoteAgeMs || event.observedAt >= input.expiresAt
            ? "STALE_ENTRY_QUOTE"
            : +event.observedAt > now + 1000
              ? "ENTRY_QUOTE_IN_FUTURE"
              : null;
    if (unavailable) {
      waitingReason = unavailable;
      continue;
    }
    const result = await input.tryFill(event);
    if (result.status !== "no-touch") return { ...result, throughEventId };
    waitingReason = result.reason ?? "ENTRY_LIMIT_NOT_TOUCHED";
  }
  return {
    status: input.now() >= +input.expiresAt ? ("expired" as const) : ("pending" as const),
    throughEventId,
    waitingReason,
  };
}
