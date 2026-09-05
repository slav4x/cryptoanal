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
          take: 1,
          select: {
            id: true,
            kind: true,
            status: true,
            verdict: true,
            completedAt: true,
            strategyVersion: { select: { version: true } },
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
      const lockedStrategies = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "Strategy"
        WHERE "id" = ${input.strategyId} AND "workspaceId" = ${input.workspaceId}
        FOR UPDATE
      `);
      if (lockedStrategies.length === 0) throw new StrategyNotFoundError();

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
        data: { updatedByActorId: input.actorId },
      });

      return version;
    });
  }
}
