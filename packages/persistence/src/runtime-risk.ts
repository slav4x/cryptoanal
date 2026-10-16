import { readPinnedExecutionPolicy } from "./execution-policy-repository";
import { fundingCovers, readPositionFundingState } from "./funding-repository";
import { realizedCashPnl } from "./realized-cash";
import {
  assessExecutionAccount,
  executionAccountEntryFailure,
  executionTradingDay,
  readExecutionRiskConfig,
  defaultExecutionAccountSafety,
  type ExecutionAccountSafety,
  type ExecutionAccountPosition,
} from "../../application/src/execution-account";
import { Prisma } from "./generated/prisma/client";
import type { CryptoAnalPrismaClient } from "./client";
import { lockRuntimeScope, withRuntimeLockRetry } from "./runtime-lock";
import {
  captureInstrumentRules,
  instrumentRulesSelect,
  defaultInstrumentMaximumAgeMs,
} from "./instrument-rules";
import {
  readExecutionInstrumentRules,
  instrumentRuleFields,
  instrumentRulesFreshness,
  executionInstrumentSizeFailure,
  compareExecutionDecimals,
} from "../../application/src/execution-instrument";

export type RuntimeRiskPolicy = ExecutionAccountSafety;
export const defaultRuntimeRiskPolicy = defaultExecutionAccountSafety;
export async function lockRuntimeRisk(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  nonBlocking = false,
) {
  await lockRuntimeScope(tx, `risk:${workspaceId}`, nonBlocking);
}

