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
  const now = input.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
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
  const today = await tx.trade.aggregate({
    where: { ...scope, closedAt: { gte: new Date(`${day}T00:00:00Z`) } },
    _sum: { netPnl: true },
  });
  let equity = input.policy.initialBalance + Number(realized._sum.netPnl ?? 0);
  let dailyPnl = Number(today._sum.netPnl ?? 0);
  let exposure = 0;
  let marketReady = true;
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
  const configured = readRiskConfig(input.strategyConfig);
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
    (!configured ? "INVALID_RISK_CONFIG" : !marketReady ? "MARKET_RECOVERY_REQUIRED" : null);
  return {
    reason,
    forceCloseReason,
    equity,
    dailyPnl,
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
  const stopFill =
    stop * (1 + ((input.position.side === "BUY" ? -1 : 1) * costs.slippageBps) / 10_000);
  const loss =
    Math.max(0, (entry - stopFill) * (input.position.side === "BUY" ? 1 : -1)) * quantity +
    fee +
    (stopFill * quantity * costs.takerFeeBps) / 10_000;
  if (loss > (Math.max(0, risk.equity) * costs.riskPerTradePercent) / 100 + 1e-8)
    return "MAX_TRADE_RISK";
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
