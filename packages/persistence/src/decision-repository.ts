import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";

export type DecisionContextSnapshotPersistenceInput = {
  workspaceId: string;
  executionRunId: string;
  strategyVersionId: string;
  symbol: string;
  schemaVersion: number;
  featureSetVersion: string;
  contentHash: string;
  availableAt: Date;
  context: Prisma.InputJsonValue;
};

export type PersistShadowDecisionInput = {
  context: DecisionContextSnapshotPersistenceInput;
  provider: {
    id: string;
    version: string;
    kind: "RULE_BASED" | "ML" | "LLM";
  };
  status: "accepted" | "rejected" | "error" | "timeout";
  candidate: Prisma.InputJsonValue | null;
  rejectionCode: string | null;
  latencyMs: number;
  summary: string;
  factors?: Prisma.InputJsonValue;
};

export async function ensureDecisionContextSnapshot(
  transaction: Prisma.TransactionClient,
  input: DecisionContextSnapshotPersistenceInput,
) {
  if (!/^[a-f0-9]{64}$/.test(input.contentHash)) {
    throw new Error("Decision context content hash must be a lowercase SHA-256 value");
  }
  return transaction.decisionContextSnapshot.upsert({
    where: {
      executionRunId_symbol_contentHash: {
        executionRunId: input.executionRunId,
        symbol: input.symbol,
        contentHash: input.contentHash,
      },
    },
    create: input,
    update: {},
    select: { id: true, contentHash: true, availableAt: true },
  });
}

export class DecisionRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public listMemory(input: {
    workspaceId: string;
    executionRunId: string;
    symbol: string;
    limit?: number;
  }) {
    const limit = Math.min(32, Math.max(0, input.limit ?? 8));
    if (limit === 0) return Promise.resolve([]);
    return this.prisma.decision.findMany({
      where: {
        workspaceId: input.workspaceId,
        executionRunId: input.executionRunId,
        symbol: input.symbol,
        mode: "EXECUTION",
      },
      orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      select: {
        id: true,
        decidedAt: true,
        action: true,
        reasonCode: true,
        summary: true,
        providerId: true,
        mode: true,
      },
    });
  }

  public listContextSnapshots(input: {
    workspaceId: string;
    executionRunId?: string;
    symbol?: string;
    before?: Date;
    limit?: number;
  }) {
    return this.prisma.decisionContextSnapshot.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.executionRunId ? { executionRunId: input.executionRunId } : {}),
        ...(input.symbol ? { symbol: input.symbol } : {}),
        ...(input.before ? { availableAt: { lt: input.before } } : {}),
      },
      orderBy: [{ availableAt: "desc" }, { id: "desc" }],
      take: Math.min(500, Math.max(1, input.limit ?? 100)),
      select: {
        id: true,
        executionRunId: true,
        strategyVersionId: true,
        symbol: true,
        schemaVersion: true,
        featureSetVersion: true,
        contentHash: true,
        availableAt: true,
        context: true,
        decisions: {
          where: { mode: "SHADOW" },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            providerKind: true,
            providerId: true,
            providerVersion: true,
            action: true,
            candidate: true,
            verdictReasonCode: true,
            latencyMs: true,
            decidedAt: true,
          },
        },
      },
    });
  }

  public persistShadowDecision(input: PersistShadowDecisionInput) {
    return this.prisma.$transaction(async (transaction) => {
      const context = await ensureDecisionContextSnapshot(transaction, input.context);
      const correlationId = [
        "shadow",
        input.context.executionRunId,
        input.context.symbol,
        input.context.contentHash,
        input.provider.kind,
        input.provider.id,
        input.provider.version,
      ].join(":");
      const existing = await transaction.decision.findUnique({
        where: {
          workspaceId_correlationId: {
            workspaceId: input.context.workspaceId,
            correlationId,
          },
        },
        select: { id: true },
      });
      if (existing) return { id: existing.id, created: false };

      const action = shadowAction(input.status, input.candidate);
      const decision = await transaction.decision.create({
        data: {
          workspaceId: input.context.workspaceId,
          executionRunId: input.context.executionRunId,
          strategyVersionId: input.context.strategyVersionId,
          contextSnapshotId: context.id,
          symbol: input.context.symbol,
          action,
          mode: "SHADOW",
          providerKind: input.provider.kind,
          providerId: input.provider.id,
          providerVersion: input.provider.version,
          reasonCode: input.rejectionCode ?? "SHADOW_CANDIDATE_ACCEPTED",
          summary: input.summary,
          factors: input.factors ?? {},
          candidate: input.candidate ?? Prisma.JsonNull,
          verdictReasonCode: input.rejectionCode,
          latencyMs: Math.max(0, Math.round(input.latencyMs)),
          marketSnapshotRef: `decision-context:${context.contentHash}`,
          correlationId,
          decidedAt: context.availableAt,
        },
        select: { id: true },
      });
      return { id: decision.id, created: true };
    });
  }
}

function shadowAction(
  status: PersistShadowDecisionInput["status"],
  candidate: Prisma.InputJsonValue | null,
): "OPEN" | "HOLD" | "SKIP" | "ERROR" {
  if (status === "error" || status === "timeout") return "ERROR";
  if (status === "rejected") return "SKIP";
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const action = (candidate as Record<string, unknown>).action;
    if (action === "BUY" || action === "SELL") return "OPEN";
  }
  return "HOLD";
}
