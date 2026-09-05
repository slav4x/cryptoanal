import { z } from "zod";

export const freshnessSchema = z.enum(["fresh", "stale", "unavailable"]);
export const runtimeStateSchema = z.enum(["offline", "idle", "running", "paused", "error"]);

export const responseMetaSchema = z.object({
  requestId: z.string(),
  generatedAt: z.iso.datetime(),
  freshness: freshnessSchema,
});

export function apiEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    meta: responseMetaSchema,
  });
}

export const requestContextSchema = z.object({
  actorId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  role: z.enum(["owner", "member", "system"]),
  environment: z.enum(["development", "test", "production"]),
});

export const overviewPeriodSchema = z.enum(["24h", "7d", "30d"]);
export const overviewQuerySchema = z.object({
  period: overviewPeriodSchema.default("7d"),
});

export const accountSnapshotPointSchema = z.object({
  equity: z.string(),
  observedAt: z.iso.datetime(),
});

export const overviewSchema = z.object({
  period: overviewPeriodSchema,
  runtimeState: runtimeStateSchema,
  tradingEnvironment: z.enum(["dry-run", "demo", "live"]),
  account: z
    .object({
      exchangeAccountId: z.string(),
      environment: z.enum(["dry-run", "demo", "live"]),
      equity: z.string(),
      availableBalance: z.string().nullable(),
      observedAt: z.iso.datetime(),
    })
    .nullable(),
  equitySeries: z.array(accountSnapshotPointSchema),
  dayPnl: z.string(),
  totalPnl: z.string(),
  unrealizedPnl: z.string(),
  openExposure: z.string(),
  openPositions: z.number().int().nonnegative(),
  activeStrategies: z.number().int().nonnegative(),
  alerts: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(["info", "warning", "critical"]),
      title: z.string(),
      description: z.string(),
    }),
  ),
});

export const marketSchema = z.object({
  symbol: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  exchange: z.string(),
  instrumentType: z.string(),
  watchlisted: z.boolean(),
  price: z.string().nullable(),
  change24hPercent: z.string().nullable(),
  volume24h: z.string().nullable(),
  regime: z.enum(["bull", "bear", "neutral", "unknown"]),
  freshness: freshnessSchema,
});

export const marketsSchema = z.object({
  items: z.array(marketSchema),
  total: z.number().int().nonnegative(),
});

export const marketSymbolParamsSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{4,24}$/),
});

export const marketCandleSchema = z.object({
  openTime: z.iso.datetime(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volume: z.string(),
  turnover: z.string(),
});

export const marketAnalysisSchema = z.object({
  regime: z.enum(["bull", "bear", "neutral", "unknown"]),
  ema20: z.string().nullable(),
  ema50: z.string().nullable(),
  rsi14: z.string().nullable(),
  atr14: z.string().nullable(),
  periodChangePercent: z.string().nullable(),
});

export const marketDetailSchema = z.object({
  market: marketSchema,
  interval: z.literal("15"),
  candles: z.array(marketCandleSchema),
  analysis: marketAnalysisSchema,
});

export const watchlistStateSchema = z.object({
  symbol: z.string(),
  watchlisted: z.boolean(),
});

export const positionSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  environment: z.enum(["dry-run", "demo", "live"]),
  side: z.enum(["buy", "sell"]),
  quantity: z.string(),
  entryPrice: z.string(),
  markPrice: z.string().nullable(),
  unrealizedPnl: z.string(),
  openedAt: z.iso.datetime(),
  strategy: z.object({
    id: z.string(),
    name: z.string(),
    version: z.number().int().positive(),
  }),
});

export const tradeSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  environment: z.enum(["dry-run", "demo", "live"]),
  side: z.enum(["buy", "sell"]),
  quantity: z.string(),
  averageEntryPrice: z.string(),
  averageExitPrice: z.string(),
  grossPnl: z.string(),
  fees: z.string(),
  funding: z.string(),
  slippage: z.string(),
  netPnl: z.string(),
  exitReason: z.string(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime(),
  strategy: z.object({
    id: z.string(),
    name: z.string(),
    version: z.number().int().positive(),
  }),
});

export const tradingLedgerSchema = z.object({
  summary: z.object({
    openPositions: z.number().int().nonnegative(),
    openExposure: z.string(),
    unrealizedPnl: z.string(),
    closedTrades: z.number().int().nonnegative(),
    netPnl: z.string(),
  }),
  positions: z.array(positionSchema),
  trades: z.array(tradeSchema),
});

export const tradeIdParamsSchema = z.object({
  tradeId: z.uuid(),
});

