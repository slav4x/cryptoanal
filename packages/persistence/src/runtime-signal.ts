import type { Prisma } from "./generated/prisma/client";

export type RuntimeSignalStatus = "SIGNAL" | "PENDING" | "FILLED" | "EXPIRED" | "REJECTED";

export function runtimeSignalId(executionRunId: string, symbol: string, candleAt: Date) {
  return `runtime-signal:${executionRunId}:${symbol}:${candleAt.toISOString()}`;
}

export function runtimeSignalState(input: {
  executionRunId: string;
  symbol: string;
  candleAt: Date;
  status: RuntimeSignalStatus;
  observedAt: Date;
  reasonCode: string;
  pending?: Prisma.InputJsonValue | Prisma.JsonValue | null;
}) {
  const pending =
    input.pending && typeof input.pending === "object" && !Array.isArray(input.pending)
      ? (input.pending as Prisma.InputJsonObject)
      : null;
  return {
    id: runtimeSignalId(input.executionRunId, input.symbol, input.candleAt),
    status: input.status,
    signalCandleAt: input.candleAt.toISOString(),
    observedAt: input.observedAt.toISOString(),
    reasonCode: input.reasonCode,
    detectedAt: typeof pending?.detectedAt === "string" ? pending.detectedAt : null,
    expiresAt: typeof pending?.expiresAt === "string" ? pending.expiresAt : null,
  };
}

export function withRuntimeSignal(
  factors: Prisma.InputJsonValue,
  state: ReturnType<typeof runtimeSignalState>,
) {
  return {
    ...(typeof factors === "object" && !Array.isArray(factors) ? factors : { details: factors }),
    runtimeSignal: state,
  };
}
