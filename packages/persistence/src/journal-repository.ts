import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";

export type JournalFilters = {
  startsAt: Date | null;
  kind: "HYPOTHESIS" | "OBSERVATION" | "CONCLUSION" | "DECISION" | null;
  strategyId: string | null;
  symbol: string | null;
  tag: string | null;
  cursor: string | null;
  limit: number;
};

export type JournalTargetInput = {
  type:
    | "STRATEGY"
    | "STRATEGY_VERSION"
    | "EXECUTION_RUN"
    | "VALIDATION_RUN"
    | "TRADE"
    | "DECISION"
    | "SYMBOL";
  targetId: string;
};

export class JournalCursorNotFoundError extends Error {}

export class JournalTargetNotFoundError extends Error {
  public constructor(
    public readonly type: JournalTargetInput["type"],
    public readonly targetId: string,
  ) {
    super(`Journal target ${type}:${targetId} was not found`);
  }
}

const journalEntrySelect = {
  id: true,
  kind: true,
  title: true,
  body: true,
  tags: true,
  occurredAt: true,
  createdAt: true,
  links: {
    orderBy: { createdAt: "asc" },
    select: {
      type: true,
      strategyId: true,
      strategyVersionId: true,
      executionRunId: true,
      validationRunId: true,
      tradeId: true,
      decisionId: true,
      symbol: true,
      strategy: { select: { name: true } },
      strategyVersion: {
        select: { version: true, strategy: { select: { id: true, name: true } } },
      },
      executionRun: {
        select: {
          status: true,
          strategyVersion: {
            select: { version: true, strategy: { select: { id: true, name: true } } },
          },
        },
      },
      validationRun: {
        select: {
          kind: true,
          strategy: { select: { name: true } },
          strategyVersion: { select: { version: true } },
        },
      },
      trade: { select: { symbol: true, closedAt: true } },
      decision: { select: { symbol: true, action: true, decidedAt: true } },
      instrument: { select: { symbol: true } },
    },
  },
} satisfies Prisma.JournalEntrySelect;

const reviewSessionSelect = {
  id: true,
  title: true,
  startsAt: true,
  endsAt: true,
  summary: true,
  learnings: true,
  nextActions: true,
  tags: true,
  createdAt: true,
  _count: { select: { entries: true } },
} satisfies Prisma.ReviewSessionSelect;

export class JournalRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async list(workspaceId: string, filters: JournalFilters) {
    const cursor = filters.cursor
      ? await this.prisma.journalEntry.findFirst({
          where: { id: filters.cursor, workspaceId },
          select: { id: true, occurredAt: true },
        })
      : null;
    if (filters.cursor && !cursor) throw new JournalCursorNotFoundError();

    const summaryWhere = buildJournalWhere(workspaceId, filters);
    const where: Prisma.JournalEntryWhereInput = {
      ...summaryWhere,
      ...(cursor
        ? {
            AND: [
              summaryWhere,
              {
                OR: [
                  { occurredAt: { lt: cursor.occurredAt } },
                  { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
                ],
              },
            ],
          }
        : {}),
    };

    const [entries, total, counts, reviews, reviewCount, filterMetadata, linkOptions] =
      await Promise.all([
        this.prisma.journalEntry.findMany({
          where,
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: filters.limit + 1,
          select: journalEntrySelect,
        }),
        this.prisma.journalEntry.count({ where: summaryWhere }),
        this.prisma.journalEntry.groupBy({
          by: ["kind"],
          where: summaryWhere,
          _count: { _all: true },
        }),
        this.prisma.reviewSession.findMany({
          where: { workspaceId },
          orderBy: [{ endsAt: "desc" }, { id: "desc" }],
          take: 20,
          select: reviewSessionSelect,
        }),
        this.prisma.reviewSession.count({ where: { workspaceId } }),
        this.getFilterMetadata(workspaceId),
        this.getLinkOptions(workspaceId),
      ]);

    const hasMore = entries.length > filters.limit;
    const pageEntries = hasMore ? entries.slice(0, filters.limit) : entries;
    return {
      entries: pageEntries,
      reviews,
      total,
      counts: new Map(counts.map((item) => [item.kind, item._count._all])),
      reviewCount,
      nextCursor: hasMore ? (pageEntries.at(-1)?.id ?? null) : null,
      filterMetadata,
      linkOptions,
    };
  }