export const fillSchema = z.object({
  id: z.string(),
  exchangeFillId: z.string().nullable(),
  quantity: z.string(),
  price: z.string(),
  fee: z.string(),
  feeAsset: z.string().nullable(),
  filledAt: z.iso.datetime(),
});

export const orderSchema = z.object({
  id: z.string(),
  clientOrderId: z.string(),
  exchangeOrderId: z.string().nullable(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit", "stop"]),
  status: z.enum(["pending", "open", "partially-filled", "filled", "cancelled", "rejected"]),
  quantity: z.string(),
  price: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  fills: z.array(fillSchema),
});

export const tradeDetailSchema = z.object({
  trade: tradeSchema,
  execution: z.object({
    runId: z.string(),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    engineVersion: z.string(),
    configHash: z.string(),
  }),
  orders: z.array(orderSchema),
});

export const strategyStatusSchema = z.enum([
  "draft",
  "validating",
  "approved",
  "deployed",
  "paused",
  "archived",
]);

export const strategyVersionSummarySchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  configHash: z.string(),
  createdAt: z.iso.datetime(),
});

export const strategyValidationSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(["backtest", "walk-forward", "holdout"]),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  verdict: z.enum(["pending", "passed", "failed", "warning"]),
  strategyVersion: z.number().int().positive(),
  completedAt: z.iso.datetime().nullable(),
});

export const strategyDeploymentSummarySchema = z.object({
  id: z.string(),
  environment: z.enum(["dry-run", "demo", "live"]),
  status: z.enum(["draft", "ready", "running", "paused", "stopped", "failed"]),
  strategyVersion: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});

export const strategySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: strategyStatusSchema,
  versionsCount: z.number().int().nonnegative(),
  activeVersion: strategyVersionSummarySchema.nullable(),
  latestVersion: strategyVersionSummarySchema.nullable(),
  lastValidation: strategyValidationSummarySchema.nullable(),
  deployment: strategyDeploymentSummarySchema.nullable(),
  updatedAt: z.iso.datetime(),
});

export const strategyCatalogSchema = z.object({
  items: z.array(strategySummarySchema),
  total: z.number().int().nonnegative(),
  counts: z.record(strategyStatusSchema, z.number().int().nonnegative()),
});

export const strategyConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    universe: z.object({
      symbols: z
        .array(z.string().regex(/^[A-Z0-9]{4,24}$/))
        .min(1)
        .max(50),
      timeframe: z.enum(["5m", "15m", "30m", "1h", "4h"]),
    }),
    signal: z.object({
      direction: z.enum(["long", "short", "both"]),
      emaFastPeriod: z.number().int().min(2).max(200),
      emaSlowPeriod: z.number().int().min(3).max(400),
      rsiPeriod: z.number().int().min(2).max(100),
      rsiOversold: z.number().min(1).max(49),
      rsiOverbought: z.number().min(51).max(99),
    }),
    filters: z.object({
      minimumVolume24hUsdt: z.number().nonnegative(),
      minimumAtrPercent: z.number().min(0).max(100),
      maximumAtrPercent: z.number().min(0).max(100),
    }),
    risk: z.object({
      riskPerTradePercent: z.number().positive().max(10),
      maxOpenPositions: z.number().int().min(1).max(20),
      maxDailyLossPercent: z.number().positive().max(50),
    }),
    entry: z.object({
      orderType: z.enum(["market", "limit"]),
      limitOffsetBps: z.number().min(0).max(500),
    }),
    exit: z.object({
      stopLossPercent: z.number().positive().max(100),
      takeProfitPercent: z.number().positive().max(500),
      trailingStopPercent: z.number().min(0).max(100),
    }),
    costs: z.object({
      makerFeeBps: z.number().min(0).max(100),
      takerFeeBps: z.number().min(0).max(100),
      slippageBps: z.number().min(0).max(500),
    }),
    schedule: z.object({
      timezone: z.string().trim().min(1).max(64),
      activeDays: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).min(1),
    }),
  })
  .superRefine((config, context) => {
    if (config.signal.emaFastPeriod >= config.signal.emaSlowPeriod) {
      context.addIssue({
        code: "custom",
        message: "Быстрая EMA должна быть меньше медленной EMA",
        path: ["signal", "emaFastPeriod"],
      });
    }
    if (config.signal.rsiOversold >= config.signal.rsiOverbought) {
      context.addIssue({
        code: "custom",
        message: "Нижний порог RSI должен быть меньше верхнего",
        path: ["signal", "rsiOversold"],
      });
    }
    if (config.filters.minimumAtrPercent > config.filters.maximumAtrPercent) {
      context.addIssue({
        code: "custom",
        message: "Минимальный ATR не может быть больше максимального",
        path: ["filters", "minimumAtrPercent"],
      });
    }
  });

