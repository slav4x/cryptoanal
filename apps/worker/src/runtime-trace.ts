import type { ExecutionCandle, ExecutionProfitProtectionPolicy } from "@cryptoanal/application";
import type { RuntimePriceEvent, RuntimeSignalEvent } from "./runtime-price-processor";

export type RuntimeTraceRecovery = {
  eventId: bigint;
  since: Date;
  quote: RuntimePriceEvent;
  minutes: ExecutionCandle[];
};

export function runtimeTraceInputs(input: {
  firstEventId: bigint;
  policy: ExecutionProfitProtectionPolicy | null;
  signals: RuntimeSignalEvent[];
  recoveries: RuntimeTraceRecovery[];
}) {
  return {
    version: 1,
    mode: "journal",
    firstEventId: String(input.firstEventId),
    policy: input.policy,
    signals: input.signals.map((signal) => ({
      candle: { ...signal.candle, openTime: signal.candle.openTime.toISOString() },
      closedAt: signal.closedAt.toISOString(),
      availableAt: signal.availableAt.toISOString(),
    })),
    recoveries: input.recoveries.map((recovery) => ({
      eventId: String(recovery.eventId),
      since: recovery.since.toISOString(),
      quote: {
        symbol: recovery.quote.symbol,
        price: recovery.quote.price,
        observedAt: recovery.quote.observedAt.toISOString(),
      },
      minutes: recovery.minutes.map((candle) => ({
        ...candle,
        openTime: candle.openTime.toISOString(),
      })),
    })),
  };
}
