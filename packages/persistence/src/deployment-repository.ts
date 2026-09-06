import { createHash, randomUUID } from "node:crypto";
import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";

type PersistedDeploymentStatus = "DRAFT" | "READY" | "RUNNING" | "PAUSED" | "STOPPED" | "FAILED";

type PersistedDeploymentCommand = "START" | "PAUSE" | "RESUME" | "STOP";

export type CreateDeploymentInput = {
  workspaceId: string;
  strategyId: string;
  strategyVersionId: string;
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  exchangeAccountId: string;
};

export type ApplyDeploymentCommandInput = {
  workspaceId: string;
  deploymentId: string;
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  command: PersistedDeploymentCommand;
  expectedStatus: PersistedDeploymentStatus;
  reason: string;
  engineVersion: string;
};

export class DeploymentStrategyNotFoundError extends Error {}
export class DeploymentNotFoundError extends Error {}
export class DeploymentNotEligibleError extends Error {}
export class DeploymentVersionMismatchError extends Error {}
export class DeploymentValidationRequiredError extends Error {}
export class ActiveDeploymentExistsError extends Error {}
export class DeploymentStatusConflictError extends Error {}
export class DeploymentCommandNotAllowedError extends Error {}
export class DeploymentIdempotencyConflictError extends Error {}

