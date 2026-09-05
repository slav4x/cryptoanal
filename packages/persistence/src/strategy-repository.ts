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

export class StrategyNameConflictError extends Error {
  public constructor() {
    super("A strategy with this name already exists in the workspace");
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
}