export const strategyCreateSchema = z.object({
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().max(500).nullable().default(null),
  config: strategyConfigSchema,
});

export const strategyCreatedSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.literal("draft"),
  version: strategyVersionSummarySchema,
});

export const strategyIdParamsSchema = z.object({
  strategyId: z.uuid(),
});

export const strategyVersionDetailSchema = strategyVersionSummarySchema.extend({
  configSchemaVersion: z.number().int().positive(),
  config: strategyConfigSchema,
  changeSummary: z.string().nullable(),
  createdByActorId: z.string(),
});

export const strategyManualStatusSchema = z.enum(["draft", "approved", "archived"]);

export const strategyLifecycleSchema = z.object({
  validation: z.object({
    eligible: z.boolean(),
    reasons: z.array(z.string()),
  }),
  transitions: z.array(
    z.object({
      target: strategyManualStatusSchema,
      allowed: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
});

export const strategyDetailSchema = strategySummarySchema.extend({
  versions: z.array(strategyVersionDetailSchema),
  lifecycle: strategyLifecycleSchema,
});

export const strategyVersionCreateSchema = z.object({
  config: strategyConfigSchema,
  changeSummary: z.string().trim().min(3).max(300),
});

export const strategyVersionCreatedSchema = z.object({
  strategyId: z.string(),
  version: strategyVersionSummarySchema,
});

export const strategyStatusTransitionSchema = z.object({
  expectedStatus: strategyStatusSchema,
  target: strategyManualStatusSchema,
  reason: z.string().trim().min(3).max(300),
});

export const strategyStatusChangedSchema = z.object({
  strategyId: z.string(),
  status: strategyStatusSchema,
});

export const healthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.literal("api"),
  version: z.string(),
  database: z.enum(["connected", "unavailable"]),
  timestamp: z.iso.datetime(),
});

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.array(z.string())).optional(),
    requestId: z.string(),
  }),
});

export type RequestContextDto = z.infer<typeof requestContextSchema>;
export type OverviewPeriod = z.infer<typeof overviewPeriodSchema>;
export type OverviewQueryDto = z.infer<typeof overviewQuerySchema>;
export type AccountSnapshotPointDto = z.infer<typeof accountSnapshotPointSchema>;
export type OverviewDto = z.infer<typeof overviewSchema>;
export type MarketDto = z.infer<typeof marketSchema>;
export type MarketsDto = z.infer<typeof marketsSchema>;
export type MarketCandleDto = z.infer<typeof marketCandleSchema>;
export type MarketAnalysisDto = z.infer<typeof marketAnalysisSchema>;
export type MarketDetailDto = z.infer<typeof marketDetailSchema>;
export type WatchlistStateDto = z.infer<typeof watchlistStateSchema>;
export type PositionDto = z.infer<typeof positionSchema>;
export type TradeDto = z.infer<typeof tradeSchema>;
export type TradingLedgerDto = z.infer<typeof tradingLedgerSchema>;
export type FillDto = z.infer<typeof fillSchema>;
export type OrderDto = z.infer<typeof orderSchema>;
export type TradeDetailDto = z.infer<typeof tradeDetailSchema>;
export type StrategyStatusDto = z.infer<typeof strategyStatusSchema>;
export type StrategySummaryDto = z.infer<typeof strategySummarySchema>;
export type StrategyCatalogDto = z.infer<typeof strategyCatalogSchema>;
export type StrategyConfigDto = z.infer<typeof strategyConfigSchema>;
export type StrategyCreateDto = z.infer<typeof strategyCreateSchema>;
export type StrategyCreatedDto = z.infer<typeof strategyCreatedSchema>;
export type StrategyVersionDetailDto = z.infer<typeof strategyVersionDetailSchema>;
export type StrategyDetailDto = z.infer<typeof strategyDetailSchema>;
export type StrategyVersionCreateDto = z.infer<typeof strategyVersionCreateSchema>;
export type StrategyVersionCreatedDto = z.infer<typeof strategyVersionCreatedSchema>;
export type StrategyLifecycleDto = z.infer<typeof strategyLifecycleSchema>;
export type StrategyManualStatusDto = z.infer<typeof strategyManualStatusSchema>;
export type StrategyStatusTransitionDto = z.infer<typeof strategyStatusTransitionSchema>;
export type StrategyStatusChangedDto = z.infer<typeof strategyStatusChangedSchema>;
export type HealthDto = z.infer<typeof healthSchema>;
export type Freshness = z.infer<typeof freshnessSchema>;
