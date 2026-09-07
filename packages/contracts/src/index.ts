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

export const authLoginSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(256),
});

export const authWorkspaceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  role: z.enum(["owner", "member"]),
});

export const authSessionSchema = z.discriminatedUnion("authenticated", [
  z.object({ authenticated: z.literal(false) }),
  z.object({
    authenticated: z.literal(true),
    user: z.object({
      id: z.string(),
      email: z.email(),
      displayName: z.string(),
    }),
    activeWorkspace: authWorkspaceSchema,
    workspaces: z.array(authWorkspaceSchema),
    csrfToken: z.string(),
    expiresAt: z.iso.datetime(),
  }),
]);

export const workspaceSwitchSchema = z.object({
  workspaceId: z.string().min(1),
});

export const workspaceCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

export const workspaceRoleSchema = z.enum(["owner", "member"]);
export const workspaceIdParamsSchema = z.object({ workspaceId: z.string().min(1) });
export const workspaceMemberParamsSchema = workspaceIdParamsSchema.extend({
  userId: z.string().min(1),
});
export const workspaceInvitationParamsSchema = workspaceIdParamsSchema.extend({
  invitationId: z.string().min(1),
});
export const invitationTokenParamsSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{40,128}$/),
});
export const workspaceInvitationCreateSchema = z.object({
  email: z.email().max(320),
  role: workspaceRoleSchema.default("member"),
});
export const workspaceMemberRoleUpdateSchema = z.object({ role: workspaceRoleSchema });
export const invitationAcceptSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  password: z.string().min(12).max(256),
});
export const workspaceAccessSchema = z.object({
  members: z.array(
    z.object({
      id: z.string(),
      email: z.email(),
      displayName: z.string(),
      role: workspaceRoleSchema,
      disabled: z.boolean(),
      joinedAt: z.iso.datetime(),
    }),
  ),
  invitations: z.array(
    z.object({
      id: z.string(),
      email: z.email(),
      role: workspaceRoleSchema,
      expiresAt: z.iso.datetime(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export const workspaceInvitationCreatedSchema = z.object({
  invitation: workspaceAccessSchema.shape.invitations.element,
  token: z.string(),
});
export const invitationDetailsSchema = z.object({
  email: z.email(),
  role: workspaceRoleSchema,
  workspace: z.object({ id: z.string(), name: z.string() }),
  expiresAt: z.iso.datetime(),
  existingUser: z.boolean(),
});
export const mutationAcceptedSchema = z.object({ accepted: z.literal(true) });

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

export const analyticsPeriodSchema = z.enum(["7d", "30d", "90d", "all"]);
export const analyticsEnvironmentSchema = z.enum(["dry-run", "demo", "live"]);
export const marketRegimeSchema = z.enum(["bull", "bear", "neutral", "unknown"]);
export const tradingSessionSchema = z.enum(["asia", "europe", "us", "off-hours", "unknown"]);
export const analyticsQuerySchema = z.object({
  period: analyticsPeriodSchema.default("30d"),
  environment: analyticsEnvironmentSchema.optional(),
  strategyId: z.uuid().optional(),
  symbol: z
    .string()
    .regex(/^[A-Z0-9]{4,24}$/)
    .optional(),
});

export const analyticsBreakdownSchema = z.object({
  key: z.string(),
  label: z.string(),
  trades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  winRatePercent: z.number().nonnegative(),
  grossPnl: z.string(),
  netPnl: z.string(),
  costs: z.string(),
});

export const analyticsSchema = z.object({
  filters: z.object({
    period: analyticsPeriodSchema,
    environment: analyticsEnvironmentSchema.nullable(),
    strategyId: z.string().nullable(),
    symbol: z.string().nullable(),
  }),
  filterOptions: z.object({
    strategies: z.array(z.object({ id: z.string(), name: z.string() })),
    symbols: z.array(z.string()),
    environments: z.array(analyticsEnvironmentSchema),
  }),
  initialCapital: z.string(),
  summary: z.object({
    trades: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    breakeven: z.number().int().nonnegative(),
    winRatePercent: z.number().nonnegative(),
    grossPnl: z.string(),
    netPnl: z.string(),
    totalFees: z.string(),
    totalFunding: z.string(),
    totalSlippage: z.string(),
    profitFactor: z.number().nonnegative().nullable(),
    expectancy: z.string(),
    maxDrawdownPercent: z.number().nonnegative(),
    averageWin: z.string(),
    averageLoss: z.string(),
    payoffRatio: z.number().nonnegative().nullable(),
    bestTrade: z.string(),
    worstTrade: z.string(),
  }),
  equitySeries: z.array(
    z.object({
      observedAt: z.iso.datetime(),
      equity: z.string(),
      cumulativeNetPnl: z.string(),
      drawdownPercent: z.number().nonnegative(),
    }),
  ),
  dailyPnl: z.array(
    z.object({
      date: z.iso.date(),
      netPnl: z.string(),
      trades: z.number().int().nonnegative(),
    }),
  ),
  breakdowns: z.object({
    strategies: z.array(analyticsBreakdownSchema),
    symbols: z.array(analyticsBreakdownSchema),
    exitReasons: z.array(analyticsBreakdownSchema),
    regimes: z.array(analyticsBreakdownSchema),
    sessions: z.array(analyticsBreakdownSchema),
  }),
  distributions: z.object({
    pnl: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        trades: z.number().int().nonnegative(),
        netPnl: z.string(),
      }),
    ),
    holdingTime: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        minMinutes: z.number().nonnegative(),
        maxMinutes: z.number().positive().nullable(),
        trades: z.number().int().nonnegative(),
        winRatePercent: z.number().nonnegative(),
        netPnl: z.string(),
      }),
    ),
  }),
});

