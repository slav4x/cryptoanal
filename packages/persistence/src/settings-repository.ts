import type { CryptoAnalPrismaClient } from "./client";

export class WorkspaceSettingsNotFoundError extends Error {}
export class WorkspaceSettingsConflictError extends Error {}
export class WorkspaceTimezoneInvalidError extends Error {}

export class SettingsRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async get(workspaceId: string) {
    return this.prisma.workspaceSettings.upsert({
      where: { workspaceId },
      update: {},
      create: { workspaceId },
      select: {
        timezone: true,
        currency: true,
        tableDensity: true,
        updatedAt: true,
      },
    });
  }

  public async update(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    timezone: string;
    tableDensity: "compact" | "comfortable";
    expectedUpdatedAt: Date;
  }) {
    assertTimeZone(input.timezone);
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.workspaceSettings.findUnique({
        where: { workspaceId: input.workspaceId },
        select: { updatedAt: true },
      });
      if (!current) throw new WorkspaceSettingsNotFoundError();
      if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new WorkspaceSettingsConflictError();
      }
      const preferences = await transaction.workspaceSettings.update({
        where: { workspaceId: input.workspaceId },
        data: {
          timezone: input.timezone,
          tableDensity: input.tableDensity,
        },
        select: {
          timezone: true,
          currency: true,
          tableDensity: true,
          updatedAt: true,
        },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "settings.preferences.update",
          resourceType: "workspace-settings",
          resourceId: input.workspaceId,
          outcome: "COMPLETED",
          requestId: input.requestId,
          metadata: {
            timezone: preferences.timezone,
            tableDensity: preferences.tableDensity,
          },
        },
      });
      return preferences;
    });
  }

  public async exportWorkspace(input: { workspaceId: string; actorId: string; requestId: string }) {
    return this.prisma.$transaction(async (transaction) => {
      const workspace = await transaction.workspace.findUnique({
        where: { id: input.workspaceId },
        select: {
          id: true,
          slug: true,
          name: true,
          createdAt: true,
          updatedAt: true,
          settings: true,
          strategies: {
            orderBy: { createdAt: "asc" },
            include: { versions: { orderBy: { version: "asc" } } },
          },
          trades: { orderBy: { closedAt: "asc" } },
          journalEntries: {
            orderBy: { occurredAt: "asc" },
            include: { links: { orderBy: { createdAt: "asc" } } },
          },
          reviewSessions: {
            orderBy: { endsAt: "asc" },
            include: { entries: { orderBy: { addedAt: "asc" } } },
          },
          playbooks: {
            orderBy: { createdAt: "asc" },
            include: {
              strategies: { orderBy: { createdAt: "asc" } },
              exampleTrades: { orderBy: { createdAt: "asc" } },
            },
          },
        },
      });
      if (!workspace) throw new WorkspaceSettingsNotFoundError();
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "settings.workspace.export",
          resourceType: "workspace",
          resourceId: input.workspaceId,
          outcome: "COMPLETED",
          requestId: input.requestId,
          metadata: {
            strategies: workspace.strategies.length,
            trades: workspace.trades.length,
            journalEntries: workspace.journalEntries.length,
            reviewSessions: workspace.reviewSessions.length,
            playbooks: workspace.playbooks.length,
          },
        },
      });
      return workspace;
    });
  }
}

function assertTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
  } catch {
    throw new WorkspaceTimezoneInvalidError();
  }
}
