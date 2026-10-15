import { createHash } from "node:crypto";
import {
  executionEngineVersion,
  type ExecutionProfitProtectionPolicy,
} from "../../application/src/index";
import type { Prisma } from "./generated/prisma/client";
import type { RuntimeRiskPolicy } from "./runtime-risk";
import type { RuntimeMarketEntryPolicy } from "./runtime-entry-policy";
import { readExecutionInstrumentRules } from "../../application/src/execution-instrument";

export type PositionTraceOptions = {
  retentionDays: number;
  profitProtectionPolicy: ExecutionProfitProtectionPolicy | null;
};
export const defaultPositionTraceOptions: PositionTraceOptions = {
  retentionDays: 30,
  profitProtectionPolicy: null,
};

export function hashTracePayload(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item !== null && typeof item === "object")
      return `{${Object.entries(item)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`)
        .join(",")}}`;
    const serialized = JSON.stringify(item);
    if (serialized === undefined) throw new Error("Invalid trace payload");
    return serialized;
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
type SnapshotPosition = {
  exitPolicy?: unknown;
  entryExecution?: unknown;
  instrumentRules?: unknown;
  symbol: string;
  side: "BUY" | "SELL";
  entryRegime: string;
  entrySession: string;
  openedAt: Date;
  entryPrice: string;
  quantity: string;
  stopPrice: string;
  takePrice: string;
  trailingPrice: string | null;
  bestPrice: string;
  entryFee: string;
  entrySlippage: string;
};
export type PositionTraceSnapshotInput = {
  positionId: string;
  workspaceId: string;
  position: SnapshotPosition;
  eventId: bigint;
  streamId: string | null;
  throughAt: Date;
  markPrice: string;
  signalCandleAt: Date | null;
  indicatorState: Prisma.JsonValue | null;
  profitProtectionState: Prisma.JsonValue | null;
  fullFromEntry: boolean;
  strategyVersionId: string;
  riskPolicy: RuntimeRiskPolicy;
  marketEntryPolicy: RuntimeMarketEntryPolicy;
  options: PositionTraceOptions;
};

export async function ensurePositionTrace(
  tx: Prisma.TransactionClient,
  input: PositionTraceSnapshotInput,
) {
  const existing = await tx.positionExecutionTrace.findUnique({
    where: { positionId: input.positionId },
    select: { positionId: true, policyHash: true },
  });
  if (existing) return existing;
  const version = await tx.strategyVersion.findUniqueOrThrow({
    where: { id: input.strategyVersionId },
    select: { config: true, configHash: true },
  });
  const persisted = await tx.position.findUniqueOrThrow({
    where: { id: input.positionId },
    select: {
      entryPrice: true,
      quantity: true,
      stopPrice: true,
      takePrice: true,
      trailingPrice: true,
      bestPrice: true,
      entryFee: true,
      entrySlippage: true,
      exitState: true,
      remainingQuantity: true,
      remainingEntryFee: true,
    },
  });
  const snapshot = {
    version: 1,
    executionEngineVersion,
    config: version.config,
    configHash: version.configHash,
    position: {
      ...(input.position.exitPolicy ? { exitPolicy: input.position.exitPolicy } : {}),
      ...(input.position.entryExecution ? { entryExecution: input.position.entryExecution } : {}),
      ...(input.position.instrumentRules
        ? { instrumentRules: readExecutionInstrumentRules(input.position.instrumentRules)! }
        : {}),
      ...(persisted.remainingQuantity !== null
        ? {
            remainingQuantity: persisted.remainingQuantity.toFixed(),
            remainingEntryFee: persisted.remainingEntryFee?.toFixed() ?? null,
            exitState: persisted.exitState,
          }
        : {}),
      symbol: input.position.symbol,
      side: input.position.side,
      entryRegime: input.position.entryRegime,
      entrySession: input.position.entrySession,
      openedAt: input.position.openedAt.toISOString(),
      entryPrice: persisted.entryPrice.toFixed(),
      quantity: persisted.quantity.toFixed(),
      stopPrice: persisted.stopPrice.toFixed(),
      takePrice: persisted.takePrice.toFixed(),
      trailingPrice: persisted.trailingPrice?.toFixed() ?? null,
      bestPrice: persisted.bestPrice.toFixed(),
      entryFee: persisted.entryFee.toFixed(),
      entrySlippage: persisted.entrySlippage.toFixed(),
    },
    eventId: String(input.eventId),
    streamId: input.streamId,
    throughAt: input.throughAt.toISOString(),
    markPrice: input.markPrice,
    signalCandleAt: input.signalCandleAt?.toISOString() ?? null,
    indicatorState: input.indicatorState,
    profitProtectionState: input.profitProtectionState,
    riskPolicy: input.riskPolicy,
    marketEntryPolicy: input.marketEntryPolicy,
    profitProtectionPolicy: input.options.profitProtectionPolicy,
    retentionDays: input.options.retentionDays,
    funding: { status: "disabled", version: "cryptoanal-funding@disabled-v1" },
    coverage: input.fullFromEntry ? "from-entry" : "from-existing-checkpoint",
  };
  return tx.positionExecutionTrace.create({
    data: {
      positionId: input.positionId,
      workspaceId: input.workspaceId,
      symbol: input.position.symbol,
      startEventId: input.eventId,
      fullFromEntry: input.fullFromEntry,
      snapshot,
      snapshotHash: hashTracePayload(snapshot),
      policyHash: hashTracePayload(input.options.profitProtectionPolicy),
      startedAt: input.throughAt,
    },
  });
}

export async function closePositionTrace(
  tx: Prisma.TransactionClient,
  positionId: string,
  settlement: {
    exitPrice: string;
    grossPnl: string;
    netPnl: string;
    fees: string;
    slippage: string;
    exitReason: string;
    closedAt: Date;
  },
) {
  const trace = await tx.positionExecutionTrace.findUnique({ where: { positionId } });
  if (!trace) return;
  const snapshot = trace.snapshot as { retentionDays?: number };
  const days = snapshot.retentionDays ?? 30;
  const position = await tx.position.findUniqueOrThrow({
    where: { id: positionId },
    select: { priceEventId: true, runtimeVersion: true },
  });
  await tx.positionExecutionTrace.update({
    where: { positionId },
    data: {
      closedAt: settlement.closedAt,
      endEventId: position.priceEventId ?? trace.startEventId,
      retainUntil: new Date(+settlement.closedAt + days * 86400_000),
    },
  });
  await tx.positionTraceRecord.create({
    data: {
      positionId,
      runtimeVersion: position.runtimeVersion,
      eventId: null,
      kind: "settlement",
      payload: { ...settlement, closedAt: settlement.closedAt.toISOString() },
      payloadHash: hashTracePayload({ ...settlement, closedAt: settlement.closedAt.toISOString() }),
    },
  });
}
