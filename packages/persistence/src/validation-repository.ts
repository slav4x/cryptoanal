import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";
import { createHash } from "node:crypto";

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

export type ClaimedValidationJob = {
  jobId: string;
  runId: string;
  workspaceId: string;
  kind: ValidationJobKind;
  input: Prisma.JsonValue;
  config: Prisma.JsonValue;
  configHash: string;
  datasetSnapshotId: string | null;
};

export type CompleteValidationJobInput = {
  workerId: string;
  jobId: string;
  runId: string;
  workspaceId: string;
  datasetSnapshotId: string;
  metrics: Prisma.InputJsonValue;
  verdict: "PASSED" | "FAILED" | "WARNING";
  trades: ValidationTradePersistenceInput[];
};

export type ValidationDatasetCandlePersistenceInput = {
  symbol: string;
  openTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  turnover: string;
};

export type MaterializeValidationDatasetInput = {
  workerId: string;
  jobId: string;
  runId: string;
  workspaceId: string;
  source: string;
  exchange: string;
  instrumentType: string;
  timeframe: string;
  symbols: string[];
  candles: ValidationDatasetCandlePersistenceInput[];
};

export type ValidationTradePersistenceInput = {
  symbol: string;
  side: "BUY" | "SELL";
  openedAt: Date;
  closedAt: Date;
  entryPrice: string;
  exitPrice: string;
  quantity: string;
  netPnl: string;
  fees: string;
  exitReason: string;
};

export type FailValidationJobInput = {
  workerId: string;
  jobId: string;
  runId: string;
  workspaceId: string;
  failureCode: string;
  failureMessage: string;
};

