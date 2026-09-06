import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";

export type PlaybookFilters = {
  status: "ACTIVE" | "ARCHIVED" | null;
  strategyId: string | null;
  tag: string | null;
  query: string | null;
};

export type PlaybookContentInput = {
  workspaceId: string;
  actorId: string;
  requestId: string;
  name: string;
  description: string;
  marketConditions: string;
  entryRules: string[];
  exitRules: string[];
  riskRules: string[];
  invalidationRules: string[];
  checklist: string[];
  tags: string[];
  strategyIds: string[];
  tradeIds: string[];
};

export class PlaybookNotFoundError extends Error {}
export class PlaybookNameConflictError extends Error {}
export class PlaybookUpdateConflictError extends Error {}
export class PlaybookStatusConflictError extends Error {}
export class PlaybookLinkNotFoundError extends Error {
  public constructor(public readonly target: "strategy" | "trade") {
    super(`Linked ${target} was not found`);
  }
}

export const playbookSelect = {
  id: true,
  name: true,
  description: true,
  status: true,
  marketConditions: true,
  entryRules: true,
  exitRules: true,
  riskRules: true,
  invalidationRules: true,
  checklist: true,
  tags: true,
  createdAt: true,
  updatedAt: true,
  strategies: {
    orderBy: { createdAt: "asc" },
    select: { strategy: { select: { id: true, name: true } } },
  },
  exampleTrades: {
    orderBy: { trade: { closedAt: "desc" } },
    select: {
      trade: {
        select: { id: true, symbol: true, side: true, netPnl: true, closedAt: true },
      },
    },
  },
} satisfies Prisma.PlaybookSelect;