export class DeploymentRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public list(workspaceId: string) {
    return this.prisma.deployment.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: deploymentSelect,
    });
  }

  public async create(input: CreateDeploymentInput) {
    return this.prisma.$transaction(async (transaction) => {
      await lockIdempotencyKey(transaction, input.workspaceId, input.idempotencyKey);
      const replayed = await replayCommand(
        transaction,
        input.workspaceId,
        input.idempotencyKey,
        "deployment.create",
        "strategy",
        input.strategyId,
      );
      if (replayed) return replayed;

      await lockAccount(transaction, input.workspaceId, input.exchangeAccountId);
      const strategies = await transaction.$queryRaw<
        Array<{ id: string; status: string; activeVersionId: string | null }>
      >(Prisma.sql`
        SELECT "id", "status", "activeVersionId"
        FROM "Strategy"
        WHERE "id" = ${input.strategyId} AND "workspaceId" = ${input.workspaceId}
        FOR UPDATE
      `);
      const strategy = strategies[0];
      if (!strategy) throw new DeploymentStrategyNotFoundError();

      const replayedAfterLock = await replayCommand(
        transaction,
        input.workspaceId,
        input.idempotencyKey,
        "deployment.create",
        "strategy",
        input.strategyId,
      );
      if (replayedAfterLock) return replayedAfterLock;

      if (strategy.status !== "APPROVED") throw new DeploymentNotEligibleError();
      if (strategy.activeVersionId !== input.strategyVersionId) {
        throw new DeploymentVersionMismatchError();
      }

      const version = await transaction.strategyVersion.findFirst({
        where: {
          id: input.strategyVersionId,
          strategyId: input.strategyId,
          workspaceId: input.workspaceId,
        },
        select: { id: true, configHash: true },
      });
      if (!version) throw new DeploymentVersionMismatchError();

      const passedValidation = await transaction.validationRun.findFirst({
        where: {
          workspaceId: input.workspaceId,
          strategyId: input.strategyId,
          strategyVersionId: input.strategyVersionId,
          configHash: version.configHash,
          status: "COMPLETED",
          verdict: "PASSED",
        },
        orderBy: { completedAt: "desc" },
        select: { id: true },
      });
      if (!passedValidation) throw new DeploymentValidationRequiredError();

      await assertNoActiveDeployment(transaction, input.workspaceId, input.exchangeAccountId);

      const deployment = await transaction.deployment.create({
        data: {
          workspaceId: input.workspaceId,
          strategyId: input.strategyId,
          strategyVersionId: input.strategyVersionId,
          environment: "DRY_RUN",
          exchangeAccountId: input.exchangeAccountId,
          status: "READY",
          createdByActorId: input.actorId,
        },
        select: deploymentSelect,
      });

      await transaction.commandReceipt.create({
        data: {
          workspaceId: input.workspaceId,
          idempotencyKey: input.idempotencyKey,
          command: "deployment.create",
          resourceType: "strategy",
          resourceId: input.strategyId,
          result: { deploymentId: deployment.id },
        },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "deployment.create",
          resourceType: "deployment",
          resourceId: deployment.id,
          outcome: "COMPLETED",
          reason: "Prepared approved strategy for dry-run execution",
          requestId: input.requestId,
          metadata: {
            strategyId: input.strategyId,
            strategyVersionId: input.strategyVersionId,
            validationRunId: passedValidation.id,
            exchangeAccountId: input.exchangeAccountId,
          },
        },
      });

      return { deployment, replayed: false };
    });
  }

  public async applyCommand(input: ApplyDeploymentCommandInput) {
    const commandName = `deployment.command.${input.command.toLowerCase()}`;

    return this.prisma.$transaction(async (transaction) => {
      await lockIdempotencyKey(transaction, input.workspaceId, input.idempotencyKey);
      const replayed = await replayCommand(
        transaction,
        input.workspaceId,
        input.idempotencyKey,
        commandName,
        "deployment",
        input.deploymentId,
      );
      if (replayed) return replayed;

      const deployments = await transaction.$queryRaw<
        Array<{
          id: string;
          strategyId: string;
          strategyVersionId: string;
          exchangeAccountId: string;
          environment: string;
          status: string;
        }>
      >(Prisma.sql`
        SELECT "id", "strategyId", "strategyVersionId", "exchangeAccountId", "environment", "status"
        FROM "Deployment"
        WHERE "id" = ${input.deploymentId} AND "workspaceId" = ${input.workspaceId}
        FOR UPDATE
      `);
      const deployment = deployments[0];
      if (!deployment) throw new DeploymentNotFoundError();

      const replayedAfterLock = await replayCommand(
        transaction,
        input.workspaceId,
        input.idempotencyKey,
        commandName,
        "deployment",
        input.deploymentId,
      );
      if (replayedAfterLock) return replayedAfterLock;

      if (deployment.status !== input.expectedStatus) {
        throw new DeploymentStatusConflictError();
      }
      if (!isCommandAllowed(deployment.status, input.command)) {
        throw new DeploymentCommandNotAllowedError();
      }

      const now = new Date();
      let nextStatus: PersistedDeploymentStatus;
      let executionRunId: string;

      if (input.command === "START") {
        await lockAccount(transaction, input.workspaceId, deployment.exchangeAccountId);
        await assertNoActiveDeployment(
          transaction,
          input.workspaceId,
          deployment.exchangeAccountId,
          deployment.id,
        );

        const version = await transaction.strategyVersion.findFirst({
          where: {
            id: deployment.strategyVersionId,
            strategyId: deployment.strategyId,
            workspaceId: input.workspaceId,
          },
          select: { config: true, configHash: true },
        });
        if (!version) throw new DeploymentVersionMismatchError();

        const validation = await transaction.validationRun.findFirst({
          where: {
            workspaceId: input.workspaceId,
            strategyId: deployment.strategyId,
            strategyVersionId: deployment.strategyVersionId,
            configHash: version.configHash,
            status: "COMPLETED",
            verdict: "PASSED",
          },
          orderBy: { completedAt: "desc" },
          select: {
            id: true,
            datasetId: true,
            engineVersion: true,
            completedAt: true,
          },
        });
        if (!validation) throw new DeploymentValidationRequiredError();

        executionRunId = randomUUID();
        const context = {
          schemaVersion: 1,
          workspaceId: input.workspaceId,
          deploymentId: deployment.id,
          executionRunId,
          strategyId: deployment.strategyId,
          strategyVersionId: deployment.strategyVersionId,
          environment: "dry-run",
          exchangeAccountId: deployment.exchangeAccountId,
          configHash: version.configHash,
          strategyConfig: version.config,
          validation: {
            runId: validation.id,
            datasetId: validation.datasetId,
            engineVersion: validation.engineVersion,
            completedAt: validation.completedAt?.toISOString() ?? null,
          },
          executionEngineVersion: input.engineVersion,
          clock: "system",
          startedAt: now.toISOString(),
        } satisfies Prisma.InputJsonObject;
        const contextHash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
        await transaction.executionRun.create({
          data: {
            id: executionRunId,
            workspaceId: input.workspaceId,
            deploymentId: deployment.id,
            strategyVersionId: deployment.strategyVersionId,
            environment: "DRY_RUN",
            configHash: version.configHash,
            context,
            contextHash,
            engineVersion: input.engineVersion,
            status: "RUNNING",
            createdByActorId: input.actorId,
            startedAt: now,
          },
        });
        nextStatus = "RUNNING";
        await transaction.strategy.update({
          where: { id: deployment.strategyId },
          data: { status: "DEPLOYED", updatedByActorId: input.actorId },
        });
      } else {
        const executionRun = await transaction.executionRun.findFirst({
          where: {
            workspaceId: input.workspaceId,
            deploymentId: deployment.id,
            status: "RUNNING",
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (!executionRun) throw new DeploymentCommandNotAllowedError();
        executionRunId = executionRun.id;

        if (input.command === "PAUSE") {
          nextStatus = "PAUSED";
          await transaction.strategy.update({
            where: { id: deployment.strategyId },
            data: { status: "PAUSED", updatedByActorId: input.actorId },
          });
        } else if (input.command === "RESUME") {
          await lockAccount(transaction, input.workspaceId, deployment.exchangeAccountId);
          await assertNoActiveDeployment(
            transaction,
            input.workspaceId,
            deployment.exchangeAccountId,
            deployment.id,
          );
          nextStatus = "RUNNING";
          await transaction.strategy.update({
            where: { id: deployment.strategyId },
            data: { status: "DEPLOYED", updatedByActorId: input.actorId },
          });
        } else {
          nextStatus = "STOPPED";
          await transaction.executionRun.update({
            where: { id: executionRun.id },
            data: { status: "COMPLETED", stoppedAt: now },
          });
          await transaction.strategy.update({
            where: { id: deployment.strategyId },
            data: { status: "APPROVED", updatedByActorId: input.actorId },
          });
        }
      }

      await transaction.deployment.update({
        where: { id: deployment.id },
        data: { status: nextStatus },
      });
      await transaction.commandReceipt.create({
        data: {
          workspaceId: input.workspaceId,
          idempotencyKey: input.idempotencyKey,
          command: commandName,
          resourceType: "deployment",
          resourceId: deployment.id,
          result: { deploymentId: deployment.id, executionRunId },
        },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: commandName,
          resourceType: "deployment",
          resourceId: deployment.id,
          outcome: "COMPLETED",
          reason: input.reason,
          requestId: input.requestId,
          metadata: {
            from: deployment.status,
            to: nextStatus,
            executionRunId,
          },
        },
      });

      const result = await transaction.deployment.findUniqueOrThrow({
        where: { id: deployment.id },
        select: deploymentSelect,
      });
      return { deployment: result, replayed: false };
    });
  }
}

async function replayCommand(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  idempotencyKey: string,
  command: string,
  resourceType: string,
  resourceId: string,
) {
  const receipt = await transaction.commandReceipt.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    select: { command: true, resourceType: true, resourceId: true, result: true },
  });
  if (!receipt) return null;
  if (
    receipt.command !== command ||
    receipt.resourceType !== resourceType ||
    receipt.resourceId !== resourceId
  ) {
    throw new DeploymentIdempotencyConflictError();
  }

  const deploymentId = getResultString(receipt.result, "deploymentId");
  if (!deploymentId) throw new DeploymentIdempotencyConflictError();
  const deployment = await transaction.deployment.findFirst({
    where: { id: deploymentId, workspaceId },
    select: deploymentSelect,
  });
  if (!deployment) throw new DeploymentIdempotencyConflictError();
  return { deployment, replayed: true };
}

