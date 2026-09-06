import type { CryptoAnalPrismaClient } from "./client";
import type { Prisma } from "./generated/prisma/client";

export type ActivityFilters = {
  startsAt: Date | null;
  action: "OPEN" | "CLOSE" | "HOLD" | "SKIP" | "ERROR" | null;
  strategyId: string | null;
  symbol: string | null;
  reasonCode: string | null;
  cursor: string | null;
  limit: number;
};

export class ActivityCursorNotFoundError extends Error {}

export class ActivityRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async list(workspaceId: string, filters: ActivityFilters) {
    const cursor = filters.cursor
      ? await this.prisma.decision.findFirst({
          where: { id: filters.cursor, workspaceId },
          select: { id: true, decidedAt: true },
        })
      : null;
    if (filters.cursor && !cursor) throw new ActivityCursorNotFoundError();
    const where: Prisma.DecisionWhereInput = {
      workspaceId,
      ...(filters.startsAt ? { decidedAt: { gte: filters.startsAt } } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.strategyId ? { strategyVersion: { strategyId: filters.strategyId } } : {}),
      ...(filters.symbol ? { symbol: filters.symbol } : {}),
      ...(filters.reasonCode ? { reasonCode: filters.reasonCode } : {}),
      ...(cursor
        ? {
            OR: [
              { decidedAt: { lt: cursor.decidedAt } },
              { decidedAt: cursor.decidedAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const summaryWhere: Prisma.DecisionWhereInput = {
      workspaceId,
      ...(filters.startsAt ? { decidedAt: { gte: filters.startsAt } } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.strategyId ? { strategyVersion: { strategyId: filters.strategyId } } : {}),
      ...(filters.symbol ? { symbol: filters.symbol } : {}),
      ...(filters.reasonCode ? { reasonCode: filters.reasonCode } : {}),
    };

    const [items, total, counts, available] = await Promise.all([
      this.prisma.decision.findMany({
        where,
        orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
        take: filters.limit + 1,
        select: {
          id: true,
          symbol: true,
          action: true,
          reasonCode: true,
          summary: true,
          factors: true,
          marketSnapshotRef: true,
          correlationId: true,
          decidedAt: true,
          positionId: true,
          tradeId: true,
          strategyVersion: {
            select: {
              id: true,
              version: true,
              strategy: { select: { id: true, name: true } },
            },
          },
          executionRun: {
            select: { id: true, deploymentId: true, environment: true, status: true },
          },
        },
      }),
      this.prisma.decision.count({ where: summaryWhere }),
      this.prisma.decision.groupBy({
        by: ["action"],
        where: summaryWhere,
        _count: { _all: true },
      }),
      this.prisma.decision.findMany({
        where: { workspaceId },
        distinct: ["strategyVersionId", "symbol", "reasonCode", "action"],
        select: {
          symbol: true,
          reasonCode: true,
          action: true,
          strategyVersion: {
            select: { strategy: { select: { id: true, name: true } } },
          },
        },
      }),
    ]);

    const hasMore = items.length > filters.limit;
    const pageItems = hasMore ? items.slice(0, filters.limit) : items;
    const strategies = new Map<string, string>();
    const symbols = new Set<string>();
    const reasonCodes = new Set<string>();
    const actions = new Set<"OPEN" | "CLOSE" | "HOLD" | "SKIP" | "ERROR">();
    for (const item of available) {
      strategies.set(item.strategyVersion.strategy.id, item.strategyVersion.strategy.name);
      symbols.add(item.symbol);
      reasonCodes.add(item.reasonCode);
      actions.add(item.action);
    }

    return {
      items: pageItems,
      total,
      counts: new Map(counts.map((count) => [count.action, count._count._all])),
      nextCursor: hasMore ? (pageItems.at(-1)?.id ?? null) : null,
      options: {
        strategies: [...strategies.entries()]
          .map(([id, name]) => ({ id, name }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        symbols: [...symbols].sort(),
        reasonCodes: [...reasonCodes].sort(),
        actions: [...actions].sort(),
      },
    };
  }
}