export const tradeSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  environment: z.enum(["dry-run", "demo", "live"]),
  side: z.enum(["buy", "sell"]),
  entryRegime: marketRegimeSchema,
  entrySession: tradingSessionSchema,
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

export const positionIdParamsSchema = z.object({ positionId: z.uuid() });
export const positionCloseInputSchema = z.object({
  expectedStatus: z.literal("open"),
  reason: z.string().trim().min(3).max(300),
  idempotencyKey: z.uuid(),
});
export const positionCloseResultSchema = z.object({
  positionId: z.string(),
  tradeId: z.string(),
  replayed: z.boolean(),
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

export const deploymentStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "paused",
  "stopped",
  "failed",
]);

export const deploymentCommandSchema = z.enum(["start", "pause", "resume", "stop"]);

export const strategyDeploymentSummarySchema = z.object({
  id: z.string(),
  environment: z.enum(["dry-run", "demo", "live"]),
  status: deploymentStatusSchema,
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

export const validationKindSchema = z.enum(["backtest", "walk-forward", "holdout"]);
export const validationQueueKindSchema = z.enum(["backtest", "walk-forward"]);

const validationDatasetSchema = z.object({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  symbols: z
    .array(z.string().regex(/^[A-Z0-9]{4,24}$/))
    .min(1)
    .max(10),
  timeframe: z.enum(["5m", "15m", "30m", "1h", "4h"]),
});

const validationWalkForwardSchema = z
  .object({
    trainingDays: z.number().int().min(7).max(3650),
    testDays: z.number().int().min(1).max(365),
  })
  .nullable();

export const validationRunInputSchema = z
  .object({
    strategyVersionId: z.uuid(),
    kind: validationQueueKindSchema,
    dataset: validationDatasetSchema,
    initialCapital: z.string().regex(/^\d+(?:\.\d{1,8})?$/),
    walkForward: validationWalkForwardSchema,
    idempotencyKey: z.uuid(),
  })
  .superRefine((input, context) => {
    if (input.dataset.startDate >= input.dataset.endDate) {
      context.addIssue({
        code: "custom",
        message: "Дата начала должна быть раньше даты окончания",
        path: ["dataset", "startDate"],
      });
    }
    if (!Number.isFinite(Number(input.initialCapital)) || Number(input.initialCapital) <= 0) {
      context.addIssue({
        code: "custom",
        message: "Начальный капитал должен быть больше нуля",
        path: ["initialCapital"],
      });
    }
    if (input.kind === "walk-forward" && input.walkForward === null) {
      context.addIssue({
        code: "custom",
        message: "Для walk-forward нужны размеры training и test окон",
        path: ["walkForward"],
      });
    }
  });

export const validationExecutionInputSchema = z.object({
  kind: validationKindSchema,
  dataset: validationDatasetSchema,
  initialCapital: z.string().regex(/^\d+(?:\.\d{1,8})?$/),
  walkForward: validationWalkForwardSchema,
});

export const validationTradeResultSchema = z.object({
  symbol: z.string(),
  side: z.enum(["long", "short"]),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime(),
  entryPrice: z.number(),
  exitPrice: z.number(),
  quantity: z.number(),
  netPnl: z.number(),
  fees: z.number().nonnegative(),
  exitReason: z.enum(["stop-loss", "take-profit", "trailing-stop", "end-of-data"]),
});

export const validationMetricsSchema = z.object({
  trades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  winRatePercent: z.number(),
  netPnl: z.number(),
  returnPercent: z.number(),
  maxDrawdownPercent: z.number().nonnegative(),
  profitFactor: z.number().nonnegative().nullable(),
  expectancy: z.number(),
  totalFees: z.number().nonnegative(),
  candleCount: z.number().int().nonnegative(),
  windows: z.number().int().nonnegative(),
  perSymbol: z.record(
    z.string(),
    z.object({ trades: z.number().int().nonnegative(), netPnl: z.number() }),
  ),
  equitySeries: z.array(z.object({ observedAt: z.iso.datetime(), equity: z.number() })),
  gateReasons: z.array(z.string()),
  provenance: z.object({
    datasetHash: z.string(),
    symbols: z.array(z.string()),
    timeframe: z.enum(["5m", "15m", "30m", "1h", "4h"]),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    candleCount: z.number().int().nonnegative(),
  }),
});

export const validationMetricsSummarySchema = validationMetricsSchema.pick({
  trades: true,
  wins: true,
  losses: true,
  winRatePercent: true,
  netPnl: true,
  returnPercent: true,
  maxDrawdownPercent: true,
  profitFactor: true,
  expectancy: true,
  totalFees: true,
  candleCount: true,
  windows: true,
  gateReasons: true,
});

const validationRunBaseSchema = z.object({
  id: z.string(),
  strategy: z.object({ id: z.string(), name: z.string() }),
  strategyVersion: z.object({ id: z.string(), version: z.number().int().positive() }),
  kind: validationKindSchema,
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  verdict: z.enum(["pending", "passed", "failed", "warning"]),
  datasetId: z.string(),
  datasetSnapshot: z
    .object({
      id: z.uuid(),
      schemaVersion: z.number().int().positive(),
      source: z.string(),
      exchange: z.string(),
      instrumentType: z.string(),
      timeframe: z.enum(["5m", "15m", "30m", "1h", "4h"]),
      symbols: z.array(z.string()),
      startsAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
      candleCount: z.number().int().nonnegative(),
      contentHash: z.string(),
      createdAt: z.iso.datetime(),
    })
    .nullable(),
  datasetAsOf: z.iso.datetime(),
  engineVersion: z.string(),
  configHash: z.string(),
  input: validationExecutionInputSchema,
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});

export const validationRunSchema = validationRunBaseSchema.extend({
  metrics: validationMetricsSummarySchema.nullable(),
});

export const validationRunDetailSchema = z.object({
  run: validationRunBaseSchema.extend({ metrics: validationMetricsSchema.nullable() }),
  trades: z.array(validationTradeResultSchema),
  tradesTotal: z.number().int().nonnegative(),
  tradePage: z.number().int().positive(),
  tradeLimit: z.number().int().positive(),
});

export const validationRunIdParamsSchema = z.object({ validationRunId: z.uuid() });
export const validationRunDetailQuerySchema = z.object({
  tradePage: z.coerce.number().int().min(1).default(1),
  tradeLimit: z.coerce.number().int().min(1).max(100).default(50),
});

export const validationsSchema = z.object({
  items: z.array(validationRunSchema),
  total: z.number().int().nonnegative(),
  counts: z.object({
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
});

export const validationRunQueuedSchema = z.object({
  run: validationRunSchema,
  job: z.object({
    id: z.string(),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    replayed: z.boolean(),
  }),
});

export const executionRunSummarySchema = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  contextHash: z.string(),
  engineVersion: z.string(),
  startedAt: z.iso.datetime().nullable(),
  stoppedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  openPositions: z.number().int().nonnegative(),
  evaluatedSymbols: z.number().int().nonnegative(),
  failingSymbols: z.number().int().nonnegative(),
  lastEvaluatedAt: z.iso.datetime().nullable(),
  lastDecision: z
    .object({
      symbol: z.string(),
      action: z.enum(["open", "close", "hold", "skip", "error"]),
      reasonCode: z.string(),
      summary: z.string(),
      decidedAt: z.iso.datetime(),
    })
    .nullable(),
});

export const deploymentSchema = z.object({
  id: z.string(),
  strategy: z.object({ id: z.string(), name: z.string() }),
  strategyVersion: z.object({ id: z.string(), version: z.number().int().positive() }),
  environment: z.enum(["dry-run", "demo", "live"]),
  exchangeAccountId: z.string(),
  status: deploymentStatusSchema,
  allowedCommands: z.array(deploymentCommandSchema),
  latestExecutionRun: executionRunSummarySchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const deploymentsSchema = z.object({
  items: z.array(deploymentSchema),
  total: z.number().int().nonnegative(),
  counts: z.record(deploymentStatusSchema, z.number().int().nonnegative()),
});

export const deploymentCreateSchema = z.object({
  strategyVersionId: z.uuid(),
  idempotencyKey: z.uuid(),
});

export const deploymentCommandInputSchema = z.object({
  command: deploymentCommandSchema,
  expectedStatus: deploymentStatusSchema,
  reason: z.string().trim().min(3).max(300),
  idempotencyKey: z.uuid(),
});

export const deploymentMutationResultSchema = z.object({
  deployment: deploymentSchema,
  replayed: z.boolean(),
});

export const deploymentIdParamsSchema = z.object({ deploymentId: z.uuid() });

export const healthLevelSchema = z.enum(["healthy", "degraded", "critical", "unknown"]);
export const incidentSeveritySchema = z.enum(["warning", "critical"]);
export const incidentStatusSchema = z.enum(["open", "resolved"]);

const driftMetricsSchema = z.object({
  trades: z.number().int().nonnegative(),
  winRatePercent: z.number().nonnegative(),
  expectancy: z.number(),
  profitFactor: z.number().nonnegative().nullable(),
  maxDrawdownPercent: z.number().nonnegative(),
});

export const healthDashboardSchema = z.object({
  overallStatus: z.enum(["healthy", "degraded", "critical"]),
  checkedAt: z.iso.datetime(),
  watchdogLastSeenAt: z.iso.datetime().nullable(),
  domains: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      status: healthLevelSchema,
      summary: z.string(),
      observedAt: z.iso.datetime().nullable(),
    }),
  ),
  incidents: z.array(
    z.object({
      id: z.string(),
      fingerprint: z.string(),
      domain: z.string(),
      code: z.string(),
      severity: incidentSeveritySchema,
      status: incidentStatusSchema,
      title: z.string(),
      description: z.string(),
      resourceType: z.string().nullable(),
      resourceId: z.string().nullable(),
      occurrenceCount: z.number().int().positive(),
      firstObservedAt: z.iso.datetime(),
      lastObservedAt: z.iso.datetime(),
      resolvedAt: z.iso.datetime().nullable(),
    }),
  ),
  drift: z.array(
    z.object({
      deploymentId: z.string(),
      executionRunId: z.string(),
      strategyId: z.string(),
      strategyName: z.string(),
      strategyVersion: z.number().int().positive(),
      environment: analyticsEnvironmentSchema,
      validationRunId: z.string(),
      status: z.enum(["insufficient-data", "within-range", "warning", "critical"]),
      minimumSampleSize: z.number().int().positive(),
      baseline: driftMetricsSchema,
      runtime: driftMetricsSchema,
      delta: z.object({
        winRatePercentagePoints: z.number(),
        expectancyPercent: z.number().nullable(),
        profitFactorPercent: z.number().nullable(),
        maxDrawdownPercentagePoints: z.number(),
      }),
    }),
  ),
  notices: z.object({
    riskStops24h: z.number().int().nonnegative(),
    rejectedOrders24h: z.number().int().nonnegative(),
    failedJobs24h: z.number().int().nonnegative(),
  }),
});

export const activityActionSchema = z.enum(["open", "close", "hold", "skip", "error"]);
export const activityPeriodSchema = z.enum(["24h", "7d", "30d", "all"]);
export const activityQuerySchema = z.object({
  period: activityPeriodSchema.default("24h"),
  action: activityActionSchema.optional(),
  strategyId: z.uuid().optional(),
  symbol: z
    .string()
    .regex(/^[A-Z0-9]{4,24}$/)
    .optional(),
  reasonCode: z.string().trim().min(1).max(100).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const activitySchema = z.object({
  filters: z.object({
    period: activityPeriodSchema,
    action: activityActionSchema.nullable(),
    strategyId: z.string().nullable(),
    symbol: z.string().nullable(),
    reasonCode: z.string().nullable(),
  }),
  filterOptions: z.object({
    strategies: z.array(z.object({ id: z.string(), name: z.string() })),
    symbols: z.array(z.string()),
    reasonCodes: z.array(z.string()),
    actions: z.array(activityActionSchema),
  }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    close: z.number().int().nonnegative(),
    hold: z.number().int().nonnegative(),
    skip: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  }),
  items: z.array(
    z.object({
      id: z.string(),
      symbol: z.string(),
      action: activityActionSchema,
      reasonCode: z.string(),
      summary: z.string(),
      factors: z.record(z.string(), z.unknown()),
      marketSnapshotRef: z.string().nullable(),
      correlationId: z.string(),
      decidedAt: z.iso.datetime(),
      strategy: z.object({
        id: z.string(),
        name: z.string(),
        versionId: z.string(),
        version: z.number().int().positive(),
      }),
      execution: z.object({
        runId: z.string(),
        deploymentId: z.string(),
        environment: analyticsEnvironmentSchema,
        status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
      }),
      links: z.object({
        positionId: z.string().nullable(),
        tradeId: z.string().nullable(),
      }),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const journalEntryKindSchema = z.enum([
  "hypothesis",
  "observation",
  "conclusion",
  "decision",
]);
export const journalLinkTypeSchema = z.enum([
  "strategy",
  "strategy-version",
  "execution-run",
  "validation-run",
  "trade",
  "decision",
  "symbol",
]);
export const journalQuerySchema = z.object({
  period: analyticsPeriodSchema.default("30d"),
  kind: journalEntryKindSchema.optional(),
  strategyId: z.uuid().optional(),
  symbol: z
    .string()
    .regex(/^[A-Z0-9]{4,24}$/)
    .optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const journalTagSchema = z.string().trim().min(1).max(40);
const journalLinkInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("strategy"), targetId: z.uuid() }),
  z.object({ type: z.literal("strategy-version"), targetId: z.uuid() }),
  z.object({ type: z.literal("execution-run"), targetId: z.uuid() }),
  z.object({ type: z.literal("validation-run"), targetId: z.uuid() }),
  z.object({ type: z.literal("trade"), targetId: z.uuid() }),
  z.object({ type: z.literal("decision"), targetId: z.uuid() }),
  z.object({
    type: z.literal("symbol"),
    targetId: z.string().regex(/^[A-Z0-9]{4,24}$/),
  }),
]);

export const journalEntryCreateSchema = z.object({
  kind: journalEntryKindSchema,
  title: z.string().trim().min(3).max(140),
  body: z.string().trim().min(3).max(10_000),
  tags: z.array(journalTagSchema).max(12).default([]),
  occurredAt: z.iso.datetime().optional(),
  links: z.array(journalLinkInputSchema).max(8).default([]),
});

export const reviewSessionCreateSchema = z
  .object({
    title: z.string().trim().min(3).max(140),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    summary: z.string().trim().min(10).max(10_000),
    learnings: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    nextActions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    tags: z.array(journalTagSchema).max(12).default([]),
  })
  .refine((value) => new Date(value.startsAt) <= new Date(value.endsAt), {
    message: "Начало периода должно быть раньше окончания",
    path: ["endsAt"],
  });

export const journalLinkSchema = z.object({
  type: journalLinkTypeSchema,
  targetId: z.string(),
  label: z.string(),
  href: z.string().nullable(),
});

export const journalEntrySchema = z.object({
  id: z.string(),
  kind: journalEntryKindSchema,
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  occurredAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  links: z.array(journalLinkSchema),
});

export const reviewSessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  summary: z.string(),
  learnings: z.array(z.string()),
  nextActions: z.array(z.string()),
  tags: z.array(z.string()),
  entryCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

const journalTargetOptionSchema = z.object({ id: z.string(), label: z.string() });

export const journalSchema = z.object({
  filters: z.object({
    period: analyticsPeriodSchema,
    kind: journalEntryKindSchema.nullable(),
    strategyId: z.string().nullable(),
    symbol: z.string().nullable(),
    tag: z.string().nullable(),
  }),
  filterOptions: z.object({
    strategies: z.array(z.object({ id: z.string(), name: z.string() })),
    symbols: z.array(z.string()),
    tags: z.array(z.string()),
    kinds: z.array(journalEntryKindSchema),
  }),
  linkOptions: z.object({
    strategies: z.array(journalTargetOptionSchema),
    strategyVersions: z.array(journalTargetOptionSchema),
    executionRuns: z.array(journalTargetOptionSchema),
    validationRuns: z.array(journalTargetOptionSchema),
    trades: z.array(journalTargetOptionSchema),
    decisions: z.array(journalTargetOptionSchema),
    symbols: z.array(journalTargetOptionSchema),
  }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    hypothesis: z.number().int().nonnegative(),
    observation: z.number().int().nonnegative(),
    conclusion: z.number().int().nonnegative(),
    decision: z.number().int().nonnegative(),
    reviews: z.number().int().nonnegative(),
  }),
  entries: z.array(journalEntrySchema),
  reviews: z.array(reviewSessionSchema),
  nextCursor: z.string().nullable(),
});

export const journalEntryCreatedSchema = z.object({ entry: journalEntrySchema });
export const reviewSessionCreatedSchema = z.object({ review: reviewSessionSchema });

export const playbookStatusSchema = z.enum(["active", "archived"]);
export const playbookQuerySchema = z.object({
  status: playbookStatusSchema.optional(),
  strategyId: z.uuid().optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  query: z.string().trim().min(1).max(100).optional(),
});

const playbookRuleSchema = z.string().trim().min(1).max(500);
const playbookTagSchema = z.string().trim().min(1).max(40);
const playbookContentSchema = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().min(3).max(2_000),
  marketConditions: z.string().trim().min(3).max(4_000),
  entryRules: z.array(playbookRuleSchema).min(1).max(30),
  exitRules: z.array(playbookRuleSchema).max(30).default([]),
  riskRules: z.array(playbookRuleSchema).max(30).default([]),
  invalidationRules: z.array(playbookRuleSchema).min(1).max(30),
  checklist: z.array(playbookRuleSchema).max(40).default([]),
  tags: z.array(playbookTagSchema).max(12).default([]),
  strategyIds: z.array(z.uuid()).max(20).default([]),
  tradeIds: z.array(z.uuid()).max(50).default([]),
});

export const playbookCreateSchema = playbookContentSchema;
export const playbookUpdateSchema = playbookContentSchema.extend({
  expectedUpdatedAt: z.iso.datetime(),
});
export const playbookIdParamsSchema = z.object({ playbookId: z.uuid() });
export const playbookStatusChangeSchema = z
  .object({
    expectedStatus: playbookStatusSchema,
    status: playbookStatusSchema,
    reason: z.string().trim().min(3).max(300),
  })
  .refine((value) => value.expectedStatus !== value.status, {
    message: "Новый статус должен отличаться от текущего",
    path: ["status"],
  });

export const playbookSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: playbookStatusSchema,
  marketConditions: z.string(),
  entryRules: z.array(z.string()),
  exitRules: z.array(z.string()),
  riskRules: z.array(z.string()),
  invalidationRules: z.array(z.string()),
  checklist: z.array(z.string()),
  tags: z.array(z.string()),
  strategies: z.array(z.object({ id: z.string(), name: z.string() })),
  exampleTrades: z.array(
    z.object({
      id: z.string(),
      symbol: z.string(),
      side: z.enum(["buy", "sell"]),
      netPnl: z.string(),
      closedAt: z.iso.datetime(),
    }),
  ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const playbooksSchema = z.object({
  filters: z.object({
    status: playbookStatusSchema.nullable(),
    strategyId: z.string().nullable(),
    tag: z.string().nullable(),
    query: z.string().nullable(),
  }),
  filterOptions: z.object({
    statuses: z.array(playbookStatusSchema),
    strategies: z.array(z.object({ id: z.string(), name: z.string() })),
    tags: z.array(z.string()),
  }),
  linkOptions: z.object({
    strategies: z.array(z.object({ id: z.string(), label: z.string() })),
    trades: z.array(z.object({ id: z.string(), label: z.string() })),
  }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    linkedStrategies: z.number().int().nonnegative(),
    exampleTrades: z.number().int().nonnegative(),
  }),
  items: z.array(playbookSchema),
});

export const playbookMutationSchema = z.object({ playbook: playbookSchema });

export const tableDensitySchema = z.enum(["compact", "comfortable"]);
export const workspacePreferencesSchema = z.object({
  timezone: z.string(),
  currency: z.literal("USDT"),
  tableDensity: tableDensitySchema,
  updatedAt: z.iso.datetime(),
});
export const settingsUpdateSchema = z.object({
  timezone: z.string().trim().min(1).max(100),
  tableDensity: tableDensitySchema,
  expectedUpdatedAt: z.iso.datetime(),
});
export const settingsSchema = z.object({
  preferences: workspacePreferencesSchema,
  runtimeSafety: z.object({
    environment: z.enum(["development", "test", "production"]),
    tradingEnvironment: z.literal("dry-run"),
    confirmationsRequired: z.literal(true),
    liveTradingEnabled: z.literal(false),
    maxActiveDeployments: z.literal(1),
  }),
  marketData: z.object({
    provider: z.literal("Bybit public API"),
    marketPollIntervalMs: z.number().int().positive(),
    candlePollIntervalMs: z.number().int().positive(),
    accountSnapshotIntervalMs: z.number().int().positive(),
  }),
  exchange: z.object({
    publicConnectionConfigured: z.boolean(),
    privateConnectionConfigured: z.literal(false),
    accountId: z.string(),
  }),
  notifications: z.object({
    configured: z.literal(false),
    reason: z.string(),
  }),
  retention: z.object({
    automaticCleanupEnabled: z.literal(false),
    exportFormat: z.literal("json"),
    exportIncludes: z.array(z.string()),
    exportExcludes: z.array(z.string()),
  }),
  system: z.object({
    applicationVersion: z.string(),
    workspaceId: z.string(),
    actorId: z.string(),
    database: z.enum(["connected", "unavailable"]),
  }),
});
export const settingsMutationSchema = z.object({ preferences: workspacePreferencesSchema });
export const settingsExportSchema = z.object({
  filename: z.string(),
  mediaType: z.literal("application/json"),
  content: z.string(),
});

export const systemLogLevelSchema = z.enum(["debug", "info", "warning", "error", "critical"]);
export const systemLogPeriodSchema = z.enum(["1h", "24h", "7d", "30d", "all"]);
export const systemLogsQuerySchema = z.object({
  period: systemLogPeriodSchema.default("24h"),
  level: systemLogLevelSchema.optional(),
  service: z.string().trim().min(1).max(60).optional(),
  correlationId: z.string().trim().min(1).max(120).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const systemLogSchema = z.object({
  id: z.string(),
  level: systemLogLevelSchema,
  service: z.string(),
  event: z.string(),
  message: z.string(),
  correlationId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});
export const systemLogsSchema = z.object({
  filters: z.object({
    period: systemLogPeriodSchema,
    level: systemLogLevelSchema.nullable(),
    service: z.string().nullable(),
    correlationId: z.string().nullable(),
    query: z.string().nullable(),
  }),
  filterOptions: z.object({
    levels: z.array(systemLogLevelSchema),
    services: z.array(z.string()),
  }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    services: z.number().int().nonnegative(),
  }),
  items: z.array(systemLogSchema),
  nextCursor: z.string().nullable(),
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
export type AuthLoginDto = z.infer<typeof authLoginSchema>;
export type AuthSessionDto = z.infer<typeof authSessionSchema>;
export type AuthWorkspaceDto = z.infer<typeof authWorkspaceSchema>;
export type WorkspaceSwitchDto = z.infer<typeof workspaceSwitchSchema>;
export type WorkspaceCreateDto = z.infer<typeof workspaceCreateSchema>;
export type WorkspaceAccessDto = z.infer<typeof workspaceAccessSchema>;
export type WorkspaceInvitationCreateDto = z.infer<typeof workspaceInvitationCreateSchema>;
export type WorkspaceInvitationCreatedDto = z.infer<typeof workspaceInvitationCreatedSchema>;
export type WorkspaceMemberRoleUpdateDto = z.infer<typeof workspaceMemberRoleUpdateSchema>;
export type InvitationAcceptDto = z.infer<typeof invitationAcceptSchema>;
export type InvitationDetailsDto = z.infer<typeof invitationDetailsSchema>;
export type OverviewPeriod = z.infer<typeof overviewPeriodSchema>;
export type OverviewQueryDto = z.infer<typeof overviewQuerySchema>;
export type AccountSnapshotPointDto = z.infer<typeof accountSnapshotPointSchema>;
export type OverviewDto = z.infer<typeof overviewSchema>;
export type AnalyticsPeriod = z.infer<typeof analyticsPeriodSchema>;
export type AnalyticsEnvironment = z.infer<typeof analyticsEnvironmentSchema>;
export type AnalyticsQueryDto = z.infer<typeof analyticsQuerySchema>;
export type AnalyticsBreakdownDto = z.infer<typeof analyticsBreakdownSchema>;
export type AnalyticsDto = z.infer<typeof analyticsSchema>;
export type MarketDto = z.infer<typeof marketSchema>;
export type MarketsDto = z.infer<typeof marketsSchema>;
export type MarketCandleDto = z.infer<typeof marketCandleSchema>;
export type MarketAnalysisDto = z.infer<typeof marketAnalysisSchema>;
export type MarketDetailDto = z.infer<typeof marketDetailSchema>;
export type WatchlistStateDto = z.infer<typeof watchlistStateSchema>;
export type PositionDto = z.infer<typeof positionSchema>;
export type TradeDto = z.infer<typeof tradeSchema>;
export type TradingLedgerDto = z.infer<typeof tradingLedgerSchema>;
export type PositionCloseInputDto = z.infer<typeof positionCloseInputSchema>;
export type PositionCloseResultDto = z.infer<typeof positionCloseResultSchema>;
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
export type ValidationKindDto = z.infer<typeof validationKindSchema>;
export type ValidationRunInputDto = z.infer<typeof validationRunInputSchema>;
export type ValidationExecutionInputDto = z.infer<typeof validationExecutionInputSchema>;
export type ValidationMetricsDto = z.infer<typeof validationMetricsSchema>;
export type ValidationMetricsSummaryDto = z.infer<typeof validationMetricsSummarySchema>;
export type ValidationTradeResultDto = z.infer<typeof validationTradeResultSchema>;
export type ValidationRunDto = z.infer<typeof validationRunSchema>;
export type ValidationRunDetailDto = z.infer<typeof validationRunDetailSchema>;
export type ValidationsDto = z.infer<typeof validationsSchema>;
export type ValidationRunQueuedDto = z.infer<typeof validationRunQueuedSchema>;
export type DeploymentStatusDto = z.infer<typeof deploymentStatusSchema>;
export type DeploymentCommandDto = z.infer<typeof deploymentCommandSchema>;
export type DeploymentDto = z.infer<typeof deploymentSchema>;
export type DeploymentsDto = z.infer<typeof deploymentsSchema>;
export type DeploymentCreateDto = z.infer<typeof deploymentCreateSchema>;
export type DeploymentCommandInputDto = z.infer<typeof deploymentCommandInputSchema>;
export type DeploymentMutationResultDto = z.infer<typeof deploymentMutationResultSchema>;
export type HealthLevel = z.infer<typeof healthLevelSchema>;
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;
export type HealthDashboardDto = z.infer<typeof healthDashboardSchema>;
export type ActivityAction = z.infer<typeof activityActionSchema>;
export type ActivityPeriod = z.infer<typeof activityPeriodSchema>;
export type ActivityQueryDto = z.infer<typeof activityQuerySchema>;
export type ActivityDto = z.infer<typeof activitySchema>;
export type JournalEntryKind = z.infer<typeof journalEntryKindSchema>;
export type JournalLinkType = z.infer<typeof journalLinkTypeSchema>;
export type JournalQueryDto = z.infer<typeof journalQuerySchema>;
export type JournalEntryCreateDto = z.infer<typeof journalEntryCreateSchema>;
export type ReviewSessionCreateDto = z.infer<typeof reviewSessionCreateSchema>;
export type JournalEntryDto = z.infer<typeof journalEntrySchema>;
export type ReviewSessionDto = z.infer<typeof reviewSessionSchema>;
export type JournalDto = z.infer<typeof journalSchema>;
export type JournalEntryCreatedDto = z.infer<typeof journalEntryCreatedSchema>;
export type ReviewSessionCreatedDto = z.infer<typeof reviewSessionCreatedSchema>;
export type PlaybookStatus = z.infer<typeof playbookStatusSchema>;
export type PlaybookQueryDto = z.infer<typeof playbookQuerySchema>;
export type PlaybookCreateDto = z.infer<typeof playbookCreateSchema>;
export type PlaybookUpdateDto = z.infer<typeof playbookUpdateSchema>;
export type PlaybookStatusChangeDto = z.infer<typeof playbookStatusChangeSchema>;
export type PlaybookDto = z.infer<typeof playbookSchema>;
export type PlaybooksDto = z.infer<typeof playbooksSchema>;
export type PlaybookMutationDto = z.infer<typeof playbookMutationSchema>;
export type TableDensity = z.infer<typeof tableDensitySchema>;
export type WorkspacePreferencesDto = z.infer<typeof workspacePreferencesSchema>;
export type SettingsDto = z.infer<typeof settingsSchema>;
export type SettingsUpdateDto = z.infer<typeof settingsUpdateSchema>;
export type SettingsMutationDto = z.infer<typeof settingsMutationSchema>;
export type SettingsExportDto = z.infer<typeof settingsExportSchema>;
export type SystemLogLevel = z.infer<typeof systemLogLevelSchema>;
export type SystemLogPeriod = z.infer<typeof systemLogPeriodSchema>;
export type SystemLogsQueryDto = z.infer<typeof systemLogsQuerySchema>;
export type SystemLogDto = z.infer<typeof systemLogSchema>;
export type SystemLogsDto = z.infer<typeof systemLogsSchema>;
export type HealthDto = z.infer<typeof healthSchema>;
export type Freshness = z.infer<typeof freshnessSchema>;