async function lockAccount(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  exchangeAccountId: string,
) {
  await transaction.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${exchangeAccountId}`}))
  `);
}

async function lockIdempotencyKey(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  idempotencyKey: string,
) {
  await transaction.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`command:${workspaceId}:${idempotencyKey}`}))
  `);
}

async function assertNoActiveDeployment(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  exchangeAccountId: string,
  excludedDeploymentId?: string,
) {
  const active = await transaction.deployment.findFirst({
    where: {
      workspaceId,
      exchangeAccountId,
      status: { in: ["READY", "RUNNING", "PAUSED"] },
      ...(excludedDeploymentId ? { id: { not: excludedDeploymentId } } : {}),
    },
    select: { id: true },
  });
  if (active) throw new ActiveDeploymentExistsError();
}

function isCommandAllowed(status: string, command: PersistedDeploymentCommand) {
  return (
    ((status === "READY" || status === "STOPPED") && command === "START") ||
    (status === "RUNNING" && (command === "PAUSE" || command === "STOP")) ||
    (status === "PAUSED" && (command === "RESUME" || command === "STOP"))
  );
}

function getResultString(result: Prisma.JsonValue, key: string) {
  if (!result || Array.isArray(result) || typeof result !== "object") return null;
  const value = result[key];
  return typeof value === "string" ? value : null;
}

export const deploymentSelect = {
  id: true,
  environment: true,
  exchangeAccountId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  strategy: { select: { id: true, name: true } },
  strategyVersion: { select: { id: true, version: true } },
  executionRuns: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: {
      id: true,
      status: true,
      contextHash: true,
      engineVersion: true,
      startedAt: true,
      stoppedAt: true,
      createdAt: true,
    },
  },
} as const;