export class ValidationStrategyNotFoundError extends Error {}
export class ValidationVersionMismatchError extends Error {}
export class ValidationNotEligibleError extends Error {}
export class ValidationAlreadyActiveError extends Error {}
export class ValidationDatasetConflictError extends Error {}

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

  public get(workspaceId: string, validationRunId: string, tradePage: number, tradeLimit: number) {
    return this.prisma.validationRun.findFirst({
      where: { id: validationRunId, workspaceId },
      select: {
        ...validationRunSelect,
        trades: {
          orderBy: { closedAt: "desc" },
          skip: (tradePage - 1) * tradeLimit,
          take: tradeLimit,
          select: {
            symbol: true,
            side: true,
            openedAt: true,
            closedAt: true,
            entryPrice: true,
            exitPrice: true,
            quantity: true,
            netPnl: true,
            fees: true,
            exitReason: true,
          },
        },
        _count: { select: { trades: true } },
      },
    });
  }

  public async claimNext(
    workerId: string,
    staleBefore: Date,
  ): Promise<ClaimedValidationJob | null> {
    return this.prisma.$transaction(async (transaction) => {
      const jobs = await transaction.$queryRaw<
        Array<{
          id: string;
          workspaceId: string;
          kind: ValidationJobKind;
          input: Prisma.JsonValue;
          startedAt: Date | null;
        }>
      >(Prisma.sql`
        SELECT "id", "workspaceId", "kind", "input", "startedAt"
        FROM "Job"
        WHERE "kind" IN ('BACKTEST', 'WALK_FORWARD')
          AND (
            "status" = 'QUEUED'
            OR (
              "status" = 'RUNNING'
              AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore})
            )
          )
        ORDER BY "queuedAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const job = jobs[0];
      if (!job) return null;

      const validationRunId = getValidationRunId(job.input);
      if (!validationRunId) {
        await transaction.job.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            failureCode: "INVALID_JOB_INPUT",
            failureMessage: "Validation job has no validationRunId",
            completedAt: new Date(),
            lockedBy: null,
            lockedAt: null,
          },
        });
        return null;
      }

      const run = await transaction.validationRun.findFirst({
        where: {
          id: validationRunId,
          workspaceId: job.workspaceId,
          status: { in: ["QUEUED", "RUNNING"] },
        },
        select: {
          id: true,
          workspaceId: true,
          kind: true,
          input: true,
          startedAt: true,
          configHash: true,
          datasetSnapshotId: true,
          strategyVersion: { select: { config: true, configHash: true } },
        },
      });
      if (!run || run.kind !== job.kind || run.configHash !== run.strategyVersion.configHash) {
        await transaction.job.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            failureCode: "INVALID_VALIDATION_RUN",
            failureMessage: "Validation run is missing or does not match the queued job",
            completedAt: new Date(),
            lockedBy: null,
            lockedAt: null,
          },
        });
        return null;
      }

      const now = new Date();
      await transaction.job.update({
        where: { id: job.id },
        data: {
          status: "RUNNING",
          progress: 1,
          attempts: { increment: 1 },
          lockedBy: workerId,
          lockedAt: now,
          startedAt: job.startedAt ?? now,
          failureCode: null,
          failureMessage: null,
        },
      });
      await transaction.validationRun.update({
        where: { id: run.id },
        data: {
          status: "RUNNING",
          startedAt: run.startedAt ?? now,
          failureCode: null,
          failureMessage: null,
        },
      });

      return {
        jobId: job.id,
        runId: run.id,
        workspaceId: run.workspaceId,
        kind: run.kind,
        input: run.input,
        config: run.strategyVersion.config,
        configHash: run.configHash,
        datasetSnapshotId: run.datasetSnapshotId,
      };
    });
  }

  public async updateProgress(jobId: string, workerId: string, progress: number): Promise<boolean> {
    const result = await this.prisma.job.updateMany({
      where: { id: jobId, status: "RUNNING", lockedBy: workerId },
      data: {
        progress: Math.max(1, Math.min(99, Math.round(progress))),
        lockedAt: new Date(),
      },
    });
    return result.count === 1;
  }

  public async complete(input: CompleteValidationJobInput): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const job = await transaction.job.updateMany({
        where: { id: input.jobId, status: "RUNNING", lockedBy: input.workerId },
        data: { lockedAt: new Date() },
      });
      if (job.count !== 1) throw new Error("Validation job lease was lost before completion");

      const completedAt = new Date();
      const run = await transaction.validationRun.updateMany({
        where: {
          id: input.runId,
          workspaceId: input.workspaceId,
          status: "RUNNING",
          datasetSnapshotId: input.datasetSnapshotId,
        },
        data: {
          status: "COMPLETED",
          verdict: input.verdict,
          metrics: input.metrics,
          failureCode: null,
          failureMessage: null,
          completedAt,
        },
      });
      if (run.count !== 1) {
        throw new Error("Validation run has no matching immutable dataset snapshot");
      }
      for (let offset = 0; offset < input.trades.length; offset += validationTradeBatchSize) {
        await transaction.validationTrade.createMany({
          data: input.trades.slice(offset, offset + validationTradeBatchSize).map((trade) => ({
            ...trade,
            workspaceId: input.workspaceId,
            validationRunId: input.runId,
          })),
        });
      }
      await transaction.job.update({
        where: { id: input.jobId },
        data: {
          status: "COMPLETED",
          progress: 100,
          resultRef: input.runId,
          completedAt,
          lockedBy: null,
          lockedAt: null,
          failureCode: null,
          failureMessage: null,
        },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.workerId,
          action: "validation.run.complete",
          resourceType: "validation-run",
          resourceId: input.runId,
          outcome: "COMPLETED",
          reason: `Validation completed with ${input.verdict.toLowerCase()} verdict`,
          requestId: `job:${input.jobId}`,
          metadata: { jobId: input.jobId, datasetSnapshotId: input.datasetSnapshotId },
        },
      });
    });
  }

  public async materializeDataset(input: MaterializeValidationDatasetInput) {
    if (input.candles.length === 0) throw new ValidationDatasetConflictError();
    const symbols = [...new Set(input.symbols)].sort();
    const symbolSet = new Set(symbols);
    if (input.candles.some((candle) => !symbolSet.has(candle.symbol))) {
      throw new ValidationDatasetConflictError();
    }
    const candles = canonicalizeDatasetCandles(input.candles);
    const candleSymbols = [...new Set(candles.map((candle) => candle.symbol))].sort();
    if (JSON.stringify(candleSymbols) !== JSON.stringify(symbols)) {
      throw new ValidationDatasetConflictError();
    }
    const contentHash = hashDatasetCandles(candles, input.timeframe);
    const startsAt = candles.reduce(
      (earliest, candle) => (candle.openTime < earliest ? candle.openTime : earliest),
      candles[0]!.openTime,
    );
    const endsAt = candles.reduce(
      (latest, candle) => (candle.openTime > latest ? candle.openTime : latest),
      candles[0]!.openTime,
    );

    return this.prisma.$transaction(
      async (transaction) => {
        const lease = await transaction.job.updateMany({
          where: { id: input.jobId, status: "RUNNING", lockedBy: input.workerId },
          data: { lockedAt: new Date() },
        });
        if (lease.count !== 1) {
          throw new Error("Validation job lease was lost before dataset materialization");
        }

        await transaction.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${`dataset:${input.workspaceId}:${contentHash}`}))
      `);
        let snapshot = await transaction.datasetSnapshot.findUnique({
          where: {
            workspaceId_contentHash: {
              workspaceId: input.workspaceId,
              contentHash,
            },
          },
          select: datasetSnapshotSelect,
        });
        let created = false;
        if (snapshot) {
          if (
            snapshot.schemaVersion !== 1 ||
            snapshot.source !== input.source ||
            snapshot.exchange !== input.exchange ||
            snapshot.instrumentType !== input.instrumentType ||
            snapshot.timeframe !== input.timeframe ||
            snapshot.candleCount !== candles.length ||
            snapshot.startsAt.getTime() !== startsAt.getTime() ||
            snapshot.endsAt.getTime() !== endsAt.getTime() ||
            JSON.stringify(readStringArray(snapshot.symbols)) !== JSON.stringify(symbols)
          ) {
            throw new ValidationDatasetConflictError();
          }
        } else {
          snapshot = await transaction.datasetSnapshot.create({
            data: {
              workspaceId: input.workspaceId,
              schemaVersion: 1,
              source: input.source,
              exchange: input.exchange,
              instrumentType: input.instrumentType,
              timeframe: input.timeframe,
              symbols,
              startsAt,
              endsAt,
              candleCount: candles.length,
              contentHash,
            },
            select: datasetSnapshotSelect,
          });
          for (let offset = 0; offset < candles.length; offset += datasetCandleBatchSize) {
            await transaction.datasetSnapshotCandle.createMany({
              data: candles
                .slice(offset, offset + datasetCandleBatchSize)
                .map((candle) => ({ ...candle, datasetSnapshotId: snapshot!.id })),
            });
          }
          created = true;
        }

        const linked = await transaction.validationRun.updateMany({
          where: {
            id: input.runId,
            workspaceId: input.workspaceId,
            status: "RUNNING",
            OR: [{ datasetSnapshotId: null }, { datasetSnapshotId: snapshot.id }],
          },
          data: {
            datasetSnapshotId: snapshot.id,
            datasetId: `dataset-snapshot:${snapshot.id}`,
            datasetAsOf: snapshot.endsAt,
          },
        });
        if (linked.count !== 1) throw new ValidationDatasetConflictError();

        await transaction.job.update({
          where: { id: input.jobId },
          data: { progress: 80, lockedAt: new Date() },
        });
        await transaction.auditEvent.create({
          data: {
            workspaceId: input.workspaceId,
            actorId: input.workerId,
            action: created ? "validation.dataset.materialize" : "validation.dataset.reuse",
            resourceType: "dataset-snapshot",
            resourceId: snapshot.id,
            outcome: "COMPLETED",
            reason: created
              ? "Immutable validation dataset materialized"
              : "Dataset snapshot reused",
            requestId: `job:${input.jobId}`,
            metadata: { validationRunId: input.runId, contentHash: snapshot.contentHash },
          },
        });

        return snapshot;
      },
      { maxWait: 10_000, timeout: 240_000 },
    );
  }

  public async getDatasetSnapshot(workspaceId: string, datasetSnapshotId: string) {
    const snapshot = await this.prisma.datasetSnapshot.findFirst({
      where: { id: datasetSnapshotId, workspaceId },
      select: {
        ...datasetSnapshotSelect,
        candles: {
          orderBy: [{ symbol: "asc" }, { openTime: "asc" }],
          select: {
            symbol: true,
            openTime: true,
            open: true,
            high: true,
            low: true,
            close: true,
            volume: true,
            turnover: true,
          },
        },
      },
    });
    if (!snapshot) return null;
    const contentHash = hashDatasetCandles(
      snapshot.candles.map((candle) => ({
        symbol: candle.symbol,
        openTime: candle.openTime,
        open: candle.open.toFixed(),
        high: candle.high.toFixed(),
        low: candle.low.toFixed(),
        close: candle.close.toFixed(),
        volume: candle.volume.toFixed(),
        turnover: candle.turnover.toFixed(),
      })),
      snapshot.timeframe,
    );
    if (snapshot.candleCount !== snapshot.candles.length || snapshot.contentHash !== contentHash) {
      throw new ValidationDatasetConflictError();
    }
    return snapshot;
  }

  public async fail(input: FailValidationJobInput): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const job = await transaction.job.updateMany({
        where: { id: input.jobId, status: "RUNNING", lockedBy: input.workerId },
        data: { lockedAt: new Date() },
      });
      if (job.count !== 1) {
        throw new Error("Validation job lease was lost before failure persistence");
      }

      const completedAt = new Date();
      await transaction.validationRun.update({
        where: { id: input.runId },
        data: {
          status: "FAILED",
          verdict: "FAILED",
          failureCode: input.failureCode,
          failureMessage: input.failureMessage,
          completedAt,
        },
      });
      await transaction.job.update({
        where: { id: input.jobId },
        data: {
          status: "FAILED",
          failureCode: input.failureCode,
          failureMessage: input.failureMessage,
          completedAt,
          lockedBy: null,
          lockedAt: null,
        },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.workerId,
          action: "validation.run.fail",
          resourceType: "validation-run",
          resourceId: input.runId,
          outcome: "FAILED",
          reason: input.failureMessage,
          requestId: `job:${input.jobId}`,
          metadata: { jobId: input.jobId, failureCode: input.failureCode },
        },
      });
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

