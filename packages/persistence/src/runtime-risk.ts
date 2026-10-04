import {
  executionStopRisk,
  remainingExecutionStopBudget,
} from "../../application/src/execution-risk";
import { Prisma } from "./generated/prisma/client";
import type { CryptoAnalPrismaClient } from "./client";

export type RuntimeRiskPolicy = {
  initialBalance: number;
  maxDailyLossPercent: number;
  maxAccountExposurePercent: number;
  maxOpenPositions: number;
  maxQuoteAgeMs: number;
};
export const defaultRuntimeRiskPolicy: RuntimeRiskPolicy = {
  initialBalance: 10_000,
  maxDailyLossPercent: 10,
  maxAccountExposurePercent: 100,
  maxOpenPositions: 20,
  maxQuoteAgeMs: 10_000,
};

export async function lockRuntimeRisk(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`risk:${workspaceId}`}))`,
  );
}

export function readRiskConfig(value: Prisma.JsonValue) {
  const config = value as Record<string, unknown> | null;
  const risk = config?.risk as Record<string, unknown> | undefined;
  const costs = config?.costs as Record<string, unknown> | undefined;
  const schedule = config?.schedule as Record<string, unknown> | undefined;
  const timezone = schedule?.timezone;
  if (typeof timezone !== "string") return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    return null;
  }
  const numbers = [
    risk?.maxDailyLossPercent,
    risk?.maxOpenPositions,
    risk?.riskPerTradePercent,
    costs?.takerFeeBps,
    costs?.slippageBps,
  ];
  if (
    numbers.some((number) => typeof number !== "number" || !Number.isFinite(number) || number < 0)
  )
    return null;
  return {
    timezone,
    maxDailyLossPercent: numbers[0] as number,
    maxOpenPositions: numbers[1] as number,
    riskPerTradePercent: numbers[2] as number,
    takerFeeBps: numbers[3] as number,
    slippageBps: numbers[4] as number,
  };
}

export async function assessRuntimeRisk(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    exchangeAccountId: string;
    strategyConfig: Prisma.JsonValue;
    policy: RuntimeRiskPolicy;
    now?: Date;
  },
) {
  const configured = readRiskConfig(input.strategyConfig);
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(
    input.now
      ? Prisma.sql`SELECT ${input.now}::timestamptz AS now`
      : Prisma.sql`SELECT clock_timestamp() AS now`,
  );
  const now = clock!.now;
  const day = now.toISOString().slice(0, 10);
  const timezone = configured?.timezone ?? "UTC";
  const [calendar] = await tx.$queryRaw<Array<{ day: string; startsAt: Date }>>(
    Prisma.sql`SELECT
      to_char(${now}::timestamptz AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day,
      (date_trunc('day', ${now}::timestamptz AT TIME ZONE ${timezone})
        AT TIME ZONE ${timezone}) AS "startsAt"`,
  );
  const scope = {
    workspaceId: input.workspaceId,
    environment: "DRY_RUN" as const,
    executionRun: { deployment: { exchangeAccountId: input.exchangeAccountId } },
  };
  const settings = await tx.workspaceSettings.findUnique({
    where: { workspaceId: input.workspaceId },
  });
  const positions = await tx.position.findMany({
    where: { ...scope, status: "OPEN" },
    include: { strategyVersion: { select: { config: true } } },
  });
  const realized = await tx.trade.aggregate({ where: scope, _sum: { netPnl: true } });
  const strategyToday = await tx.trade.aggregate({
    where: { ...scope, closedAt: { gte: calendar!.startsAt, lte: now } },
    _sum: { netPnl: true },
  });
  const strategyDailyPnl = Number(strategyToday._sum.netPnl ?? 0);
  const strategyLossLimit =
    (input.policy.initialBalance * (configured?.maxDailyLossPercent ?? 0)) / 100;
  const today = await tx.trade.aggregate({
    where: { ...scope, closedAt: { gte: new Date(`${day}T00:00:00Z`), lte: now } },
    _sum: { netPnl: true },
  });
  let equity = input.policy.initialBalance + Number(realized._sum.netPnl ?? 0);
  let dailyPnl = Number(today._sum.netPnl ?? 0);
  let exposure = 0;
  let floatingGains = 0;
  let reservedStopRisk = 0;
  let stopRiskValid = true;
  let marketReady = true;
  if (
    positions.length > 0 &&
    (await tx.runtimeCursor.findFirst({
      where: {
        workspaceId: input.workspaceId,
        lastFailureCode: "RUNTIME_RECOVERY_REQUIRED",
        OR: positions.map((position) => ({
          executionRunId: position.executionRunId,
          symbol: position.symbol,
        })),
      },
      select: { executionRunId: true },
    }))
  )
    marketReady = false;
  for (const position of positions) {
    const quote = await tx.marketPriceEvent.findFirst({
      where: { symbol: position.symbol },
      orderBy: { id: "desc" },
    });
    const fresh =
      quote &&
      now.getTime() - quote.observedAt.getTime() <= input.policy.maxQuoteAgeMs &&
      quote.observedAt.getTime() <= now.getTime() + 1000;
    const price = Number(fresh ? quote.price : (position.markPrice ?? position.entryPrice));
    const quantity = Number(position.quantity);
    const pnl =
      (price - Number(position.entryPrice)) * quantity * (position.side === "BUY" ? 1 : -1);
    const costs = readRiskConfig(position.strategyVersion.config);
    const exitCosts =
      (price * quantity * ((costs?.takerFeeBps ?? 0) + (costs?.slippageBps ?? 0))) / 10_000;
    const protectiveStop =
      position.trailingPrice === null
        ? Number(position.stopPrice)
        : (position.side === "BUY" ? Math.max : Math.min)(
            Number(position.stopPrice),
            Number(position.trailingPrice),
          );
    const stopRisk = costs
      ? executionStopRisk({
          side: position.side === "BUY" ? "long" : "short",
          entryPrice: Number(position.entryPrice),
          stopPrice: protectiveStop,
          quantity,
          entryFee: Number(position.entryFee),
          takerFeeBps: costs.takerFeeBps,
          slippageBps: costs.slippageBps,
        })
      : null;
    if (stopRisk === null) stopRiskValid = false;
    else
      reservedStopRisk += Math.max(
        0,
        stopRisk - (Math.max(0, -pnl) + Number(position.entryFee) + exitCosts),
      );
    floatingGains += Math.max(0, pnl);
    equity += pnl - Number(position.entryFee) - exitCosts;
    // Unrealized winners cannot finance the daily loss budget of losing positions.
    dailyPnl += Math.min(0, pnl) - Number(position.entryFee) - exitCosts;
    exposure += price * quantity;
    if (
      !fresh ||
      !position.managedThroughAt ||
      !quote ||
      position.priceStreamId !== quote.streamId ||
      quote.observedAt.getTime() - position.managedThroughAt.getTime() > input.policy.maxQuoteAgeMs
    )
      marketReady = false;
  }
  const dailyLimit =
    (input.policy.initialBalance *
      Math.min(
        input.policy.maxDailyLossPercent,
        configured?.maxDailyLossPercent ?? 0,
        ...positions.map(
          (position) => readRiskConfig(position.strategyVersion.config)?.maxDailyLossPercent ?? 0,
        ),
      )) /
    100;
  const remainingStopRisk = remainingExecutionStopBudget({
    dailyLimit,
    dailyPnl,
    equityWithoutFloatingGains: equity - floatingGains,
    reservedStopRisk,
  });
  const key = { workspaceId: input.workspaceId, exchangeAccountId: input.exchangeAccountId, day };
  if (configured && (equity <= 0 || dailyPnl <= -dailyLimit)) {
    await tx.runtimeRiskDay.upsert({
      where: { workspaceId_exchangeAccountId_day: key },
      create: { ...key, haltReason: "daily-loss-limit" },
      update: {},
    });
  }
  const halt = await tx.runtimeRiskDay.findUnique({
    where: { workspaceId_exchangeAccountId_day: key },
  });
  const forceCloseReason: "kill-switch" | "daily-loss-limit" | null = settings?.runtimeKillSwitch
    ? "kill-switch"
    : halt
      ? "daily-loss-limit"
      : null;
  const reason =
    forceCloseReason ??
    (!configured || !stopRiskValid
      ? "INVALID_RISK_CONFIG"
      : !marketReady
        ? "MARKET_RECOVERY_REQUIRED"
        : strategyDailyPnl <= -strategyLossLimit
          ? "STRATEGY_DAILY_LOSS_LIMIT"
          : remainingStopRisk <= 0
            ? "MAX_ACCOUNT_STOP_RISK"
            : null);
  return {
    reason,
    forceCloseReason,
    equity,
    dailyPnl,
    dailyLimit,
    reservedStopRisk,
    remainingStopRisk,
    strategyDay: {
      timezone,
      day: calendar!.day,
      startsAt: calendar!.startsAt,
      realizedPnl: strategyDailyPnl,
      lossLimit: strategyLossLimit,
    },
    exposure,
    positions: positions.length,
    maximumExposure: (Math.max(0, equity) * input.policy.maxAccountExposurePercent) / 100,
    maximumPositions: Math.min(input.policy.maxOpenPositions, configured?.maxOpenPositions ?? 0),
    configured,
  };
}

export async function checkRuntimeEntry(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    exchangeAccountId: string;
    strategyConfig: Prisma.JsonValue;
    policy: RuntimeRiskPolicy;
    eventId: bigint | undefined;
    signalAvailableAt?: Date;
    position: {
      symbol: string;
      side: "BUY" | "SELL";
      quantity: string;
      entryPrice: string;
      stopPrice: string;
      entryFee: string;
      openedAt: Date;
    };
  },
) {
  const risk = await assessRuntimeRisk(tx, input);
  if (risk.reason) return risk.reason;
  const event =
    input.eventId === undefined
      ? null
      : await tx.marketPriceEvent.findUnique({ where: { id: input.eventId } });
  const now = Date.now();
  if (
    !event ||
    event.symbol !== input.position.symbol ||
    event.observedAt.getTime() !== input.position.openedAt.getTime() ||
    now - event.observedAt.getTime() > input.policy.maxQuoteAgeMs ||
    event.observedAt.getTime() > now + 1000
  )
    return "STALE_ENTRY_QUOTE";
  if (input.signalAvailableAt && event.receivedAt < input.signalAvailableAt)
    return "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY";
  const quantity = Number(input.position.quantity),
    entry = Number(input.position.entryPrice);
  const stop = Number(input.position.stopPrice);
  const fee = Number(input.position.entryFee);
  if (
    ![quantity, entry, stop, fee].every(Number.isFinite) ||
    quantity <= 0 ||
    entry <= 0 ||
    stop <= 0 ||
    fee < 0
  )
    return "INVALID_ENTRY_SIZE";
  const conflictingDirection = await tx.position.findFirst({
    where: {
      workspaceId: input.workspaceId,
      environment: "DRY_RUN",
      status: "OPEN",
      symbol: input.position.symbol,
      side: input.position.side === "BUY" ? "SELL" : "BUY",
      executionRun: { deployment: { exchangeAccountId: input.exchangeAccountId } },
    },
    select: { id: true },
  });
  if (conflictingDirection) return "PORTFOLIO_DIRECTION_CONFLICT";
  if (risk.positions >= risk.maximumPositions) return "MAX_OPEN_POSITIONS";
  if (risk.exposure + quantity * entry + fee > risk.maximumExposure + 1e-8)
    return "MAX_ACCOUNT_EXPOSURE";
  const costs = risk.configured!;
  const loss = executionStopRisk({
    side: input.position.side === "BUY" ? "long" : "short",
    entryPrice: entry,
    stopPrice: stop,
    quantity,
    entryFee: fee,
    takerFeeBps: costs.takerFeeBps,
    slippageBps: costs.slippageBps,
  });
  if (loss === null) return "INVALID_ENTRY_SIZE";
  if (loss > (Math.max(0, risk.equity) * costs.riskPerTradePercent) / 100 + 1e-8)
    return "MAX_TRADE_RISK";
  if (loss > risk.remainingStopRisk + 1e-8) return "MAX_ACCOUNT_STOP_RISK";
  return null;
}

export class RuntimeRiskRepository {
  public constructor(
    private readonly prisma: CryptoAnalPrismaClient,
    private readonly policy: RuntimeRiskPolicy = defaultRuntimeRiskPolicy,
  ) {}

  public assess(workspaceId: string, exchangeAccountId: string, strategyConfig: Prisma.JsonValue) {
    return this.prisma.$transaction(async (tx) => {
      await lockRuntimeRisk(tx, workspaceId);
      return assessRuntimeRisk(tx, {
        workspaceId,
        exchangeAccountId,
        strategyConfig,
        policy: this.policy,
      });
    });
  }

  public async getControl(workspaceId: string) {
    const row = await this.prisma.workspaceSettings.upsert({
      where: { workspaceId },
      create: { workspaceId },
      update: {},
    });
    return {
      enabled: row.runtimeKillSwitch,
      reason: row.runtimeKillReason,
      version: row.runtimeKillVersion,
    };
  }

  public async setControl(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    enabled: boolean;
    reason: string;
    expectedVersion: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await lockRuntimeRisk(tx, input.workspaceId);
      await tx.workspaceSettings.upsert({
        where: { workspaceId: input.workspaceId },
        create: { workspaceId: input.workspaceId },
        update: {},
      });
      const updated = await tx.workspaceSettings.updateMany({
        where: { workspaceId: input.workspaceId, runtimeKillVersion: input.expectedVersion },
        data: {
          runtimeKillSwitch: input.enabled,
          runtimeKillReason: input.reason,
          runtimeKillVersion: { increment: 1 },
        },
      });
      if (!updated.count) throw new RuntimeRiskControlConflictError();
      await tx.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          requestId: input.requestId,
          action: "runtime.kill-switch",
          resourceType: "workspace",
          resourceId: input.workspaceId,
          outcome: "COMPLETED",
          metadata: { enabled: input.enabled, reason: input.reason },
        },
      });
      return { enabled: input.enabled, reason: input.reason, version: input.expectedVersion + 1 };
    });
  }
}
export class RuntimeRiskControlConflictError extends Error {}
