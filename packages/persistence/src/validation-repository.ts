import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";

type ValidationJobKind = "BACKTEST" | "WALK_FORWARD";

export type QueueValidationRunInput = {
  workspaceId: string;
  strategyId: string;
  strategyVersionId: string;
  actorId: string;
  requestId: string;
  kind: ValidationJobKind;
  datasetId: string;
  datasetAsOf: Date;
  engineVersion: string;
  configHash: string;
  input: Prisma.InputJsonValue;
  idempotencyKey: string;
};

export class ValidationStrategyNotFoundError extends Error {}
export class ValidationVersionMismatchError extends Error {}
export class ValidationNotEligibleError extends Error {}
export class ValidationAlreadyActiveError extends Error {}

export class ValidationRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public list(workspaceId: string) {
    return this.prisma.validationRun.findMany({
      where: { workspaceId },
      orderBy: { queuedAt: "desc" },
      take: 200,
      select: validationRunSelect,
    });
  }

  public async queue(input: QueueValidationRunInput) {
    return this.prisma.$transaction(async (transaction) => {
      const existingJob = await transaction.job.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: input.workspaceId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { id: true, status: true, input: true },
      });
      if (existingJob) {
        const validationRunId = getValidationRunId(existingJob.input);
        const run = validationRunId
          ? await transaction.validationRun.findFirst({
              where: { id: validationRunId, workspaceId: input.workspaceId },
              select: validationRunSelect,
            })
          : null;
        if (run) return { run, job: existingJob, replayed: true };
      }

      const lockedStrategies = await transaction.$queryRaw<
        Array<{ id: string; status: string }>
      >(Prisma.sql`
        SELECT "id", "status"
        FROM "Strategy"
        WHERE "id" = ${input.strategyId} AND "workspaceId" = ${input.workspaceId}
        FOR UPDATE
      `);
      const strategy = lockedStrategies[0];
      if (!strategy) throw new ValidationStrategyNotFoundError();
      if (strategy.status !== "DRAFT") throw new ValidationNotEligibleError();

      const latestVersion = await transaction.strategyVersion.findFirst({
        where: { strategyId: input.strategyId, workspaceId: input.workspaceId },
        orderBy: { version: "desc" },
        select: { id: true, configHash: true },
      });
      if (!latestVersion || latestVersion.id !== input.strategyVersionId) {
        throw new ValidationVersionMismatchError();
      }
      if (latestVersion.configHash !== input.configHash) {
        throw new ValidationVersionMismatchError();
      }

      const activeRuns = await transaction.validationRun.count({
        where: {
          strategyId: input.strategyId,
          workspaceId: input.workspaceId,
          status: { in: ["QUEUED", "RUNNING"] },
        },
      });
      if (activeRuns > 0) throw new ValidationAlreadyActiveError();

      const run = await transaction.validationRun.create({
        data: {
          workspaceId: input.workspaceId,
          strategyId: input.strategyId,
          strategyVersionId: input.strategyVersionId,
          kind: input.kind,
          datasetId: input.datasetId,
          datasetAsOf: input.datasetAsOf,
          engineVersion: input.engineVersion,
          configHash: input.configHash,
          input: input.input,
          createdByActorId: input.actorId,
        },
        select: validationRunSelect,
      });
      const job = await transaction.job.create({
        data: {
          workspaceId: input.workspaceId,
          kind: input.kind,
          input: { validationRunId: run.id },
          idempotencyKey: input.idempotencyKey,
          createdByActorId: input.actorId,
        },
        select: { id: true, status: true, input: true },
      });
      await transaction.strategy.update({
        where: { id: input.strategyId },
        data: { status: "VALIDATING", updatedByActorId: input.actorId },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "validation.run.queue",
          resourceType: "validation-run",
          resourceId: run.id,
          outcome: "ACCEPTED",
          reason: `Queued ${input.kind.toLowerCase()} validation`,
          requestId: input.requestId,
          metadata: {
            strategyId: input.strategyId,
            strategyVersionId: input.strategyVersionId,
            jobId: job.id,
          },
        },
      });

      return { run, job, replayed: false };
    });
  }
}

function getValidationRunId(input: Prisma.JsonValue): string | null {
  if (!input || Array.isArray(input) || typeof input !== "object") return null;
  const validationRunId = input.validationRunId;
  return typeof validationRunId === "string" ? validationRunId : null;
}

const validationRunSelect = {
  id: true,
  kind: true,
  status: true,
  verdict: true,
  datasetId: true,
  datasetAsOf: true,
  engineVersion: true,
  configHash: true,
  input: true,
  failureCode: true,
  failureMessage: true,
  queuedAt: true,
  startedAt: true,
  completedAt: true,
  strategy: { select: { id: true, name: true } },
  strategyVersion: { select: { id: true, version: true } },
} as const;
