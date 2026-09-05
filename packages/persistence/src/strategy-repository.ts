import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";

export type CreateStrategyInput = {
  workspaceId: string;
  actorId: string;
  name: string;
  description: string | null;
  configSchemaVersion: number;
  config: Prisma.InputJsonValue;
  configHash: string;
};

export type CreateStrategyVersionInput = Omit<CreateStrategyInput, "name" | "description"> & {
  strategyId: string;
  changeSummary: string;
};

type PersistedStrategyStatus =
  "DRAFT" | "VALIDATING" | "APPROVED" | "DEPLOYED" | "PAUSED" | "ARCHIVED";

export type TransitionStrategyStatusInput = {
  workspaceId: string;
  strategyId: string;
  actorId: string;
  requestId: string;
  expectedStatus: PersistedStrategyStatus;
  targetStatus: "DRAFT" | "APPROVED" | "ARCHIVED";
  reason: string;
};

export class StrategyNameConflictError extends Error {
  public constructor() {
    super("A strategy with this name already exists in the workspace");
  }
}

export class StrategyNotFoundError extends Error {
  public constructor() {
    super("Strategy not found in workspace");
  }
}

export class StrategyConfigUnchangedError extends Error {
  public constructor() {
    super("Strategy configuration is unchanged");
  }
}

export class StrategyVersionNotAllowedError extends Error {
  public constructor() {
    super("Strategy status does not allow creating a version");
  }
}

export class StrategyStatusConflictError extends Error {
  public constructor() {
    super("Strategy status changed before the command was applied");
  }
}

export class StrategyRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async createWithInitialVersion(input: CreateStrategyInput) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const strategy = await transaction.strategy.create({
          data: {
            workspaceId: input.workspaceId,
            name: input.name,
            description: input.description,
            createdByActorId: input.actorId,
            updatedByActorId: input.actorId,
          },
          select: { id: true, name: true, status: true },
        });
        const version = await transaction.strategyVersion.create({
          data: {
            workspaceId: input.workspaceId,
            strategyId: strategy.id,
            version: 1,
            configSchemaVersion: input.configSchemaVersion,
            config: input.config,
            configHash: input.configHash,
            changeSummary: "Initial strategy version",
            createdByActorId: input.actorId,
          },
          select: { id: true, version: true, configHash: true, createdAt: true },
        });

        return { strategy, version };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new StrategyNameConflictError();
      }
      throw error;
    }
  }

  public getDetail(workspaceId: string, strategyId: string) {
    return this.prisma.strategy.findFirst({
      where: { id: strategyId, workspaceId },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        updatedAt: true,
        activeVersion: {
          select: { id: true, version: true, configHash: true, createdAt: true },
        },
        versions: {
          orderBy: { version: "desc" },
          take: 100,
          select: {
            id: true,
            version: true,
            configSchemaVersion: true,
            config: true,
            configHash: true,
            changeSummary: true,
            createdByActorId: true,
            createdAt: true,
          },
        },
        validationRuns: {
          orderBy: { queuedAt: "desc" },
          take: 20,
          select: {
            id: true,
            kind: true,
            status: true,
            verdict: true,
            completedAt: true,
            strategyVersion: { select: { id: true, version: true } },
          },
        },
        deployments: {
          orderBy: { updatedAt: "desc" },
          take: 1,
          select: {
            id: true,
            environment: true,
            status: true,
            updatedAt: true,
            strategyVersion: { select: { version: true } },
          },
        },
        _count: { select: { versions: true } },
      },
    });
  }

  public async createVersion(input: CreateStrategyVersionInput) {
    return this.prisma.$transaction(async (transaction) => {
      const lockedStrategies = await transaction.$queryRaw<
        Array<{ id: string; status: PersistedStrategyStatus }>
      >(Prisma.sql`
        SELECT "id", "status"
        FROM "Strategy"
        WHERE "id" = ${input.strategyId} AND "workspaceId" = ${input.workspaceId}
        FOR UPDATE
      `);
      const lockedStrategy = lockedStrategies[0];
      if (!lockedStrategy) throw new StrategyNotFoundError();
      if (lockedStrategy.status !== "DRAFT" && lockedStrategy.status !== "APPROVED") {
        throw new StrategyVersionNotAllowedError();
      }

      const latestVersion = await transaction.strategyVersion.findFirst({
        where: { strategyId: input.strategyId, workspaceId: input.workspaceId },
        orderBy: { version: "desc" },
        select: { version: true, configHash: true },
      });
      if (!latestVersion) throw new StrategyNotFoundError();
      if (latestVersion.configHash === input.configHash) {
        throw new StrategyConfigUnchangedError();
      }

      const version = await transaction.strategyVersion.create({
        data: {
          workspaceId: input.workspaceId,
          strategyId: input.strategyId,
          version: latestVersion.version + 1,
          configSchemaVersion: input.configSchemaVersion,
          config: input.config,
          configHash: input.configHash,
          changeSummary: input.changeSummary,
          createdByActorId: input.actorId,
        },
        select: { id: true, version: true, configHash: true, createdAt: true },
      });
      await transaction.strategy.update({
        where: { id: input.strategyId },
        data: { updatedByActorId: input.actorId, status: "DRAFT", activeVersionId: null },
      });

      return version;
    });
  }

  public async transitionStatus(input: TransitionStrategyStatusInput) {
    return this.prisma.$transaction(async (transaction) => {
      const lockedStrategies = await transaction.$queryRaw<
        Array<{ id: string; status: PersistedStrategyStatus }>
      >(Prisma.sql`
        SELECT "id", "status"
        FROM "Strategy"
        WHERE "id" = ${input.strategyId} AND "workspaceId" = ${input.workspaceId}
        FOR UPDATE
      `);
      const current = lockedStrategies[0];
      if (!current) throw new StrategyNotFoundError();
      if (current.status !== input.expectedStatus) throw new StrategyStatusConflictError();

      const latestVersion =
        input.targetStatus === "APPROVED"
          ? await transaction.strategyVersion.findFirst({
              where: { strategyId: input.strategyId, workspaceId: input.workspaceId },
              orderBy: { version: "desc" },
              select: { id: true },
            })
          : null;
      if (input.targetStatus === "APPROVED" && !latestVersion) {
        throw new StrategyNotFoundError();
      }

      const strategy = await transaction.strategy.update({
        where: { id: input.strategyId },
        data: {
          status: input.targetStatus,
          activeVersionId: input.targetStatus === "APPROVED" ? (latestVersion?.id ?? null) : null,
          updatedByActorId: input.actorId,
        },
        select: { id: true, status: true },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "strategy.status.transition",
          resourceType: "strategy",
          resourceId: input.strategyId,
          outcome: "COMPLETED",
          reason: input.reason,
          requestId: input.requestId,
          metadata: { from: current.status, to: input.targetStatus },
        },
      });

      return strategy;
    });
  }
}
