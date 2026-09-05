import { calculateMarketAnalysis, createDevelopmentContext } from "@cryptoanal/application";
import type { ServerConfig } from "@cryptoanal/config";
import {
  apiEnvelopeSchema,
  errorEnvelopeSchema,
  healthSchema,
  marketDetailSchema,
  marketSymbolParamsSchema,
  marketsSchema,
  overviewSchema,
  requestContextSchema,
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
    const statusCode = error instanceof ApiError ? error.statusCode : 500;
    const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof ApiError ? error.message : "Внутренняя ошибка сервера";

    if (!(error instanceof ApiError)) {
      request.log.error({ err: error }, "Unhandled API error");
    }

    return reply.status(statusCode).send({
      error: {
        code,
        message,
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
        response: {
          200: apiEnvelopeSchema(overviewSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace();
      const overview = await repository.getOverview(workspace.id);
      const now = Date.now();
      const workerHealthy = overview.workerLastSeenAt
        ? now - overview.workerLastSeenAt.getTime() < 45_000
        : false;
      const accountFresh = overview.accountObservedAt
        ? now - overview.accountObservedAt.getTime() < 60_000
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
      if (!overview.accountObservedAt) {
        alerts.push({
          id: "account-data-unavailable",
          severity: "warning" as const,
          title: "Нет данных торгового счёта",
          description: "Exchange adapter ещё не записал account snapshot.",
        });
      }

      return {
        data: {
          runtimeState: workerHealthy ? ("idle" as const) : ("offline" as const),
          tradingEnvironment: "dry-run" as const,
          equity: overview.equity,
          dayPnl: overview.dayPnl,
          totalPnl: overview.totalPnl,
          openExposure: null,
          openPositions: overview.openPositions,
          activeStrategies: overview.activeStrategies,
          alerts,
        },
        meta: createMeta(request.id, accountFresh ? "fresh" : "unavailable"),
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

const tradingEnvironment = {
  DRY_RUN: "dry-run",
  DEMO: "demo",
  LIVE: "live",
} as const;

const orderSide = {
  BUY: "buy",
  SELL: "sell",
} as const;
