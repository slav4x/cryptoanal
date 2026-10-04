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
    { status: "filled" | "conflict" | "no-touch" } | { status: "rejected"; reason: string }
  >;
}) {
  let throughEventId = input.cursor;
  for (const event of input.events) {
    if (throughEventId !== null && event.id <= throughEventId) continue;
    const now = input.now();
    if (now >= +input.expiresAt) return { status: "expired" as const, throughEventId };
    throughEventId = event.id;
    if (
      event.streamId !== input.streamId ||
      event.receivedAt < input.availableAt ||
      event.observedAt < input.detectedAt ||
      event.observedAt >= input.expiresAt ||
      now - +event.observedAt > input.maximumQuoteAgeMs ||
      +event.observedAt > now + 1000
    )
      continue;
    const result = await input.tryFill(event);
    if (result.status !== "no-touch") return { ...result, throughEventId };
  }
  return {
    status: input.now() >= +input.expiresAt ? ("expired" as const) : ("pending" as const),
    throughEventId,
  };
}
