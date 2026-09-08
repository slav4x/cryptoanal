import type { CryptoAnalPrismaClient } from "./client";
import type { Prisma } from "./generated/prisma/client";

type PersistedHealthCondition = {
  fingerprint: string;
  domain: string;
  code: string;
  severity: "warning" | "critical";
  title: string;
  description: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, string | number | boolean | null>;
};

export class HealthRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async getSignals(workspaceId: string, now = new Date()) {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    const [
      heartbeat,
      watchdogHeartbeat,
      markets,
      account,
      failedJobs24h,
      oldestQueuedJob,
      rejectedOrders24h,
      runtimeFailures,
      pendingOutbox,
      oldestPendingOutbox,
      riskStops24h,
      exchangeConnections,
      activeDeployments,
    ] = await Promise.all([
      this.prisma.workerHeartbeat.findFirst({
        where: { service: "worker" },
        orderBy: { lastSeenAt: "desc" },
        select: { lastSeenAt: true },
      }),
      this.prisma.workerHeartbeat.findFirst({
        where: { service: "watchdog" },
        orderBy: { lastSeenAt: "desc" },
        select: { lastSeenAt: true },
      }),
      this.prisma.marketInstrument.findMany({
        where: { enabled: true },
        orderBy: { symbol: "asc" },
        select: {
          symbol: true,
          snapshots: {
            orderBy: { observedAt: "desc" },
            take: 1,
            select: { observedAt: true },
          },
        },
      }),
      this.prisma.accountSnapshot.findFirst({
        where: { workspaceId },
        orderBy: { observedAt: "desc" },
        select: { observedAt: true },
      }),
      this.prisma.job.count({
        where: { workspaceId, status: "FAILED", completedAt: { gte: dayAgo } },
      }),
      this.prisma.job.findFirst({
        where: { workspaceId, status: "QUEUED" },
        orderBy: { queuedAt: "asc" },
        select: { queuedAt: true },
      }),
      this.prisma.order.count({
        where: { workspaceId, status: "REJECTED", updatedAt: { gte: dayAgo } },
      }),
      this.prisma.runtimeCursor.findMany({
        where: {
          workspaceId,
          consecutiveFailures: { gt: 0 },
          executionRun: { deployment: { status: { in: ["RUNNING", "PAUSED"] } } },
        },
        select: {
          executionRunId: true,
          symbol: true,
          lastFailureCode: true,
          lastFailureMessage: true,
          consecutiveFailures: true,
          updatedAt: true,
        },
      }),
      this.prisma.outboxEvent.count({
        where: { workspaceId, processedAt: null, availableAt: { lte: now } },
      }),
      this.prisma.outboxEvent.findFirst({
        where: { workspaceId, processedAt: null, availableAt: { lte: now } },
        orderBy: { availableAt: "asc" },
        select: { availableAt: true },
      }),
      this.prisma.decision.count({
        where: { workspaceId, reasonCode: "DAILY_LOSS_LIMIT", decidedAt: { gte: dayAgo } },
      }),
      this.prisma.exchangeConnection.findMany({
        where: { workspaceId, revokedAt: null },
        select: {
          id: true,
          label: true,
          status: true,
          lastVerificationCode: true,
          lastVerificationAttemptAt: true,
          nextVerificationAt: true,
          _count: {
            select: {
              deployments: { where: { status: { in: ["READY", "RUNNING", "PAUSED"] } } },
            },
          },
        },
      }),
      this.prisma.deployment.findMany({
        where: { workspaceId, status: { in: ["RUNNING", "PAUSED"] } },
        select: {
          id: true,
          environment: true,
          strategy: { select: { id: true, name: true } },
          strategyVersion: { select: { version: true } },
          executionRuns: {
            where: { status: "RUNNING" },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              context: true,
              trades: {
                orderBy: [{ closedAt: "asc" }, { id: "asc" }],
                select: { netPnl: true, closedAt: true },
              },
            },
          },
        },
      }),
    ]);

    const validationIds = activeDeployments.flatMap((deployment) => {
      const validationRunId = readValidationRunId(deployment.executionRuns[0]?.context);
      return validationRunId ? [validationRunId] : [];
    });
    const validations = await this.prisma.validationRun.findMany({
      where: { workspaceId, id: { in: validationIds }, status: "COMPLETED" },
      select: { id: true, metrics: true },
    });
    const validationById = new Map(validations.map((validation) => [validation.id, validation]));

    return {
      workerLastSeenAt: heartbeat?.lastSeenAt ?? null,
      watchdogLastSeenAt: watchdogHeartbeat?.lastSeenAt ?? null,
      markets: markets.map((market) => ({
        symbol: market.symbol,
        observedAt: market.snapshots[0]?.observedAt ?? null,
      })),
      accountObservedAt: account?.observedAt ?? null,
      failedJobs24h,
      oldestQueuedJobAt: oldestQueuedJob?.queuedAt ?? null,
      rejectedOrders24h,
      runtimeFailures: runtimeFailures.map((failure) => ({
        executionRunId: failure.executionRunId,
        symbol: failure.symbol,
        code: failure.lastFailureCode,
        message: failure.lastFailureMessage,
        consecutiveFailures: failure.consecutiveFailures,
        updatedAt: failure.updatedAt,
      })),
      pendingOutbox,
      oldestPendingOutboxAt: oldestPendingOutbox?.availableAt ?? null,
      riskStops24h,
      exchangeConnections: exchangeConnections.map((connection) => ({
        id: connection.id,
        label: connection.label,
        status: connection.status,
        lastVerificationCode: connection.lastVerificationCode,
        lastVerificationAttemptAt: connection.lastVerificationAttemptAt,
        nextVerificationAt: connection.nextVerificationAt,
        activeDeployments: connection._count.deployments,
      })),
      driftCandidates: activeDeployments.flatMap((deployment) => {
        const executionRun = deployment.executionRuns[0];
        if (!executionRun) return [];
        const validationRunId = readValidationRunId(executionRun.context);
        const validation = validationRunId ? validationById.get(validationRunId) : null;
        const baseline = readBaselineMetrics(validation?.metrics);
        if (!validationRunId || !baseline) return [];
        return [
          {
            deploymentId: deployment.id,
            executionRunId: executionRun.id,
            strategyId: deployment.strategy.id,
            strategyName: deployment.strategy.name,
            strategyVersion: deployment.strategyVersion.version,
            environment: deployment.environment,
            validationRunId,
            baseline,
            runtimeTrades: executionRun.trades.map((trade) => ({
              netPnl: trade.netPnl.toNumber(),
              closedAt: trade.closedAt,
            })),
          },
        ];
      }),
    };
  }

  public listIncidents(workspaceId: string) {
    return this.prisma.watchdogIncident.findMany({
      where: { workspaceId },
      orderBy: [{ status: "asc" }, { lastObservedAt: "desc" }],
      take: 100,
    });
  }

  public async syncIncidents(
    workspaceId: string,
    conditions: PersistedHealthCondition[],
    observedAt: Date,
  ) {
    const fingerprints = conditions.map((condition) => condition.fingerprint);
    await this.prisma.$transaction(async (transaction) => {
      for (const condition of conditions) {
        await transaction.watchdogIncident.updateMany({
          where: {
            workspaceId,
            fingerprint: condition.fingerprint,
            status: "RESOLVED",
          },
          data: {
            status: "OPEN",
            occurrenceCount: { increment: 1 },
            resolvedAt: null,
          },
        });
        await transaction.watchdogIncident.upsert({
          where: {
            workspaceId_fingerprint: { workspaceId, fingerprint: condition.fingerprint },
          },
          update: {
            domain: condition.domain,
            code: condition.code,
            severity: healthSeverity[condition.severity],
            status: "OPEN",
            title: condition.title,
            description: condition.description,
            resourceType: condition.resourceType,
            resourceId: condition.resourceId,
            metadata: condition.metadata as Prisma.InputJsonObject,
            lastObservedAt: observedAt,
            resolvedAt: null,
          },
          create: {
            workspaceId,
            fingerprint: condition.fingerprint,
            domain: condition.domain,
            code: condition.code,
            severity: healthSeverity[condition.severity],
            title: condition.title,
            description: condition.description,
            resourceType: condition.resourceType,
            resourceId: condition.resourceId,
            metadata: condition.metadata as Prisma.InputJsonObject,
            firstObservedAt: observedAt,
            lastObservedAt: observedAt,
          },
        });
      }

      await transaction.watchdogIncident.updateMany({
        where: {
          workspaceId,
          status: "OPEN",
          ...(fingerprints.length > 0 ? { fingerprint: { notIn: fingerprints } } : {}),
        },
        data: { status: "RESOLVED", resolvedAt: observedAt },
      });
    });
  }
}

function readValidationRunId(context: unknown): string | null {
  if (!context || typeof context !== "object" || !("validation" in context)) return null;
  const validation = context.validation;
  if (!validation || typeof validation !== "object" || !("runId" in validation)) return null;
  return typeof validation.runId === "string" ? validation.runId : null;
}

function readBaselineMetrics(metrics: unknown) {
  if (!metrics || typeof metrics !== "object") return null;
  const source = metrics as Record<string, unknown>;
  const trades = readNumber(source.trades);
  const winRatePercent = readNumber(source.winRatePercent);
  const expectancy = readNumber(source.expectancy);
  const maxDrawdownPercent = readNumber(source.maxDrawdownPercent);
  const profitFactor = source.profitFactor === null ? null : readNumber(source.profitFactor);
  if (
    trades === null ||
    winRatePercent === null ||
    expectancy === null ||
    maxDrawdownPercent === null ||
    (source.profitFactor !== null && profitFactor === null)
  ) {
    return null;
  }
  return { trades, winRatePercent, expectancy, profitFactor, maxDrawdownPercent };
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const healthSeverity = {
  warning: "WARNING",
  critical: "CRITICAL",
} as const;
