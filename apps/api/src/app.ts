import {
  calculateMarketAnalysis,
  buildPerformanceAnalytics,
  evaluateHealth,
  canTransitionStrategyStatus,
  createDevelopmentContext,
  executionEngineVersion,
  evaluateStrategyLifecycle,
  getDeploymentCommands,
  settleExecutionPosition,
  validationEngineVersion,
} from "@cryptoanal/application";
import type { ServerConfig } from "@cryptoanal/config";
import {
  apiEnvelopeSchema,
  analyticsQuerySchema,
  analyticsSchema,
  activityQuerySchema,
  activitySchema,
  deploymentCommandInputSchema,
  deploymentCreateSchema,
  deploymentIdParamsSchema,
  deploymentMutationResultSchema,
  deploymentsSchema,
  errorEnvelopeSchema,
  healthSchema,
  healthDashboardSchema,
  marketDetailSchema,
  marketSymbolParamsSchema,
  marketsSchema,
  overviewQuerySchema,
  overviewSchema,
  positionCloseInputSchema,
  positionCloseResultSchema,
  positionIdParamsSchema,
  requestContextSchema,
  strategyCatalogSchema,
  strategyConfigSchema,
  strategyCreateSchema,
  strategyCreatedSchema,
  strategyDetailSchema,
  strategyIdParamsSchema,
  strategyStatusChangedSchema,
  strategyStatusTransitionSchema,
  strategyVersionCreateSchema,
  strategyVersionCreatedSchema,
  tradeDetailSchema,
  tradeIdParamsSchema,
  tradingLedgerSchema,
  validationExecutionInputSchema,
  validationMetricsSchema,
  validationMetricsSummarySchema,
  validationRunDetailSchema,
  validationRunDetailQuerySchema,
  validationRunIdParamsSchema,
  validationRunInputSchema,
  validationRunQueuedSchema,
  validationsSchema,
  watchlistStateSchema,
} from "@cryptoanal/contracts";
import {
  ActiveDeploymentExistsError,
  ActivityCursorNotFoundError,
  ActivityRepository,
  AnalyticsRepository,
  type CryptoAnalPrismaClient,
  DashboardRepository,
  DeploymentCommandNotAllowedError,
  DeploymentHasOpenPositionsError,
  DeploymentIdempotencyConflictError,
  DeploymentNotEligibleError,
  DeploymentNotFoundError,
  DeploymentRepository,
  DeploymentStatusConflictError,
  DeploymentStrategyNotFoundError,
  DeploymentValidationRequiredError,
  DeploymentVersionMismatchError,
  HealthRepository,
  RuntimeIdempotencyConflictError,
  RuntimeManualCloseNotAllowedError,
  RuntimeMarketPriceUnavailableError,
  RuntimePositionNotFoundError,
  RuntimePositionStatusConflictError,
  RuntimeRepository,
  StrategyNameConflictError,
  StrategyConfigUnchangedError,
  StrategyNotFoundError,
  StrategyRepository,
  StrategyStatusConflictError,
  StrategyVersionNotAllowedError,
  ValidationAlreadyActiveError,
  ValidationNotEligibleError,
  ValidationRepository,
  ValidationStrategyNotFoundError,
  ValidationVersionMismatchError,
} from "@cryptoanal/persistence";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

const applicationVersion = "0.1.0";

type CreateAppDependencies = {
  config: ServerConfig;
  prisma: CryptoAnalPrismaClient;
};

class ApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function createApp({ config, prisma }: CreateAppDependencies) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  const repository = new DashboardRepository(prisma);
  const analyticsRepository = new AnalyticsRepository(prisma);
  const activityRepository = new ActivityRepository(prisma);
  const healthRepository = new HealthRepository(prisma);
  const deploymentRepository = new DeploymentRepository(prisma);
  const runtimeRepository = new RuntimeRepository(prisma);
  const strategyRepository = new StrategyRepository(prisma);
  const validationRepository = new ValidationRepository(prisma);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    origin: config.DASHBOARD_ORIGIN,
    credentials: true,
  });

  app.setErrorHandler((error, request, reply) => {
    const validationMessages = getValidationMessages(error);
    const statusCode =
      error instanceof ApiError ? error.statusCode : validationMessages ? 400 : 500;
    const code =
      error instanceof ApiError
        ? error.code
        : validationMessages
          ? "VALIDATION_ERROR"
          : "INTERNAL_ERROR";
    const message =
      error instanceof ApiError
        ? error.message
        : validationMessages
          ? "Параметры запроса не прошли проверку"
          : "Внутренняя ошибка сервера";

    if (!(error instanceof ApiError) && !validationMessages) {
      request.log.error({ err: error }, "Unhandled API error");
    }

    return reply.status(statusCode).send({
      error: {
        code,
        message,
        ...(validationMessages ? { fields: { request: validationMessages } } : {}),
        requestId: request.id,
      },
    });
  });

  async function requireWorkspace() {
    const workspace = await repository.getWorkspace(config.DEVELOPMENT_WORKSPACE_ID);
    if (!workspace) {
      throw new ApiError(
        503,
        "WORKSPACE_NOT_INITIALIZED",
        "Development workspace не создан. Выполните pnpm db:seed.",
      );
    }
    return workspace;
  }

  app.get(
    "/health",
    {
      schema: {
        response: {
          200: healthSchema,
          503: healthSchema,
        },
      },
    },
    async (_request, reply) => {
      const databaseConnected = await repository.ping();
      const payload = {
        status: databaseConnected ? ("ok" as const) : ("degraded" as const),
        service: "api" as const,
        version: applicationVersion,
        database: databaseConnected ? ("connected" as const) : ("unavailable" as const),
        timestamp: new Date().toISOString(),
      };

      return reply.status(databaseConnected ? 200 : 503).send(payload);
    },
  );

  app.get(
    "/api/v1/context",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(requestContextSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const context = createDevelopmentContext(
        {
          actorId: config.DEVELOPMENT_ACTOR_ID,
          workspaceId: workspace.id,
          role: "owner",
        },
        request.id,
      );

      return {
        data: {
          actorId: context.actorId,
          workspaceId: context.workspaceId,
          workspaceName: workspace.name,
          role: context.role,
          environment: config.NODE_ENV,
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.get(
    "/api/v1/overview",
    {
      schema: {
        querystring: overviewQuerySchema,
        response: {
          200: apiEnvelopeSchema(overviewSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const period = request.query.period;
      const periodConfig = overviewPeriodConfig[period];
      const overview = await repository.getOverview(workspace.id, {
        startsAt: new Date(Date.now() - periodConfig.durationMs),
        bucketSeconds: periodConfig.bucketSeconds,
      });
      const now = Date.now();
      const workerHealthy = overview.workerLastSeenAt
        ? now - overview.workerLastSeenAt.getTime() < 45_000
        : false;
      const accountFresh = overview.account
        ? now - overview.account.observedAt.getTime() < config.ACCOUNT_SNAPSHOT_INTERVAL_MS * 2
        : false;

      const alerts = [];
      if (!workerHealthy) {
        alerts.push({
          id: "worker-offline",
          severity: "critical" as const,
          title: "Worker не отвечает",
          description: "Нет свежего heartbeat. Торговые и фоновые задачи не выполняются.",
        });
      }
      if (!overview.account) {
        alerts.push({
          id: "account-data-unavailable",
          severity: "warning" as const,
          title: "Нет данных торгового счёта",
          description: "Worker ещё не записал account snapshot.",
        });
      } else if (!accountFresh) {
        alerts.push({
          id: "account-data-stale",
          severity: "warning" as const,
          title: "Данные торгового счёта устарели",
          description: "Последний account snapshot старше ожидаемого интервала обновления.",
        });
      }
      if (overview.runtimeHasFailures) {
        alerts.push({
          id: "runtime-cycle-failed",
          severity: "critical" as const,
          title: "Ошибка runtime-цикла",
          description: "Одна или несколько пар не обработаны. Проверьте Runtime control-plane.",
        });
      }

      const runtimeState = !workerHealthy
        ? ("offline" as const)
        : overview.runtimeHasFailures
          ? ("error" as const)
          : overview.runtimeDeploymentStatus === "RUNNING"
            ? ("running" as const)
            : overview.runtimeDeploymentStatus === "PAUSED"
              ? ("paused" as const)
              : ("idle" as const);

      return {
        data: {
          period,
          runtimeState,
          tradingEnvironment: overview.account
            ? tradingEnvironment[overview.account.environment]
            : ("dry-run" as const),
          account: overview.account
            ? {
                exchangeAccountId: overview.account.exchangeAccountId,
                environment: tradingEnvironment[overview.account.environment],
                equity: overview.account.equity,
                availableBalance: overview.account.availableBalance,
                observedAt: overview.account.observedAt.toISOString(),
              }
            : null,
          equitySeries: overview.equitySeries.map((point) => ({
            equity: point.equity,
            observedAt: point.observedAt.toISOString(),
          })),
          dayPnl: overview.dayPnl,
          totalPnl: overview.totalPnl,
          unrealizedPnl: overview.unrealizedPnl,
          openExposure: overview.openExposure,
          openPositions: overview.openPositions,
          activeStrategies: overview.activeStrategies,
          alerts,
        },
        meta: createMeta(
          request.id,
          !overview.account ? "unavailable" : accountFresh && workerHealthy ? "fresh" : "stale",
        ),
      };
    },
  );

  app.get(
    "/api/v1/activity",
    {
      schema: {
        querystring: activityQuerySchema,
        response: {
          200: apiEnvelopeSchema(activitySchema),
          400: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      try {
        const query = request.query;
        const activity = await activityRepository.list(workspace.id, {
          startsAt: getActivityStartsAt(query.period),
          action: query.action ? persistedDecisionAction[query.action] : null,
          strategyId: query.strategyId ?? null,
          symbol: query.symbol ?? null,
          reasonCode: query.reasonCode ?? null,
          cursor: query.cursor ?? null,
          limit: query.limit,
        });

        return {
          data: {
            filters: {
              period: query.period,
              action: query.action ?? null,
              strategyId: query.strategyId ?? null,
              symbol: query.symbol ?? null,
              reasonCode: query.reasonCode ?? null,
            },
            filterOptions: {
              strategies: activity.options.strategies,
              symbols: activity.options.symbols,
              reasonCodes: activity.options.reasonCodes,
              actions: activity.options.actions.map((action) => decisionAction[action]),
            },
            summary: {
              total: activity.total,
              open: activity.counts.get("OPEN") ?? 0,
              close: activity.counts.get("CLOSE") ?? 0,
              hold: activity.counts.get("HOLD") ?? 0,
              skip: activity.counts.get("SKIP") ?? 0,
              error: activity.counts.get("ERROR") ?? 0,
            },
            items: activity.items.map((item) => ({
              id: item.id,
              symbol: item.symbol,
              action: decisionAction[item.action],
              reasonCode: item.reasonCode,
              summary: item.summary,
              factors: readJsonObject(item.factors),
              marketSnapshotRef: item.marketSnapshotRef,
              correlationId: item.correlationId,
              decidedAt: item.decidedAt.toISOString(),
              strategy: {
                id: item.strategyVersion.strategy.id,
                name: item.strategyVersion.strategy.name,
                versionId: item.strategyVersion.id,
                version: item.strategyVersion.version,
              },
              execution: {
                runId: item.executionRun.id,
                deploymentId: item.executionRun.deploymentId,
                environment: tradingEnvironment[item.executionRun.environment],
                status: runStatus[item.executionRun.status],
              },
              links: { positionId: item.positionId, tradeId: item.tradeId },
            })),
            nextCursor: activity.nextCursor,
          },
          meta: createMeta(request.id, activity.total > 0 ? "fresh" : "unavailable"),
        };
      } catch (error) {
        if (error instanceof ActivityCursorNotFoundError) {
          throw new ApiError(400, "ACTIVITY_CURSOR_INVALID", "Cursor ленты недействителен");
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/health",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(healthDashboardSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const now = new Date();
      const [signals, persistedIncidents] = await Promise.all([
        healthRepository.getSignals(workspace.id, now),
        healthRepository.listIncidents(workspace.id),
      ]);
      const health = evaluateHealth({
        ...signals,
        now,
        initialCapital: config.DRY_RUN_INITIAL_BALANCE,
        thresholds: createHealthThresholds(config),
        driftCandidates: signals.driftCandidates.map((candidate) => ({
          ...candidate,
          environment: tradingEnvironment[candidate.environment],
        })),
      });
      const persistedByFingerprint = new Map(
        persistedIncidents.map((incident) => [incident.fingerprint, incident]),
      );
      const activeIncidents = health.conditions.map((condition) => {
        const persisted = persistedByFingerprint.get(condition.fingerprint);
        return persisted
          ? serializeWatchdogIncident({ ...persisted, status: "OPEN", resolvedAt: null })
          : {
              id: `current:${condition.fingerprint}`,
              fingerprint: condition.fingerprint,
              domain: condition.domain,
              code: condition.code,
              severity: condition.severity,
              status: "open" as const,
              title: condition.title,
              description: condition.description,
              resourceType: condition.resourceType,
              resourceId: condition.resourceId,
              occurrenceCount: 1,
              firstObservedAt: now.toISOString(),
              lastObservedAt: now.toISOString(),
              resolvedAt: null,
            };
      });
      const resolvedIncidents = persistedIncidents
        .filter((incident) => incident.status === "RESOLVED")
        .map(serializeWatchdogIncident);

      return {
        data: {
          overallStatus: health.overallStatus,
          checkedAt: now.toISOString(),
          watchdogLastSeenAt: signals.watchdogLastSeenAt?.toISOString() ?? null,
          domains: health.domains.map((domain) => ({
            ...domain,
            observedAt: domain.observedAt?.toISOString() ?? null,
          })),
          incidents: [...activeIncidents, ...resolvedIncidents].slice(0, 100),
          drift: health.drift,
          notices: health.notices,
        },
        meta: createMeta(
          request.id,
          health.overallStatus === "healthy"
            ? "fresh"
            : health.overallStatus === "degraded"
              ? "stale"
              : "unavailable",
        ),
      };
    },
  );

  app.get(
    "/api/v1/analytics",
    {
      schema: {
        querystring: analyticsQuerySchema,
        response: {
          200: apiEnvelopeSchema(analyticsSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const filters = request.query;
      const dataset = await analyticsRepository.getPerformanceDataset(workspace.id, {
        startsAt: getAnalyticsStartsAt(filters.period),
        environment: filters.environment ? analyticsTradingEnvironment[filters.environment] : null,
        strategyId: filters.strategyId ?? null,
        symbol: filters.symbol ?? null,
      });
      const analytics = buildPerformanceAnalytics(
        dataset.trades.map((trade) => ({
          ...trade,
          environment: tradingEnvironment[trade.environment],
        })),
        config.DRY_RUN_INITIAL_BALANCE,
      );

      return {
        data: {
          filters: {
            period: filters.period,
            environment: filters.environment ?? null,
            strategyId: filters.strategyId ?? null,
            symbol: filters.symbol ?? null,
          },
          filterOptions: {
            strategies: dataset.options.strategies,
            symbols: dataset.options.symbols,
            environments: dataset.options.environments.map(
              (environment) => tradingEnvironment[environment],
            ),
          },
          initialCapital: String(config.DRY_RUN_INITIAL_BALANCE),
          summary: {
            ...analytics.summary,
            grossPnl: String(analytics.summary.grossPnl),
            netPnl: String(analytics.summary.netPnl),
            totalFees: String(analytics.summary.totalFees),
            totalFunding: String(analytics.summary.totalFunding),
            totalSlippage: String(analytics.summary.totalSlippage),
            expectancy: String(analytics.summary.expectancy),
            averageWin: String(analytics.summary.averageWin),
            averageLoss: String(analytics.summary.averageLoss),
            bestTrade: String(analytics.summary.bestTrade),
            worstTrade: String(analytics.summary.worstTrade),
          },
          equitySeries: analytics.equitySeries.map((point) => ({
            ...point,
            observedAt: point.observedAt.toISOString(),
            equity: String(point.equity),
            cumulativeNetPnl: String(point.cumulativeNetPnl),
          })),
          dailyPnl: analytics.dailyPnl.map((day) => ({
            ...day,
            netPnl: String(day.netPnl),
          })),
          breakdowns: {
            strategies: serializeAnalyticsBreakdown(analytics.breakdowns.strategies),
            symbols: serializeAnalyticsBreakdown(analytics.breakdowns.symbols),
            exitReasons: serializeAnalyticsBreakdown(analytics.breakdowns.exitReasons),
            regimes: serializeAnalyticsBreakdown(analytics.breakdowns.regimes),
            sessions: serializeAnalyticsBreakdown(analytics.breakdowns.sessions),
          },
          distributions: {
            pnl: analytics.distributions.pnl.map((bucket) => ({
              ...bucket,
              from: String(bucket.from),
              to: String(bucket.to),
              netPnl: String(bucket.netPnl),
            })),
            holdingTime: analytics.distributions.holdingTime.map((bucket) => ({
              ...bucket,
              netPnl: String(bucket.netPnl),
            })),
          },
        },
        meta: createMeta(request.id, analytics.summary.trades > 0 ? "fresh" : "unavailable"),
      };
    },
  );

  app.get(
    "/api/v1/markets",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(marketsSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const instruments = await repository.listMarkets(workspace.id);
      const now = Date.now();
      const items = instruments.map((instrument) => {
        const snapshot = instrument.snapshots[0];
        const analysis = calculateMarketAnalysis(
          [...instrument.candles].reverse().map((candle) => ({
            open: candle.open.toNumber(),
            high: candle.high.toNumber(),
            low: candle.low.toNumber(),
            close: candle.close.toNumber(),
          })),
        );
        const freshness = !snapshot
          ? ("unavailable" as const)
          : now - snapshot.observedAt.getTime() < 60_000
            ? ("fresh" as const)
            : ("stale" as const);

        return {
          symbol: instrument.symbol,
          baseAsset: instrument.baseAsset,
          quoteAsset: instrument.quoteAsset,
          exchange: instrument.exchange,
          instrumentType: instrument.instrumentType,
          watchlisted: instrument.watchlistItems.length > 0,
          price: snapshot?.price.toFixed() ?? null,
          change24hPercent: snapshot?.change24hPercent?.toFixed() ?? null,
          volume24h: snapshot?.volume24h?.toFixed() ?? null,
          regime: analysis.regime,
          freshness,
        };
      });

      return {
        data: { items, total: items.length },
        meta: createMeta(
          request.id,
          items.some((item) => item.freshness === "fresh") ? "fresh" : "unavailable",
        ),
      };
    },
  );

  app.get(
    "/api/v1/strategies",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(strategyCatalogSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const strategies = await repository.listStrategies(workspace.id);
      const counts = Object.fromEntries(strategyStatuses.map((status) => [status, 0])) as Record<
        (typeof strategyStatuses)[number],
        number
      >;

      const items = strategies.map((strategy) => {
        const status = strategyStatus[strategy.status];
        counts[status] += 1;
        const latestVersion = strategy.versions[0] ?? null;
        const lastValidation = strategy.validationRuns[0] ?? null;
        const deployment = strategy.deployments[0] ?? null;

        return {
          id: strategy.id,
          name: strategy.name,
          description: strategy.description,
          status,
          versionsCount: strategy._count.versions,
          activeVersion: serializeStrategyVersion(strategy.activeVersion),
          latestVersion: serializeStrategyVersion(latestVersion),
          lastValidation: lastValidation
            ? {
                id: lastValidation.id,
                kind: validationKind[lastValidation.kind],
                status: runStatus[lastValidation.status],
                verdict: validationVerdict[lastValidation.verdict],
                strategyVersion: lastValidation.strategyVersion.version,
                completedAt: lastValidation.completedAt?.toISOString() ?? null,
              }
            : null,
          deployment: deployment
            ? {
                id: deployment.id,
                environment: tradingEnvironment[deployment.environment],
                status: deploymentStatus[deployment.status],
                strategyVersion: deployment.strategyVersion.version,
                updatedAt: deployment.updatedAt.toISOString(),
              }
            : null,
          updatedAt: strategy.updatedAt.toISOString(),
        };
      });

      return {
        data: { items, total: items.length, counts },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/strategies",
    {
      schema: {
        body: strategyCreateSchema,
        response: {
          201: apiEnvelopeSchema(strategyCreatedSchema),
          400: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const workspace = await requireWorkspace();
      const configHash = createHash("sha256")
        .update(JSON.stringify(request.body.config))
        .digest("hex");

      try {
        const result = await strategyRepository.createWithInitialVersion({
          workspaceId: workspace.id,
          actorId: config.DEVELOPMENT_ACTOR_ID,
          name: request.body.name,
          description: request.body.description,
          configSchemaVersion: request.body.config.schemaVersion,
          config: request.body.config,
          configHash,
        });

        return reply.status(201).send({
          data: {
            id: result.strategy.id,
            name: result.strategy.name,
            status: "draft",
            version: {
              ...result.version,
              createdAt: result.version.createdAt.toISOString(),
            },
          },
          meta: createMeta(request.id, "fresh"),
        });
      } catch (error) {
        if (error instanceof StrategyNameConflictError) {
          throw new ApiError(
            409,
            "STRATEGY_NAME_CONFLICT",
            "Стратегия с таким названием уже существует",
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/strategies/:strategyId",
    {
      schema: {
        params: strategyIdParamsSchema,
        response: {
          200: apiEnvelopeSchema(strategyDetailSchema),
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const strategy = await strategyRepository.getDetail(workspace.id, request.params.strategyId);
      if (!strategy) {
        throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
      }

      const latestVersion = strategy.versions[0] ?? null;
      const lastValidation = strategy.validationRuns[0] ?? null;
      const deployment = strategy.deployments[0] ?? null;

      return {
        data: {
          id: strategy.id,
          name: strategy.name,
          description: strategy.description,
          status: strategyStatus[strategy.status],
          versionsCount: strategy._count.versions,
          activeVersion: serializeStrategyVersion(strategy.activeVersion),
          latestVersion: serializeStrategyVersion(latestVersion),
          lastValidation: lastValidation
            ? {
                id: lastValidation.id,
                kind: validationKind[lastValidation.kind],
                status: runStatus[lastValidation.status],
                verdict: validationVerdict[lastValidation.verdict],
                strategyVersion: lastValidation.strategyVersion.version,
                completedAt: lastValidation.completedAt?.toISOString() ?? null,
              }
            : null,
          deployment: deployment
            ? {
                id: deployment.id,
                environment: tradingEnvironment[deployment.environment],
                status: deploymentStatus[deployment.status],
                strategyVersion: deployment.strategyVersion.version,
                updatedAt: deployment.updatedAt.toISOString(),
              }
            : null,
          updatedAt: strategy.updatedAt.toISOString(),
          lifecycle: createStrategyLifecycleProjection(strategy),
          versions: strategy.versions.map((version) => ({
            id: version.id,
            version: version.version,
            configSchemaVersion: version.configSchemaVersion,
            config: strategyConfigSchema.parse(version.config),
            configHash: version.configHash,
            changeSummary: version.changeSummary,
            createdByActorId: version.createdByActorId,
            createdAt: version.createdAt.toISOString(),
          })),
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/strategies/:strategyId/versions",
    {
      schema: {
        params: strategyIdParamsSchema,
        body: strategyVersionCreateSchema,
        response: {
          201: apiEnvelopeSchema(strategyVersionCreatedSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const workspace = await requireWorkspace();
      const configHash = createHash("sha256")
        .update(JSON.stringify(request.body.config))
        .digest("hex");

      try {
        const version = await strategyRepository.createVersion({
          workspaceId: workspace.id,
          strategyId: request.params.strategyId,
          actorId: config.DEVELOPMENT_ACTOR_ID,
          configSchemaVersion: request.body.config.schemaVersion,
          config: request.body.config,
          configHash,
          changeSummary: request.body.changeSummary,
        });

        return reply.status(201).send({
          data: {
            strategyId: request.params.strategyId,
            version: {
              ...version,
              createdAt: version.createdAt.toISOString(),
            },
          },
          meta: createMeta(request.id, "fresh"),
        });
      } catch (error) {
        if (error instanceof StrategyNotFoundError) {
          throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
        }
        if (error instanceof StrategyConfigUnchangedError) {
          throw new ApiError(
            409,
            "STRATEGY_CONFIG_UNCHANGED",
            "Конфигурация не отличается от последней версии",
          );
        }
        if (error instanceof StrategyVersionNotAllowedError) {
          throw new ApiError(
            409,
            "STRATEGY_VERSION_NOT_ALLOWED",
            "Новая версия доступна только для черновика или одобренной стратегии",
          );
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/strategies/:strategyId/status",
    {
      schema: {
        params: strategyIdParamsSchema,
        body: strategyStatusTransitionSchema,
        response: {
          200: apiEnvelopeSchema(strategyStatusChangedSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const strategy = await strategyRepository.getDetail(workspace.id, request.params.strategyId);
      if (!strategy) {
        throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
      }

      const currentStatus = strategyStatus[strategy.status];
      if (currentStatus !== request.body.expectedStatus) {
        throw new ApiError(
          409,
          "STRATEGY_STATUS_CONFLICT",
          "Статус стратегии уже изменился. Обновите страницу",
        );
      }
      if (!canTransitionStrategyStatus(currentStatus, request.body.target)) {
        throw new ApiError(409, "STRATEGY_TRANSITION_INVALID", "Недопустимый переход статуса");
      }

      const lifecycle = createStrategyLifecycleProjection(strategy);
      const transition = lifecycle.transitions.find(
        (candidate) => candidate.target === request.body.target,
      );
      if (!transition?.allowed) {
        throw new ApiError(
          409,
          "STRATEGY_TRANSITION_BLOCKED",
          transition?.reason ?? "Переход должен выполняться отдельной доменной командой",
        );
      }

      try {
        const changed = await strategyRepository.transitionStatus({
          workspaceId: workspace.id,
          strategyId: strategy.id,
          actorId: config.DEVELOPMENT_ACTOR_ID,
          requestId: request.id,
          expectedStatus: persistedStrategyStatus[request.body.expectedStatus],
          targetStatus: persistedManualStrategyStatus[request.body.target],
          reason: request.body.reason,
        });

        return {
          data: { strategyId: changed.id, status: strategyStatus[changed.status] },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        if (error instanceof StrategyNotFoundError) {
          throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
        }
        if (error instanceof StrategyStatusConflictError) {
          throw new ApiError(
            409,
            "STRATEGY_STATUS_CONFLICT",
            "Статус стратегии уже изменился. Обновите страницу",
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/validations",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(validationsSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const runs = await validationRepository.list(workspace.id);
      const counts = {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      };
      const items = runs.map((run) => {
        counts[runStatus[run.status]] += 1;
        return serializeValidationRun(run);
      });

      return {
        data: { items, total: items.length, counts },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.get(
    "/api/v1/validations/:validationRunId",
    {
      schema: {
        params: validationRunIdParamsSchema,
        querystring: validationRunDetailQuerySchema,
        response: {
          200: apiEnvelopeSchema(validationRunDetailSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const run = await validationRepository.get(
        workspace.id,
        request.params.validationRunId,
        request.query.tradePage,
        request.query.tradeLimit,
      );
      if (!run) {
        throw new ApiError(404, "VALIDATION_RUN_NOT_FOUND", "Запуск проверки не найден");
      }

      return {
        data: {
          run: serializeValidationRunDetail(run),
          trades: run.trades.map((trade) => ({
            symbol: trade.symbol,
            side: trade.side === "BUY" ? ("long" as const) : ("short" as const),
            openedAt: trade.openedAt.toISOString(),
            closedAt: trade.closedAt.toISOString(),
            entryPrice: Number(trade.entryPrice),
            exitPrice: Number(trade.exitPrice),
            quantity: Number(trade.quantity),
            netPnl: Number(trade.netPnl),
            fees: Number(trade.fees),
            exitReason: serializeValidationExitReason(trade.exitReason),
          })),
          tradesTotal: run._count.trades,
          tradePage: request.query.tradePage,
          tradeLimit: request.query.tradeLimit,
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/strategies/:strategyId/validations",
    {
      schema: {
        params: strategyIdParamsSchema,
        body: validationRunInputSchema,
        response: {
          202: apiEnvelopeSchema(validationRunQueuedSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const workspace = await requireWorkspace();
      const strategy = await strategyRepository.getDetail(workspace.id, request.params.strategyId);
      if (!strategy) {
        throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
      }
      const version = strategy.versions[0];
      if (!version || version.id !== request.body.strategyVersionId) {
        throw new ApiError(
          409,
          "VALIDATION_VERSION_MISMATCH",
          "Для проверки нужно выбрать последнюю версию стратегии",
        );
      }
      const versionConfig = strategyConfigSchema.parse(version.config);
      const requestedSymbolsAreCompatible = request.body.dataset.symbols.every((symbol) =>
        versionConfig.universe.symbols.includes(symbol),
      );
      if (
        request.body.dataset.timeframe !== versionConfig.universe.timeframe ||
        !requestedSymbolsAreCompatible
      ) {
        throw new ApiError(
          409,
          "VALIDATION_DATASET_INCOMPATIBLE",
          "Датасет должен использовать timeframe и пары из конфигурации стратегии",
        );
      }

      const { strategyVersionId, idempotencyKey, ...executionInput } = request.body;
      const datasetHash = createHash("sha256")
        .update(JSON.stringify(executionInput.dataset))
        .digest("hex");

      try {
        const queued = await validationRepository.queue({
          workspaceId: workspace.id,
          strategyId: strategy.id,
          strategyVersionId,
          actorId: config.DEVELOPMENT_ACTOR_ID,
          requestId: request.id,
          kind: persistedValidationKind[executionInput.kind],
          datasetId: `market-candles-request:${datasetHash}`,
          datasetAsOf: new Date(),
          engineVersion: validationEngineVersion,
          configHash: version.configHash,
          input: executionInput,
          idempotencyKey,
        });

        return reply.status(202).send({
          data: {
            run: serializeValidationRun(queued.run),
            job: {
              id: queued.job.id,
              status: runStatus[queued.job.status],
              replayed: queued.replayed,
            },
          },
          meta: createMeta(request.id, "fresh"),
        });
      } catch (error) {
        if (error instanceof ValidationStrategyNotFoundError) {
          throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
        }
        if (error instanceof ValidationVersionMismatchError) {
          throw new ApiError(
            409,
            "VALIDATION_VERSION_MISMATCH",
            "Для проверки нужно выбрать последнюю версию стратегии",
          );
        }
        if (error instanceof ValidationNotEligibleError) {
          throw new ApiError(
            409,
            "VALIDATION_NOT_ELIGIBLE",
            "Текущий статус стратегии не разрешает новую проверку",
          );
        }
        if (error instanceof ValidationAlreadyActiveError) {
          throw new ApiError(
            409,
            "VALIDATION_ALREADY_ACTIVE",
            "У стратегии уже есть активная проверка",
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/deployments",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(deploymentsSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const deployments = await deploymentRepository.list(workspace.id);
      const counts = Object.fromEntries(deploymentStatuses.map((status) => [status, 0])) as Record<
        (typeof deploymentStatuses)[number],
        number
      >;
      const items = deployments.map((deployment) => {
        const status = deploymentStatus[deployment.status];
        counts[status] += 1;
        return serializeDeployment(deployment);
      });

      return {
        data: { items, total: items.length, counts },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/strategies/:strategyId/deployments",
    {
      schema: {
        params: strategyIdParamsSchema,
        body: deploymentCreateSchema,
        response: {
          201: apiEnvelopeSchema(deploymentMutationResultSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const workspace = await requireWorkspace();
      try {
        const result = await deploymentRepository.create({
          workspaceId: workspace.id,
          strategyId: request.params.strategyId,
          strategyVersionId: request.body.strategyVersionId,
          actorId: config.DEVELOPMENT_ACTOR_ID,
          requestId: request.id,
          idempotencyKey: request.body.idempotencyKey,
          exchangeAccountId: config.DRY_RUN_ACCOUNT_ID,
        });

        return reply.status(201).send({
          data: {
            deployment: serializeDeployment(result.deployment),
            replayed: result.replayed,
          },
          meta: createMeta(request.id, "fresh"),
        });
      } catch (error) {
        throwDeploymentApiError(error);
      }
    },
  );

  app.post(
    "/api/v1/deployments/:deploymentId/commands",
    {
      schema: {
        params: deploymentIdParamsSchema,
        body: deploymentCommandInputSchema,
        response: {
          200: apiEnvelopeSchema(deploymentMutationResultSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      try {
        const result = await deploymentRepository.applyCommand({
          workspaceId: workspace.id,
          deploymentId: request.params.deploymentId,
          actorId: config.DEVELOPMENT_ACTOR_ID,
          requestId: request.id,
          idempotencyKey: request.body.idempotencyKey,
          command: persistedDeploymentCommand[request.body.command],
          expectedStatus: persistedDeploymentStatus[request.body.expectedStatus],
          reason: request.body.reason,
          engineVersion: executionEngineVersion,
        });

        return {
          data: {
            deployment: serializeDeployment(result.deployment),
            replayed: result.replayed,
          },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        throwDeploymentApiError(error);
      }
    },
  );

  app.get(
    "/api/v1/markets/:symbol",
    {
      schema: {
        params: marketSymbolParamsSchema,
        response: {
          200: apiEnvelopeSchema(marketDetailSchema),
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const instrument = await repository.getMarket(workspace.id, request.params.symbol);
      if (!instrument) {
        throw new ApiError(404, "MARKET_NOT_FOUND", "Торговая пара не найдена");
      }

      const snapshot = instrument.snapshots[0];
      const candles = [...instrument.candles].reverse();
      const analysis = calculateMarketAnalysis(
        candles.map((candle) => ({
          open: candle.open.toNumber(),
          high: candle.high.toNumber(),
          low: candle.low.toNumber(),
          close: candle.close.toNumber(),
        })),
      );
      const now = Date.now();
      const marketFreshness = !snapshot
        ? ("unavailable" as const)
        : now - snapshot.observedAt.getTime() < 60_000
          ? ("fresh" as const)
          : ("stale" as const);
      const latestCandle = candles.at(-1);
      const candleFreshness = !latestCandle
        ? ("unavailable" as const)
        : now - latestCandle.openTime.getTime() < 30 * 60_000
          ? ("fresh" as const)
          : ("stale" as const);

      return {
        data: {
          market: {
            symbol: instrument.symbol,
            baseAsset: instrument.baseAsset,
            quoteAsset: instrument.quoteAsset,
            exchange: instrument.exchange,
            instrumentType: instrument.instrumentType,
            watchlisted: instrument.watchlistItems.length > 0,
            price: snapshot?.price.toFixed() ?? null,
            change24hPercent: snapshot?.change24hPercent?.toFixed() ?? null,
            volume24h: snapshot?.volume24h?.toFixed() ?? null,
            regime: analysis.regime,
            freshness: marketFreshness,
          },
          interval: "15" as const,
          candles: candles.map((candle) => ({
            openTime: candle.openTime.toISOString(),
            open: candle.open.toFixed(),
            high: candle.high.toFixed(),
            low: candle.low.toFixed(),
            close: candle.close.toFixed(),
            volume: candle.volume.toFixed(),
            turnover: candle.turnover.toFixed(),
          })),
          analysis: {
            regime: analysis.regime,
            ema20: serializeMetric(analysis.ema20),
            ema50: serializeMetric(analysis.ema50),
            rsi14: serializeMetric(analysis.rsi14),
            atr14: serializeMetric(analysis.atr14),
            periodChangePercent: serializeMetric(analysis.periodChangePercent),
          },
        },
        meta: createMeta(
          request.id,
          marketFreshness === "fresh" && candleFreshness === "fresh" ? "fresh" : candleFreshness,
        ),
      };
    },
  );

  app.put(
    "/api/v1/watchlist/:symbol",
    {
      schema: {
        params: marketSymbolParamsSchema,
        response: {
          200: apiEnvelopeSchema(watchlistStateSchema),
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      if (!(await repository.hasEnabledMarket(request.params.symbol))) {
        throw new ApiError(404, "MARKET_NOT_FOUND", "Торговая пара не найдена");
      }
      await repository.setWatchlisted(workspace.id, request.params.symbol, true);
      return {
        data: { symbol: request.params.symbol, watchlisted: true },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.delete(
    "/api/v1/watchlist/:symbol",
    {
      schema: {
        params: marketSymbolParamsSchema,
        response: {
          200: apiEnvelopeSchema(watchlistStateSchema),
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      if (!(await repository.hasEnabledMarket(request.params.symbol))) {
        throw new ApiError(404, "MARKET_NOT_FOUND", "Торговая пара не найдена");
      }
      await repository.setWatchlisted(workspace.id, request.params.symbol, false);
      return {
        data: { symbol: request.params.symbol, watchlisted: false },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/positions/:positionId/close",
    {
      schema: {
        params: positionIdParamsSchema,
        body: positionCloseInputSchema,
        response: {
          200: apiEnvelopeSchema(positionCloseResultSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      try {
        const replayed = await runtimeRepository.replayManualClose(
          workspace.id,
          request.params.positionId,
          request.body.idempotencyKey,
        );
        if (replayed) return { data: replayed, meta: createMeta(request.id, "fresh") };

        const position = await runtimeRepository.getManualCloseContext(
          workspace.id,
          request.params.positionId,
        );
        if (!position) throw new ApiError(404, "POSITION_NOT_FOUND", "Позиция не найдена");
        if (position.status !== "OPEN") {
          const concurrentReplay = await runtimeRepository.replayManualClose(
            workspace.id,
            request.params.positionId,
            request.body.idempotencyKey,
          );
          if (concurrentReplay) {
            return { data: concurrentReplay, meta: createMeta(request.id, "fresh") };
          }
          throw new ApiError(409, "POSITION_STATUS_CONFLICT", "Позиция уже закрыта");
        }
        const quote = position.instrument.snapshots[0];
        if (!quote) {
          throw new ApiError(
            503,
            "MARKET_PRICE_UNAVAILABLE",
            "Нет актуальной цены для закрытия позиции",
          );
        }
        const strategyConfig = strategyConfigSchema.parse(position.strategyVersion.config);
        const settlement = settleExecutionPosition(
          {
            symbol: position.symbol,
            side: position.side === "BUY" ? "long" : "short",
            entryRegime: marketRegime[position.entryRegime],
            entrySession: tradingSession[position.entrySession],
            openedAt: position.openedAt,
            entryPrice: position.entryPrice.toNumber(),
            quantity: position.quantity.toNumber(),
            stopPrice: position.stopPrice.toNumber(),
            takePrice: position.takePrice.toNumber(),
            trailingPrice: position.trailingPrice?.toNumber() ?? null,
            bestPrice: position.bestPrice.toNumber(),
            entryFee: position.entryFee.toNumber(),
            entrySlippage: position.entrySlippage.toNumber(),
          },
          quote.price.toNumber(),
          new Date(),
          "manual",
          strategyConfig,
        );

        const result = await runtimeRepository.closeManually({
          workspaceId: workspace.id,
          positionId: position.id,
          executionRunId: position.executionRunId,
          actorId: config.DEVELOPMENT_ACTOR_ID,
          requestId: request.id,
          idempotencyKey: request.body.idempotencyKey,
          reason: request.body.reason,
          quoteObservedAt: quote.observedAt,
          maximumQuoteAgeMs: config.MARKET_POLL_INTERVAL_MS * 2,
          settlement: {
            exitPrice: String(settlement.exitPrice),
            grossPnl: String(settlement.grossPnl),
            netPnl: String(settlement.netPnl),
            fees: String(settlement.fees),
            slippage: String(settlement.slippage),
            exitReason: settlement.exitReason,
            closedAt: new Date(settlement.closedAt),
          },
        });
        return { data: result, meta: createMeta(request.id, "fresh") };
      } catch (error) {
        throwManualCloseApiError(error);
      }
    },
  );

  app.get(
    "/api/v1/trades",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(tradingLedgerSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const ledger = await repository.getTradingLedger(workspace.id);
      return {
        data: {
          summary: ledger.summary,
          positions: ledger.positions.map((position) => ({
            id: position.id,
            symbol: position.symbol,
            environment: tradingEnvironment[position.environment],
            side: orderSide[position.side],
            quantity: position.quantity.toFixed(),
            entryPrice: position.entryPrice.toFixed(),
            markPrice: position.markPrice?.toFixed() ?? null,
            unrealizedPnl: position.unrealizedPnl.toFixed(),
            openedAt: position.openedAt.toISOString(),
            strategy: {
              id: position.strategyVersion.strategy.id,
              name: position.strategyVersion.strategy.name,
              version: position.strategyVersion.version,
            },
          })),
          trades: ledger.trades.map((trade) => ({
            id: trade.id,
            symbol: trade.symbol,
            environment: tradingEnvironment[trade.environment],
            side: orderSide[trade.side],
            entryRegime: marketRegime[trade.entryRegime],
            entrySession: tradingSession[trade.entrySession],
            quantity: trade.quantity.toFixed(),
            averageEntryPrice: trade.averageEntryPrice.toFixed(),
            averageExitPrice: trade.averageExitPrice.toFixed(),
            grossPnl: trade.grossPnl.toFixed(),
            fees: trade.fees.toFixed(),
            funding: trade.funding.toFixed(),
            slippage: trade.slippage.toFixed(),
            netPnl: trade.netPnl.toFixed(),
            exitReason: trade.exitReason,
            openedAt: trade.openedAt.toISOString(),
            closedAt: trade.closedAt.toISOString(),
            strategy: {
              id: trade.strategyVersion.strategy.id,
              name: trade.strategyVersion.strategy.name,
              version: trade.strategyVersion.version,
            },
          })),
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.get(
    "/api/v1/trades/:tradeId",
    {
      schema: {
        params: tradeIdParamsSchema,
        response: {
          200: apiEnvelopeSchema(tradeDetailSchema),
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const detail = await repository.getTradeDetail(workspace.id, request.params.tradeId);
      if (!detail) {
        throw new ApiError(404, "TRADE_NOT_FOUND", "Сделка не найдена");
      }

      return {
        data: {
          trade: {
            id: detail.id,
            symbol: detail.symbol,
            environment: tradingEnvironment[detail.environment],
            side: orderSide[detail.side],
            entryRegime: marketRegime[detail.entryRegime],
            entrySession: tradingSession[detail.entrySession],
            quantity: detail.quantity.toFixed(),
            averageEntryPrice: detail.averageEntryPrice.toFixed(),
            averageExitPrice: detail.averageExitPrice.toFixed(),
            grossPnl: detail.grossPnl.toFixed(),
            fees: detail.fees.toFixed(),
            funding: detail.funding.toFixed(),
            slippage: detail.slippage.toFixed(),
            netPnl: detail.netPnl.toFixed(),
            exitReason: detail.exitReason,
            openedAt: detail.openedAt.toISOString(),
            closedAt: detail.closedAt.toISOString(),
            strategy: {
              id: detail.strategyVersion.strategy.id,
              name: detail.strategyVersion.strategy.name,
              version: detail.strategyVersion.version,
            },
          },
          execution: {
            runId: detail.executionRun.id,
            status: runStatus[detail.executionRun.status],
            engineVersion: detail.executionRun.engineVersion,
            configHash: detail.executionRun.configHash,
          },
          orders: detail.position.orders.map((order) => ({
            id: order.id,
            clientOrderId: order.clientOrderId,
            exchangeOrderId: order.exchangeOrderId,
            side: orderSide[order.side],
            type: orderType[order.type],
            status: orderStatus[order.status],
            quantity: order.quantity.toFixed(),
            price: order.price?.toFixed() ?? null,
            createdAt: order.createdAt.toISOString(),
            updatedAt: order.updatedAt.toISOString(),
            fills: order.fills.map((fill) => ({
              id: fill.id,
              exchangeFillId: fill.exchangeFillId,
              quantity: fill.quantity.toFixed(),
              price: fill.price.toFixed(),
              fee: fill.fee.toFixed(),
              feeAsset: fill.feeAsset,
              filledAt: fill.filledAt.toISOString(),
            })),
          })),
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Маршрут не найден",
        requestId: request.id,
      },
    }),
  );

  return app;
}

const overviewPeriodConfig = {
  "24h": { durationMs: 24 * 60 * 60 * 1_000, bucketSeconds: 15 * 60 },
  "7d": { durationMs: 7 * 24 * 60 * 60 * 1_000, bucketSeconds: 2 * 60 * 60 },
  "30d": { durationMs: 30 * 24 * 60 * 60 * 1_000, bucketSeconds: 8 * 60 * 60 },
} as const;

const analyticsPeriodDurationMs = {
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
  "90d": 90 * 24 * 60 * 60 * 1_000,
  all: null,
} as const;

const activityPeriodDurationMs = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
  all: null,
} as const;

function getActivityStartsAt(period: keyof typeof activityPeriodDurationMs): Date | null {
  const durationMs = activityPeriodDurationMs[period];
  return durationMs === null ? null : new Date(Date.now() - durationMs);
}

function getAnalyticsStartsAt(period: keyof typeof analyticsPeriodDurationMs): Date | null {
  const durationMs = analyticsPeriodDurationMs[period];
  return durationMs === null ? null : new Date(Date.now() - durationMs);
}

function createHealthThresholds(config: ServerConfig) {
  return {
    workerStaleMs: 45_000,
    marketStaleMs: config.MARKET_POLL_INTERVAL_MS * 3,
    accountStaleMs: config.ACCOUNT_SNAPSHOT_INTERVAL_MS * 2,
    queueLagMs: 5 * 60_000,
    outboxLagMs: 5 * 60_000,
  };
}

function serializeWatchdogIncident(incident: {
  id: string;
  fingerprint: string;
  domain: string;
  code: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  status: "OPEN" | "RESOLVED";
  title: string;
  description: string;
  resourceType: string | null;
  resourceId: string | null;
  occurrenceCount: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
  resolvedAt: Date | null;
}) {
  if (incident.severity === "INFO") {
    throw new Error("Informational watchdog events must not be serialized as incidents");
  }
  return {
    id: incident.id,
    fingerprint: incident.fingerprint,
    domain: incident.domain,
    code: incident.code,
    severity: incident.severity === "CRITICAL" ? ("critical" as const) : ("warning" as const),
    status: incident.status === "OPEN" ? ("open" as const) : ("resolved" as const),
    title: incident.title,
    description: incident.description,
    resourceType: incident.resourceType,
    resourceId: incident.resourceId,
    occurrenceCount: incident.occurrenceCount,
    firstObservedAt: incident.firstObservedAt.toISOString(),
    lastObservedAt: incident.lastObservedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
  };
}

function serializeAnalyticsBreakdown(
  items: Array<{
    key: string;
    label: string;
    trades: number;
    wins: number;
    winRatePercent: number;
    grossPnl: number;
    netPnl: number;
    costs: number;
  }>,
) {
  return items.map((item) => ({
    ...item,
    grossPnl: String(item.grossPnl),
    netPnl: String(item.netPnl),
    costs: String(item.costs),
  }));
}

function createMeta(requestId: string, freshness: "fresh" | "stale" | "unavailable") {
  return {
    requestId,
    generatedAt: new Date().toISOString(),
    freshness,
  };
}

function serializeMetric(value: number | null): string | null {
  return value === null || !Number.isFinite(value) ? null : String(value);
}

function serializeStrategyVersion(
  version: { id: string; version: number; configHash: string; createdAt: Date } | null,
) {
  return version
    ? {
        id: version.id,
        version: version.version,
        configHash: version.configHash,
        createdAt: version.createdAt.toISOString(),
      }
    : null;
}

function createStrategyLifecycleProjection(strategy: {
  status: keyof typeof strategyStatus;
  versions: Array<{ id: string }>;
  validationRuns: Array<{
    status: keyof typeof runStatus;
    verdict: keyof typeof validationVerdict;
    strategyVersion: { id: string };
  }>;
  deployments: Array<{ status: keyof typeof deploymentStatus }>;
}) {
  return evaluateStrategyLifecycle({
    status: strategyStatus[strategy.status],
    latestVersionId: strategy.versions[0]?.id ?? null,
    validations: strategy.validationRuns.map((validation) => ({
      strategyVersionId: validation.strategyVersion.id,
      status: runStatus[validation.status],
      verdict: validationVerdict[validation.verdict],
    })),
    hasActiveDeployment: strategy.deployments.some(
      (deployment) =>
        deployment.status === "READY" ||
        deployment.status === "RUNNING" ||
        deployment.status === "PAUSED",
    ),
  });
}

type ValidationRunSource = {
  id: string;
  kind: keyof typeof validationKind;
  status: keyof typeof runStatus;
  verdict: keyof typeof validationVerdict;
  datasetId: string;
  datasetSnapshot: {
    id: string;
    schemaVersion: number;
    source: string;
    exchange: string;
    instrumentType: string;
    timeframe: string;
    symbols: unknown;
    startsAt: Date;
    endsAt: Date;
    candleCount: number;
    contentHash: string;
    createdAt: Date;
  } | null;
  datasetAsOf: Date;
  engineVersion: string;
  configHash: string;
  input: unknown;
  metrics: unknown;
  failureCode: string | null;
  failureMessage: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  strategy: { id: string; name: string };
  strategyVersion: { id: string; version: number };
};

function serializeValidationRunBase(run: ValidationRunSource) {
  const parsedInput = validationExecutionInputSchema.parse(run.input);
  const datasetSnapshot = run.datasetSnapshot;
  const snapshotSymbols = datasetSnapshot ? readStringArray(datasetSnapshot.symbols) : [];
  if (
    datasetSnapshot &&
    (datasetSnapshot.timeframe !== parsedInput.dataset.timeframe ||
      JSON.stringify(snapshotSymbols) !==
        JSON.stringify([...new Set(parsedInput.dataset.symbols)].sort()))
  ) {
    throw new Error("Validation dataset snapshot does not match run input");
  }
  return {
    id: run.id,
    strategy: run.strategy,
    strategyVersion: run.strategyVersion,
    kind: validationKind[run.kind],
    status: runStatus[run.status],
    verdict: validationVerdict[run.verdict],
    datasetId: run.datasetId,
    datasetSnapshot: datasetSnapshot
      ? {
          id: datasetSnapshot.id,
          schemaVersion: datasetSnapshot.schemaVersion,
          source: datasetSnapshot.source,
          exchange: datasetSnapshot.exchange,
          instrumentType: datasetSnapshot.instrumentType,
          timeframe: parsedInput.dataset.timeframe,
          symbols: snapshotSymbols,
          startsAt: datasetSnapshot.startsAt.toISOString(),
          endsAt: datasetSnapshot.endsAt.toISOString(),
          candleCount: datasetSnapshot.candleCount,
          contentHash: datasetSnapshot.contentHash,
          createdAt: datasetSnapshot.createdAt.toISOString(),
        }
      : null,
    datasetAsOf: run.datasetAsOf.toISOString(),
    engineVersion: run.engineVersion,
    configHash: run.configHash,
    input: parsedInput,
    failureCode: run.failureCode,
    failureMessage: run.failureMessage,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function serializeValidationRun(run: ValidationRunSource) {
  const metrics = run.metrics === null ? null : validationMetricsSchema.parse(run.metrics);
  return {
    ...serializeValidationRunBase(run),
    metrics: metrics === null ? null : validationMetricsSummarySchema.parse(metrics),
  };
}

function serializeValidationRunDetail(run: ValidationRunSource) {
  return {
    ...serializeValidationRunBase(run),
    metrics: run.metrics === null ? null : validationMetricsSchema.parse(run.metrics),
  };
}

type DeploymentSource = {
  id: string;
  environment: keyof typeof tradingEnvironment;
  exchangeAccountId: string;
  status: keyof typeof deploymentStatus;
  createdAt: Date;
  updatedAt: Date;
  strategy: { id: string; name: string };
  strategyVersion: { id: string; version: number };
  executionRuns: Array<{
    id: string;
    status: keyof typeof runStatus;
    contextHash: string;
    engineVersion: string;
    startedAt: Date | null;
    stoppedAt: Date | null;
    createdAt: Date;
    runtimeCursors: Array<{
      lastEvaluatedAt: Date | null;
      consecutiveFailures: number;
    }>;
    decisions: Array<{
      symbol: string;
      action: keyof typeof decisionAction;
      reasonCode: string;
      summary: string;
      decidedAt: Date;
    }>;
    _count: { positions: number };
  }>;
};

function serializeDeployment(deployment: DeploymentSource) {
  const status = deploymentStatus[deployment.status];
  const latestExecutionRun = deployment.executionRuns[0] ?? null;

  return {
    id: deployment.id,
    strategy: deployment.strategy,
    strategyVersion: deployment.strategyVersion,
    environment: tradingEnvironment[deployment.environment],
    exchangeAccountId: deployment.exchangeAccountId,
    status,
    allowedCommands: getDeploymentCommands(status).filter(
      (command) => command !== "stop" || (latestExecutionRun?._count.positions ?? 0) === 0,
    ),
    latestExecutionRun: latestExecutionRun
      ? {
          id: latestExecutionRun.id,
          status: runStatus[latestExecutionRun.status],
          contextHash: latestExecutionRun.contextHash,
          engineVersion: latestExecutionRun.engineVersion,
          startedAt: latestExecutionRun.startedAt?.toISOString() ?? null,
          stoppedAt: latestExecutionRun.stoppedAt?.toISOString() ?? null,
          createdAt: latestExecutionRun.createdAt.toISOString(),
          openPositions: latestExecutionRun._count.positions,
          evaluatedSymbols: latestExecutionRun.runtimeCursors.filter(
            (cursor) => cursor.lastEvaluatedAt !== null,
          ).length,
          failingSymbols: latestExecutionRun.runtimeCursors.filter(
            (cursor) => cursor.consecutiveFailures > 0,
          ).length,
          lastEvaluatedAt:
            latestExecutionRun.runtimeCursors
              .find((cursor) => cursor.lastEvaluatedAt)
              ?.lastEvaluatedAt?.toISOString() ?? null,
          lastDecision: latestExecutionRun.decisions[0]
            ? {
                ...latestExecutionRun.decisions[0],
                action: decisionAction[latestExecutionRun.decisions[0].action],
                decidedAt: latestExecutionRun.decisions[0].decidedAt.toISOString(),
              }
            : null,
        }
      : null,
    createdAt: deployment.createdAt.toISOString(),
    updatedAt: deployment.updatedAt.toISOString(),
  };
}

function throwDeploymentApiError(error: unknown): never {
  if (error instanceof DeploymentStrategyNotFoundError) {
    throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
  }
  if (error instanceof DeploymentNotFoundError) {
    throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "Deployment не найден");
  }
  if (error instanceof DeploymentNotEligibleError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_NOT_ELIGIBLE",
      "Deployment доступен только для одобренной стратегии",
    );
  }
  if (error instanceof DeploymentVersionMismatchError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_VERSION_MISMATCH",
      "Deployment должен использовать активную версию стратегии",
    );
  }
  if (error instanceof DeploymentValidationRequiredError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_VALIDATION_REQUIRED",
      "Для этой версии нет успешно завершённой проверки",
    );
  }
  if (error instanceof ActiveDeploymentExistsError) {
    throw new ApiError(
      409,
      "ACTIVE_DEPLOYMENT_EXISTS",
      "На dry-run счёте уже есть активный deployment",
    );
  }
  if (error instanceof DeploymentStatusConflictError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_STATUS_CONFLICT",
      "Статус deployment уже изменился. Обновите страницу",
    );
  }
  if (error instanceof DeploymentCommandNotAllowedError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_COMMAND_NOT_ALLOWED",
      "Команда недоступна для текущего состояния deployment",
    );
  }
  if (error instanceof DeploymentHasOpenPositionsError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_HAS_OPEN_POSITIONS",
      "Сначала закройте открытые позиции deployment",
    );
  }
  if (error instanceof DeploymentIdempotencyConflictError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_IDEMPOTENCY_CONFLICT",
      "Idempotency key уже использован другой командой",
    );
  }
  throw error;
}

function throwManualCloseApiError(error: unknown): never {
  if (error instanceof RuntimePositionNotFoundError) {
    throw new ApiError(404, "POSITION_NOT_FOUND", "Позиция не найдена");
  }
  if (error instanceof RuntimePositionStatusConflictError) {
    throw new ApiError(409, "POSITION_STATUS_CONFLICT", "Позиция уже закрыта");
  }
  if (error instanceof RuntimeManualCloseNotAllowedError) {
    throw new ApiError(
      409,
      "POSITION_CLOSE_NOT_ALLOWED",
      "Ручное закрытие доступно только активной dry-run позиции",
    );
  }
  if (error instanceof RuntimeMarketPriceUnavailableError) {
    throw new ApiError(
      503,
      "MARKET_PRICE_UNAVAILABLE",
      "Цена для закрытия устарела. Дождитесь обновления рынка",
    );
  }
  if (error instanceof RuntimeIdempotencyConflictError) {
    throw new ApiError(
      409,
      "POSITION_IDEMPOTENCY_CONFLICT",
      "Idempotency key уже использован другой командой",
    );
  }
  throw error;
}

function getValidationMessages(error: unknown): string[] | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("validation" in error) ||
    !Array.isArray(error.validation)
  ) {
    return null;
  }

  return error.validation.map((issue) => {
    if (issue && typeof issue === "object" && "message" in issue) {
      return String(issue.message);
    }
    return "Некорректное значение";
  });
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value].sort()
    : [];
}

function readJsonObject(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Decision factors must be a JSON object");
  }
  return value as Record<string, unknown>;
}

const tradingEnvironment = {
  DRY_RUN: "dry-run",
  DEMO: "demo",
  LIVE: "live",
} as const;

const analyticsTradingEnvironment = {
  "dry-run": "DRY_RUN",
  demo: "DEMO",
  live: "LIVE",
} as const;

const orderSide = {
  BUY: "buy",
  SELL: "sell",
} as const;

const marketRegime = {
  BULL: "bull",
  BEAR: "bear",
  NEUTRAL: "neutral",
  UNKNOWN: "unknown",
} as const;

const tradingSession = {
  ASIA: "asia",
  EUROPE: "europe",
  US: "us",
  OFF_HOURS: "off-hours",
  UNKNOWN: "unknown",
} as const;

const orderType = {
  MARKET: "market",
  LIMIT: "limit",
  STOP: "stop",
} as const;

const orderStatus = {
  PENDING: "pending",
  OPEN: "open",
  PARTIALLY_FILLED: "partially-filled",
  FILLED: "filled",
  CANCELLED: "cancelled",
  REJECTED: "rejected",
} as const;

const decisionAction = {
  OPEN: "open",
  CLOSE: "close",
  HOLD: "hold",
  SKIP: "skip",
  ERROR: "error",
} as const;

const persistedDecisionAction = {
  open: "OPEN",
  close: "CLOSE",
  hold: "HOLD",
  skip: "SKIP",
  error: "ERROR",
} as const;

const runStatus = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

const strategyStatuses = [
  "draft",
  "validating",
  "approved",
  "deployed",
  "paused",
  "archived",
] as const;

const strategyStatus = {
  DRAFT: "draft",
  VALIDATING: "validating",
  APPROVED: "approved",
  DEPLOYED: "deployed",
  PAUSED: "paused",
  ARCHIVED: "archived",
} as const;

const persistedStrategyStatus = {
  draft: "DRAFT",
  validating: "VALIDATING",
  approved: "APPROVED",
  deployed: "DEPLOYED",
  paused: "PAUSED",
  archived: "ARCHIVED",
} as const;

const persistedManualStrategyStatus = {
  draft: "DRAFT",
  approved: "APPROVED",
  archived: "ARCHIVED",
} as const;

const validationKind = {
  BACKTEST: "backtest",
  WALK_FORWARD: "walk-forward",
  HOLDOUT: "holdout",
} as const;

const persistedValidationKind = {
  backtest: "BACKTEST",
  "walk-forward": "WALK_FORWARD",
} as const;

const validationExitReasons: Record<
  string,
  "stop-loss" | "take-profit" | "trailing-stop" | "end-of-data"
> = {
  "stop-loss": "stop-loss",
  "take-profit": "take-profit",
  "trailing-stop": "trailing-stop",
  "end-of-data": "end-of-data",
};

function serializeValidationExitReason(
  value: string,
): "stop-loss" | "take-profit" | "trailing-stop" | "end-of-data" {
  const reason = validationExitReasons[value];
  if (!reason) throw new Error(`Unknown validation exit reason: ${value}`);
  return reason;
}

const validationVerdict = {
  PENDING: "pending",
  PASSED: "passed",
  FAILED: "failed",
  WARNING: "warning",
} as const;

const deploymentStatus = {
  DRAFT: "draft",
  READY: "ready",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPED: "stopped",
  FAILED: "failed",
} as const;

const deploymentStatuses = ["draft", "ready", "running", "paused", "stopped", "failed"] as const;

const persistedDeploymentStatus = {
  draft: "DRAFT",
  ready: "READY",
  running: "RUNNING",
  paused: "PAUSED",
  stopped: "STOPPED",
  failed: "FAILED",
} as const;

const persistedDeploymentCommand = {
  start: "START",
  pause: "PAUSE",
  resume: "RESUME",
  stop: "STOP",
} as const;