const datasetSnapshotSelect = {
  id: true,
  schemaVersion: true,
  source: true,
  exchange: true,
  instrumentType: true,
  timeframe: true,
  symbols: true,
  startsAt: true,
  endsAt: true,
  candleCount: true,
  contentHash: true,
  createdAt: true,
} as const;

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
  metrics: true,
  failureCode: true,
  failureMessage: true,
  queuedAt: true,
  startedAt: true,
  completedAt: true,
  strategy: { select: { id: true, name: true } },
  strategyVersion: { select: { id: true, version: true } },
  datasetSnapshot: { select: datasetSnapshotSelect },
} as const;

const validationTradeBatchSize = 1_000;
const datasetCandleBatchSize = 1_000;

function readStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value].sort()
    : [];
}

function canonicalizeDatasetCandles(
  candles: ValidationDatasetCandlePersistenceInput[],
): ValidationDatasetCandlePersistenceInput[] {
  return candles
    .map((candle) => ({
      ...candle,
      open: new Prisma.Decimal(candle.open).toDecimalPlaces(18).toFixed(),
      high: new Prisma.Decimal(candle.high).toDecimalPlaces(18).toFixed(),
      low: new Prisma.Decimal(candle.low).toDecimalPlaces(18).toFixed(),
      close: new Prisma.Decimal(candle.close).toDecimalPlaces(18).toFixed(),
      volume: new Prisma.Decimal(candle.volume).toDecimalPlaces(8).toFixed(),
      turnover: new Prisma.Decimal(candle.turnover).toDecimalPlaces(8).toFixed(),
    }))
    .sort(
      (left, right) =>
        left.symbol.localeCompare(right.symbol) ||
        left.openTime.getTime() - right.openTime.getTime(),
    );
}

function hashDatasetCandles(candles: ValidationDatasetCandlePersistenceInput[], timeframe: string) {
  const hasher = createHash("sha256");
  for (const candle of candles) {
    hasher.update(
      [
        candle.symbol,
        timeframe,
        candle.openTime.toISOString(),
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
        candle.turnover,
      ].join("|"),
    );
    hasher.update("\n");
  }
  return hasher.digest("hex");
}