export const readRiskConfig = readExecutionRiskConfig;

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
  const runs = await tx.executionRun.findMany({
    where: {
      workspaceId: input.workspaceId,
      status: "RUNNING",
      deployment: { exchangeAccountId: input.exchangeAccountId },
    },
    select: { executionPolicy: true },
  });
  const pinned = runs
    .map((r) => readPinnedExecutionPolicy(r.executionPolicy))
    .filter((p) => p !== null);
  if (pinned.length) {
    const policies = new Set(pinned.map((p) => JSON.stringify(p!.payload.settings.accountSafety)));
    if (policies.size !== 1) throw new Error("Conflicting account safety snapshots");
    input = { ...input, policy: pinned[0]!.payload.settings.accountSafety };
  }
  const configured = readRiskConfig(input.strategyConfig);
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(
    input.now
      ? Prisma.sql`SELECT ${input.now}::timestamptz AS now`
      : Prisma.sql`SELECT clock_timestamp() AS now`,
  );
  const now = clock!.now;
  const day = now.toISOString().slice(0, 10);
  const timezone = configured?.timezone ?? "UTC";
  const calendar = executionTradingDay(now, timezone);
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
  const strategyDailyPnl = Number(
    await realizedCashPnl(tx, {
      environment: "DRY_RUN",
      workspaceId: input.workspaceId,
      exchangeAccountId: input.exchangeAccountId,
      since: calendar!.startsAt,
      until: now,
    }),
  );
  const today = await realizedCashPnl(tx, {
    environment: "DRY_RUN",
    workspaceId: input.workspaceId,
    exchangeAccountId: input.exchangeAccountId,
    since: new Date(`${day}T00:00:00Z`),
    until: now,
  });
  let marketReady = true,
    fundingReady = true;
  const normalized: ExecutionAccountPosition[] = [];
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
      +now - +quote.observedAt <= input.policy.maxQuoteAgeMs &&
      +quote.observedAt <= +now + 1000;
    const quantity = Number(position.remainingQuantity ?? position.quantity);
    if (position.fundingPolicy) {
      const state = readPositionFundingState(position.fundingState),
        market = await tx.fundingMarketState.findUnique({ where: { symbol: position.symbol } });
      if (
        !state ||
        !fundingCovers(
          state,
          position.closedAt ?? position.managedThroughAt ?? position.openedAt,
        ) ||
        !market ||
        state.nextFundingAt !== market.nextFundingAt.toISOString() ||
        +now - +market.observedAt > 120000 ||
        +market.observedAt > +now + 1000
      )
        fundingReady = false;
    }
    normalized.push({
      symbol: position.symbol,
      side: position.side === "BUY" ? "long" : "short",
      entryPrice: Number(position.entryPrice),
      stopPrice: Number(position.stopPrice),
      trailingPrice: position.trailingPrice === null ? null : Number(position.trailingPrice),
      quantity,
      entryFee: Number(position.remainingEntryFee ?? position.entryFee),
      markPrice: Number(fresh ? quote.price : (position.markPrice ?? position.entryPrice)),
      realizedPnl: Number(position.realizedPnl),
      costs: readRiskConfig(position.strategyVersion.config),
      ...(position.instrumentRules
        ? { tickSize: readExecutionInstrumentRules(position.instrumentRules)!.tickSize }
        : {}),
    });
    if (quantity === 0 && position.closedAt) continue;
    if (
      !fresh ||
      !position.managedThroughAt ||
      !quote ||
      position.priceStreamId !== quote.streamId ||
      +quote.observedAt - +position.managedThroughAt > input.policy.maxQuoteAgeMs
    )
      marketReady = false;
  }
  const risk = assessExecutionAccount({
    policy: input.policy,
    config: input.strategyConfig,
    now,
    realizedNetPnl: Number(realized._sum.netPnl ?? 0),
    utcCashPnl: Number(today),
    strategyCashPnl: strategyDailyPnl,
    positions: normalized,
    marketReady,
    fundingReady,
    killSwitch: settings?.runtimeKillSwitch ?? false,
  });
  const key = { workspaceId: input.workspaceId, exchangeAccountId: input.exchangeAccountId, day };
  if (risk.shouldLatch) {
    await tx.runtimeRiskDay.upsert({
      where: { workspaceId_exchangeAccountId_day: key },
      create: { ...key, haltReason: "daily-loss-limit" },
      update: {},
    });
  }
  const halt = await tx.runtimeRiskDay.findUnique({
    where: { workspaceId_exchangeAccountId_day: key },
  });
  return halt && !settings?.runtimeKillSwitch
    ? { ...risk, reason: "daily-loss-limit", forceCloseReason: "daily-loss-limit" as const }
    : risk;
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
    partialFill?: boolean;
    position: {
      instrumentRules?: unknown;
      symbol: string;
      side: "BUY" | "SELL";
      quantity: string;
      entryPrice: string;
      stopPrice: string;
      takePrice: string;
      trailingPrice: string | null;
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
    now - event.observedAt.getTime() > risk.policy.maxQuoteAgeMs ||
    event.observedAt.getTime() > now + 1000
  )
    return "STALE_ENTRY_QUOTE";
  if (input.signalAvailableAt && event.receivedAt < input.signalAvailableAt)
    return "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY";
  await tx.$executeRaw`SELECT symbol FROM "MarketInstrument" WHERE symbol=${input.position.symbol} FOR SHARE`;
  const currentInstrument = await tx.marketInstrument.findUnique({
    where: { symbol: input.position.symbol },
    select: instrumentRulesSelect,
  });
  if (!currentInstrument?.enabled || currentInstrument.status !== "Trading")
    return "INSTRUMENT_UNAVAILABLE";
  const current = captureInstrumentRules(currentInstrument);
  if (current.reason) return current.reason;
  let rules;
  try {
    rules = readExecutionInstrumentRules(input.position.instrumentRules);
  } catch {
    return "INSTRUMENT_RULES_INVALID";
  }
  if (!rules || rules.symbol !== input.position.symbol) return "INSTRUMENT_RULES_MISSING";
  const freshness = instrumentRulesFreshness(rules, new Date(now), defaultInstrumentMaximumAgeMs);
  if (freshness) return freshness;
  if (
    instrumentRuleFields.some(
      (key) => compareExecutionDecimals(rules[key], current.rules![key]) !== 0,
    )
  )
    return "INSTRUMENT_RULES_CHANGED";
  const instrumentFailure = executionInstrumentSizeFailure(
    input.position,
    rules,
    input.partialFill,
  );
  if (instrumentFailure) return instrumentFailure;
  if (
    input.position.side === "BUY"
      ? Number(input.position.stopPrice) >= Number(input.position.entryPrice) ||
        Number(input.position.takePrice) <= Number(input.position.entryPrice)
      : Number(input.position.stopPrice) <= Number(input.position.entryPrice) ||
        Number(input.position.takePrice) >= Number(input.position.entryPrice)
  )
    return "INVALID_PROTECTION_LEVELS";
  const conflicting = await tx.position.findMany({
    where: {
      workspaceId: input.workspaceId,
      environment: "DRY_RUN",
      status: "OPEN",
      symbol: input.position.symbol,
      executionRun: { deployment: { exchangeAccountId: input.exchangeAccountId } },
    },
    select: { symbol: true, side: true, remainingQuantity: true, quantity: true },
  });
  return executionAccountEntryFailure(
    risk,
    {
      symbol: input.position.symbol,
      side: input.position.side === "BUY" ? "long" : "short",
      quantity: Number(input.position.quantity),
      entryPrice: Number(input.position.entryPrice),
      stopPrice: Number(input.position.stopPrice),
      entryFee: Number(input.position.entryFee),
      tickSize: rules.tickSize,
    },
    conflicting.map((p) => ({
      symbol: p.symbol,
      side: p.side === "BUY" ? "long" : "short",
      quantity: Number(p.remainingQuantity ?? p.quantity),
    })),
  );
}

export class RuntimeRiskRepository {
  public constructor(
    private readonly prisma: CryptoAnalPrismaClient,
    private readonly policy: RuntimeRiskPolicy = defaultRuntimeRiskPolicy,
    private readonly nonBlockingLocks = false,
  ) {}

  public assess(workspaceId: string, exchangeAccountId: string, strategyConfig: Prisma.JsonValue) {
    return withRuntimeLockRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          await lockRuntimeRisk(tx, workspaceId, this.nonBlockingLocks);
          return assessRuntimeRisk(tx, {
            workspaceId,
            exchangeAccountId,
            strategyConfig,
            policy: this.policy,
          });
        }),
      this.nonBlockingLocks,
    );
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
