import { calculateMarketAnalysis, createDevelopmentContext } from "@cryptoanal/application";
import type { ServerConfig } from "@cryptoanal/config";
import {
  apiEnvelopeSchema,
  errorEnvelopeSchema,
  healthSchema,
  marketDetailSchema,
  marketSymbolParamsSchema,
  marketsSchema,
  overviewQuerySchema,
  overviewSchema,
  requestContextSchema,
  strategyCatalogSchema,
  tradeDetailSchema,
  tradeIdParamsSchema,
  tradingLedgerSchema,
  watchlistStateSchema,
} from "@cryptoanal/contracts";
import { type CryptoAnalPrismaClient, DashboardRepository } from "@cryptoanal/persistence";
import cors from "@fastify/cors";
import Fastify from "fastify";
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

      return {
        data: {
          period,
          runtimeState: workerHealthy ? ("idle" as const) : ("offline" as const),
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

const tradingEnvironment = {
  DRY_RUN: "dry-run",
  DEMO: "demo",
  LIVE: "live",
} as const;

const orderSide = {
  BUY: "buy",
  SELL: "sell",
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

const validationKind = {
  BACKTEST: "backtest",
  WALK_FORWARD: "walk-forward",
  HOLDOUT: "holdout",
} as const;

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