  public async createEntry(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    kind: JournalFilters["kind"] & string;
    title: string;
    body: string;
    tags: string[];
    occurredAt: Date;
    links: JournalTargetInput[];
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const linkData = await resolveJournalLinks(
        transaction,
        input.workspaceId,
        uniqueLinks(input.links),
      );
      const entry = await transaction.journalEntry.create({
        data: {
          workspaceId: input.workspaceId,
          kind: input.kind,
          title: input.title,
          body: input.body,
          tags: normalizeTags(input.tags),
          occurredAt: input.occurredAt,
          createdByActorId: input.actorId,
          links: { create: linkData },
        },
        select: journalEntrySelect,
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "journal.entry.create",
          resourceType: "journal-entry",
          resourceId: entry.id,
          outcome: "COMPLETED",
          requestId: input.requestId,
          metadata: { kind: input.kind, linkCount: linkData.length },
        },
      });
      return entry;
    });
  }

  public async createReview(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
    summary: string;
    learnings: string[];
    nextActions: string[];
    tags: string[];
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const entries = await transaction.journalEntry.findMany({
        where: {
          workspaceId: input.workspaceId,
          occurredAt: { gte: input.startsAt, lte: input.endsAt },
        },
        select: { id: true },
      });
      const review = await transaction.reviewSession.create({
        data: {
          workspaceId: input.workspaceId,
          title: input.title,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          summary: input.summary,
          learnings: normalizeLines(input.learnings),
          nextActions: normalizeLines(input.nextActions),
          tags: normalizeTags(input.tags),
          createdByActorId: input.actorId,
          entries: { create: entries.map((entry) => ({ journalEntryId: entry.id })) },
        },
        select: reviewSessionSelect,
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "journal.review.create",
          resourceType: "review-session",
          resourceId: review.id,
          outcome: "COMPLETED",
          requestId: input.requestId,
          metadata: {
            startsAt: input.startsAt.toISOString(),
            endsAt: input.endsAt.toISOString(),
            entryCount: entries.length,
          },
        },
      });
      return review;
    });
  }

  private async getFilterMetadata(workspaceId: string) {
    const [strategies, symbols, tags] = await Promise.all([
      this.prisma.strategy.findMany({
        where: { workspaceId },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      this.prisma.marketInstrument.findMany({
        where: { enabled: true },
        orderBy: { symbol: "asc" },
        select: { symbol: true },
      }),
      this.prisma.$queryRaw<Array<{ tag: string }>>(Prisma.sql`
        SELECT DISTINCT unnest("tags") AS "tag"
        FROM "JournalEntry"
        WHERE "workspaceId" = ${workspaceId}
        ORDER BY "tag" ASC
      `),
    ]);
    return {
      strategies,
      symbols: symbols.map((item) => item.symbol),
      tags: tags.map((item) => item.tag),
    };
  }

  private async getLinkOptions(workspaceId: string) {
    const [strategies, versions, executionRuns, validationRuns, trades, decisions, symbols] =
      await Promise.all([
        this.prisma.strategy.findMany({
          where: { workspaceId },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        }),
        this.prisma.strategyVersion.findMany({
          where: { workspaceId },
          orderBy: { createdAt: "desc" },
          take: 100,
          select: { id: true, version: true, strategy: { select: { name: true } } },
        }),
        this.prisma.executionRun.findMany({
          where: { workspaceId },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: {
            id: true,
            status: true,
            strategyVersion: {
              select: { version: true, strategy: { select: { name: true } } },
            },
          },
        }),
        this.prisma.validationRun.findMany({
          where: { workspaceId },
          orderBy: { queuedAt: "desc" },
          take: 50,
          select: {
            id: true,
            kind: true,
            strategy: { select: { name: true } },
            strategyVersion: { select: { version: true } },
          },
        }),
        this.prisma.trade.findMany({
          where: { workspaceId },
          orderBy: { closedAt: "desc" },
          take: 50,
          select: { id: true, symbol: true, closedAt: true },
        }),
        this.prisma.decision.findMany({
          where: { workspaceId },
          orderBy: { decidedAt: "desc" },
          take: 50,
          select: { id: true, symbol: true, action: true, decidedAt: true },
        }),
        this.prisma.marketInstrument.findMany({
          where: { enabled: true },
          orderBy: { symbol: "asc" },
          select: { symbol: true },
        }),
      ]);
    return { strategies, versions, executionRuns, validationRuns, trades, decisions, symbols };
  }
}

function buildJournalWhere(workspaceId: string, filters: JournalFilters) {
  const relationFilters: Prisma.JournalLinkWhereInput[] = [];
  if (filters.strategyId) {
    relationFilters.push({
      OR: [
        { strategyId: filters.strategyId },
        { strategyVersion: { strategyId: filters.strategyId } },
        { executionRun: { strategyVersion: { strategyId: filters.strategyId } } },
        { validationRun: { strategyId: filters.strategyId } },
        { trade: { strategyVersion: { strategyId: filters.strategyId } } },
        { decision: { strategyVersion: { strategyId: filters.strategyId } } },
      ],
    });
  }
  if (filters.symbol) {
    relationFilters.push({
      OR: [
        { symbol: filters.symbol },
        { trade: { symbol: filters.symbol } },
        { decision: { symbol: filters.symbol } },
      ],
    });
  }
  return {
    workspaceId,
    ...(filters.startsAt ? { occurredAt: { gte: filters.startsAt } } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.tag ? { tags: { has: filters.tag } } : {}),
    ...(relationFilters.length > 0
      ? { AND: relationFilters.map((filter) => ({ links: { some: filter } })) }
      : {}),
  } satisfies Prisma.JournalEntryWhereInput;
}

async function resolveJournalLinks(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  links: JournalTargetInput[],
) {
  const resolved: Prisma.JournalLinkCreateWithoutJournalEntryInput[] = [];
  for (const link of links) {
    if (link.type === "STRATEGY") {
      const exists = await transaction.strategy.findFirst({
        where: { id: link.targetId, workspaceId },
        select: { id: true },
      });
      if (!exists) throw new JournalTargetNotFoundError(link.type, link.targetId);
      resolved.push({
        type: link.type,
        workspace: { connect: { id: workspaceId } },
        strategy: { connect: { id: link.targetId } },
      });
    } else if (link.type === "STRATEGY_VERSION") {
      const exists = await transaction.strategyVersion.findFirst({
        where: { id: link.targetId, workspaceId },
        select: { id: true },
      });
      if (!exists) throw new JournalTargetNotFoundError(link.type, link.targetId);
      resolved.push({
        type: link.type,
        workspace: { connect: { id: workspaceId } },
        strategyVersion: { connect: { id: link.targetId } },
      });
    } else if (link.type === "EXECUTION_RUN") {
      const exists = await transaction.executionRun.findFirst({
        where: { id: link.targetId, workspaceId },
        select: { id: true },
      });
      if (!exists) throw new JournalTargetNotFoundError(link.type, link.targetId);
      resolved.push({
        type: link.type,
        workspace: { connect: { id: workspaceId } },
        executionRun: { connect: { id: link.targetId } },
      });
    } else if (link.type === "VALIDATION_RUN") {
      const exists = await transaction.validationRun.findFirst({
        where: { id: link.targetId, workspaceId },
        select: { id: true },
      });
      if (!exists) throw new JournalTargetNotFoundError(link.type, link.targetId);
      resolved.push({
        type: link.type,
        workspace: { connect: { id: workspaceId } },
        validationRun: { connect: { id: link.targetId } },
      });
    } else if (link.type === "TRADE") {
      const exists = await transaction.trade.findFirst({
        where: { id: link.targetId, workspaceId },
        select: { id: true },
      });
      if (!exists) throw new JournalTargetNotFoundError(link.type, link.targetId);
      resolved.push({
        type: link.type,
        workspace: { connect: { id: workspaceId } },
        trade: { connect: { id: link.targetId } },
      });
    } else if (link.type === "DECISION") {
      const exists = await transaction.decision.findFirst({
        where: { id: link.targetId, workspaceId },
        select: { id: true },
      });
      if (!exists) throw new JournalTargetNotFoundError(link.type, link.targetId);
      resolved.push({
        type: link.type,
        workspace: { connect: { id: workspaceId } },
        decision: { connect: { id: link.targetId } },
      });
    } else {
      const exists = await transaction.marketInstrument.findFirst({
        where: { symbol: link.targetId, enabled: true },
        select: { symbol: true },
      });
      if (!exists) throw new JournalTargetNotFoundError(link.type, link.targetId);
      resolved.push({
        type: link.type,
        workspace: { connect: { id: workspaceId } },
        instrument: { connect: { symbol: link.targetId } },
      });
    }
  }
  return resolved;
}

function uniqueLinks(links: JournalTargetInput[]) {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.type}:${link.targetId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean))];
}

function normalizeLines(lines: string[]) {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}
