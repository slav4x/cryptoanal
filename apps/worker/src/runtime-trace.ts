import type { ExecutionCandle, ExecutionProfitProtectionPolicy } from "@cryptoanal/application";
import type { RuntimePriceEvent, RuntimeSignalEvent } from "./runtime-price-processor";
import type { RecoveryTradeSnapshot } from "./causal-recovery";

export type RuntimeTraceRecovery = {
  causal?: {
    strictMinutes: boolean;
    recent?: RecoveryTradeSnapshot;
    anchorTradeId?: string;
    anchorPrice?: string;
    quoteTradeId?: string;
    fallbackReason?: string;
  };
  eventId: bigint;
  since: Date;
  quote: RuntimePriceEvent;
  minutes: ExecutionCandle[];
};

export function runtimeTraceInputs(input: {
  protectBeforeRecovery?: boolean;
  latestProtectiveEvent?: RuntimePriceEvent;
  firstEventId: bigint;
  policy: ExecutionProfitProtectionPolicy | null;
  signals: RuntimeSignalEvent[];
  recoveries: RuntimeTraceRecovery[];
}) {
  return {
    version: 1,
    mode: "journal",
    protectBeforeRecovery: input.protectBeforeRecovery ?? false,
    ...(input.latestProtectiveEvent
      ? {
          latestProtectiveEvent: {
            ...input.latestProtectiveEvent,
            id: String(input.latestProtectiveEvent.id),
            observedAt: input.latestProtectiveEvent.observedAt.toISOString(),
            receivedAt: input.latestProtectiveEvent.receivedAt.toISOString(),
          },
        }
      : {}),
    firstEventId: String(input.firstEventId),
    policy: input.policy,
    signals: input.signals.map((signal) => ({
      candle: { ...signal.candle, openTime: signal.candle.openTime.toISOString() },
      closedAt: signal.closedAt.toISOString(),
      availableAt: signal.availableAt.toISOString(),
    })),
    recoveries: input.recoveries.map((recovery) => ({
      ...(recovery.causal ? { causal: recovery.causal } : {}),
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
