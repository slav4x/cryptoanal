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

export const overviewSchema = z.object({
  runtimeState: runtimeStateSchema,
  tradingEnvironment: z.enum(["dry-run", "demo", "live"]),
  equity: z.string().nullable(),
  dayPnl: z.string(),
  totalPnl: z.string(),
  openExposure: z.string().nullable(),
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
export type HealthDto = z.infer<typeof healthSchema>;
export type Freshness = z.infer<typeof freshnessSchema>;