export class PlaybookRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async list(workspaceId: string, filters: PlaybookFilters) {
    const where: Prisma.PlaybookWhereInput = {
      workspaceId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.strategyId ? { strategies: { some: { strategyId: filters.strategyId } } } : {}),
      ...(filters.tag ? { tags: { has: filters.tag } } : {}),
      ...(filters.query
        ? {
            OR: [
              { name: { contains: filters.query, mode: "insensitive" } },
              { description: { contains: filters.query, mode: "insensitive" } },
              { marketConditions: { contains: filters.query, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [items, statusCounts, strategies, trades, tagRows, strategyLinks, tradeLinks] =
      await Promise.all([
        this.prisma.playbook.findMany({
          where,
          orderBy: [{ status: "asc" }, { updatedAt: "desc" }, { id: "desc" }],
          select: playbookSelect,
        }),
        this.prisma.playbook.groupBy({
          by: ["status"],
          where: { workspaceId },
          _count: { _all: true },
        }),
        this.prisma.strategy.findMany({
          where: { workspaceId, status: { not: "ARCHIVED" } },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        }),
        this.prisma.trade.findMany({
          where: { workspaceId },
          orderBy: { closedAt: "desc" },
          take: 100,
          select: { id: true, symbol: true, side: true, netPnl: true, closedAt: true },
        }),
        this.prisma.playbook.findMany({
          where: { workspaceId },
          select: { tags: true },
        }),
        this.prisma.playbookStrategy.count({ where: { playbook: { workspaceId } } }),
        this.prisma.playbookTrade.count({ where: { playbook: { workspaceId } } }),
      ]);

    return {
      items,
      counts: new Map(statusCounts.map((item) => [item.status, item._count._all])),
      strategies,
      trades,
      tags: [...new Set(tagRows.flatMap((item) => item.tags))].sort(),
      strategyLinks,
      tradeLinks,
    };
  }

  public async create(input: PlaybookContentInput) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const targets = await assertTargets(
          transaction,
          input.workspaceId,
          input.strategyIds,
          input.tradeIds,
        );
        const playbook = await transaction.playbook.create({
          data: {
            workspaceId: input.workspaceId,
            name: input.name.trim(),
            description: input.description.trim(),
            marketConditions: input.marketConditions.trim(),
            entryRules: normalizeLines(input.entryRules),
            exitRules: normalizeLines(input.exitRules),
            riskRules: normalizeLines(input.riskRules),
            invalidationRules: normalizeLines(input.invalidationRules),
            checklist: normalizeLines(input.checklist),
            tags: normalizeTags(input.tags),
            createdByActorId: input.actorId,
            updatedByActorId: input.actorId,
            strategies: {
              create: targets.strategyIds.map((strategyId) => ({ strategyId })),
            },
            exampleTrades: { create: targets.tradeIds.map((tradeId) => ({ tradeId })) },
          },
          select: playbookSelect,
        });
        await writeAudit(transaction, input, playbook.id, "playbook.create", {
          strategyCount: targets.strategyIds.length,
          tradeCount: targets.tradeIds.length,
        });
        return playbook;
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new PlaybookNameConflictError();
      throw error;
    }
  }

  public async update(
    input: PlaybookContentInput & { playbookId: string; expectedUpdatedAt: Date },
  ) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const current = await transaction.playbook.findFirst({
          where: { id: input.playbookId, workspaceId: input.workspaceId },
          select: { id: true, updatedAt: true, status: true },
        });
        if (!current) throw new PlaybookNotFoundError();
        if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
          throw new PlaybookUpdateConflictError();
        }
        const targets = await assertTargets(
          transaction,
          input.workspaceId,
          input.strategyIds,
          input.tradeIds,
        );
        const playbook = await transaction.playbook.update({
          where: { id: current.id },
          data: {
            name: input.name.trim(),
            description: input.description.trim(),
            marketConditions: input.marketConditions.trim(),
            entryRules: normalizeLines(input.entryRules),
            exitRules: normalizeLines(input.exitRules),
            riskRules: normalizeLines(input.riskRules),
            invalidationRules: normalizeLines(input.invalidationRules),
            checklist: normalizeLines(input.checklist),
            tags: normalizeTags(input.tags),
            updatedByActorId: input.actorId,
            strategies: {
              deleteMany: {},
              create: targets.strategyIds.map((strategyId) => ({ strategyId })),
            },
            exampleTrades: {
              deleteMany: {},
              create: targets.tradeIds.map((tradeId) => ({ tradeId })),
            },
          },
          select: playbookSelect,
        });
        await writeAudit(transaction, input, playbook.id, "playbook.update", {
          strategyCount: targets.strategyIds.length,
          tradeCount: targets.tradeIds.length,
        });
        return playbook;
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new PlaybookNameConflictError();
      throw error;
    }
  }

  public async changeStatus(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    playbookId: string;
    expectedStatus: "ACTIVE" | "ARCHIVED";
    status: "ACTIVE" | "ARCHIVED";
    reason: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const exists = await transaction.playbook.findFirst({
        where: { id: input.playbookId, workspaceId: input.workspaceId },
        select: { id: true, status: true },
      });
      if (!exists) throw new PlaybookNotFoundError();
      if (exists.status !== input.expectedStatus) throw new PlaybookStatusConflictError();
      const playbook = await transaction.playbook.update({
        where: { id: input.playbookId },
        data: { status: input.status, updatedByActorId: input.actorId },
        select: playbookSelect,
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "playbook.status.change",
          resourceType: "playbook",
          resourceId: playbook.id,
          outcome: "COMPLETED",
          reason: input.reason.trim(),
          requestId: input.requestId,
          metadata: { from: input.expectedStatus, to: input.status },
        },
      });
      return playbook;
    });
  }
}

async function assertTargets(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  strategyIds: string[],
  tradeIds: string[],
) {
  const uniqueStrategyIds = [...new Set(strategyIds)];
  const uniqueTradeIds = [...new Set(tradeIds)];
  const [strategyCount, tradeCount] = await Promise.all([
    transaction.strategy.count({ where: { workspaceId, id: { in: uniqueStrategyIds } } }),
    transaction.trade.count({ where: { workspaceId, id: { in: uniqueTradeIds } } }),
  ]);
  if (strategyCount !== uniqueStrategyIds.length) throw new PlaybookLinkNotFoundError("strategy");
  if (tradeCount !== uniqueTradeIds.length) throw new PlaybookLinkNotFoundError("trade");
  return { strategyIds: uniqueStrategyIds, tradeIds: uniqueTradeIds };
}

async function writeAudit(
  transaction: Prisma.TransactionClient,
  input: Pick<PlaybookContentInput, "workspaceId" | "actorId" | "requestId">,
  resourceId: string,
  action: string,
  metadata: Prisma.InputJsonValue,
) {
  await transaction.auditEvent.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action,
      resourceType: "playbook",
      resourceId,
      outcome: "COMPLETED",
      requestId: input.requestId,
      metadata,
    },
  });
}

function normalizeLines(lines: string[]) {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}

function normalizeTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean))];
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
