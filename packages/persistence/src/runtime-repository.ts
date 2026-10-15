import { readPinnedExecutionPolicy } from "./execution-policy-repository";
import {
  readExecutionFundingPolicy,
  type ExecutionFundingPolicy,
} from "../../application/src/execution-funding";
import { initialPositionFundingState } from "./funding-repository";
import { latchLiquidityExit, advanceLiquidityExit } from "./liquidity-exit-repository";
import { runtimeEntryWaitSummary, type RuntimeEntryWaitReason } from "./runtime-entry-wait";
import { buildExitTriggerProof } from "./exit-trigger-proof";
import { instrumentRulesSelect } from "./instrument-rules";
import type { ExecutionInstrumentRules } from "../../application/src/execution-instrument";
import {
  entryLiquidityVersion,
  entryLiquidityBookFailure,
  entryPostOnlyCrosses,
  evaluateExecutionEntryOrder,
  readExecutionEntryOrder,
  type ExecutionEntryOrder,
  type ExecutionEntryLiquidityPolicy,
  type EntryExecutionMarker,
} from "../../application/src/execution-entry-liquidity";
import {
  executionLimitPrice,
  evaluateExecutionPriceExit,
  type ExecutionPosition,
  type ExecutionStrategyConfig,
} from "../../application/src/execution-engine";
import {
  defaultExecutionExitPolicy,
  isLiquidityExitPolicy,
  readExecutionExitPolicy,
  type ExecutionExitPolicy,
} from "../../application/src/execution-exit-policy";
import { executionInstrumentSizeFailure } from "../../application/src/execution-instrument";
import {
  defaultRuntimeMarketEntryPolicy,
  runtimeEntryExpiresAt,
  runtimeMarketEntryFailure,
  type RuntimeMarketEntryPolicy,
} from "./runtime-entry-policy";
import { runtimeSignalState, withRuntimeSignal } from "./runtime-signal";
import {
  ensurePositionTrace,
  closePositionTrace,
  defaultPositionTraceOptions,
  hashTracePayload,
  type PositionTraceOptions,
} from "./position-trace";
import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";
import {
  ensureDecisionContextSnapshot,
  type DecisionContextSnapshotPersistenceInput,
} from "./decision-repository";
import {
  checkRuntimeEntry,
  defaultRuntimeRiskPolicy,
  lockRuntimeRisk,
  type RuntimeRiskPolicy,
} from "./runtime-risk";

type RuntimeDeploymentStatus = "RUNNING" | "PAUSED";

export type RuntimeCyclePosition = {
  fundingPolicy?: ExecutionFundingPolicy;
  exitPolicy?: ExecutionExitPolicy;
  entryExecution?: EntryExecutionMarker;
  instrumentRules?: ExecutionInstrumentRules;
  symbol: string;
  side: "BUY" | "SELL";
  entryRegime: "BULL" | "BEAR" | "NEUTRAL" | "UNKNOWN";
  entrySession: "ASIA" | "EUROPE" | "US" | "OFF_HOURS" | "UNKNOWN";
  openedAt: Date;
  entryPrice: string;
  quantity: string;
  stopPrice: string;
  takePrice: string;
  trailingPrice: string | null;
  bestPrice: string;
  entryFee: string;
  entrySlippage: string;
};

export type RuntimeCycleSettlement = {
  exitPrice: string;
  grossPnl: string;
  netPnl: string;
  fees: string;
  slippage: string;
  exitReason: string;
  closedAt: Date;
};

type RuntimePositionAction =
  | { kind: "none" }
  | {
      kind: "update";
      positionId: string;
      markPrice: string;
      unrealizedPnl: string;
      bestPrice: string;
      stopPrice: string;
      trailingPrice: string | null;
    }
  | {
      kind: "open";
      position: RuntimeCyclePosition;
      markPrice: string;
      unrealizedPnl: string;
      immediateSettlement: RuntimeCycleSettlement | null;
    }
  | {
      kind: "close";
      positionId: string;
      settlement: RuntimeCycleSettlement;
    };

export type PersistRuntimeCycleInput = {
  entrySignalPrice?: number;
  indicatorState?: Prisma.InputJsonValue;
  expectedLastEvaluatedAt?: Date | null;
  signalAvailableAt?: Date;
  workspaceId: string;
  deploymentId: string;
  executionRunId: string;
  strategyVersionId: string;
  symbol: string;
  interval: string;
  candleAt: Date;
  expectedDeploymentStatus: RuntimeDeploymentStatus;
  expectedPositionId: string | null;
  expectedPositionVersion: number | null;
  entryPriceEventId?: bigint;
  pendingSignal: Prisma.InputJsonValue | null;
  maxOpenPositions: number;
  entryOrderType: "MARKET" | "LIMIT";
  contextSnapshot: DecisionContextSnapshotPersistenceInput;
  candidate: Prisma.InputJsonValue;
  providerVersion: string;
  decision: {
    action: "OPEN" | "CLOSE" | "HOLD" | "SKIP";
    reasonCode: string;
    summary: string;
    factors: Prisma.InputJsonValue;
  };
  positionAction: RuntimePositionAction;
};

export type PersistRuntimeQuoteInput = {
  processedEventCount?: number;
  traceInputs?: Prisma.InputJsonValue;
  profitProtection?: Prisma.InputJsonValue;
  indicatorState?: Prisma.InputJsonValue;
  signalCandleAt?: Date | null;
  decidedAt?: Date;
  recoveryEvidence?: Prisma.InputJsonValue;
  processedPrice: { eventId: bigint; streamId: string; throughAt: Date };
  workspaceId: string;
  deploymentId: string;
  executionRunId: string;
  strategyVersionId: string;
  positionId: string;
  expectedPositionVersion: number;
  symbol: string;
  quotePrice: string;
  quoteAt: Date;
  factors: Prisma.InputJsonValue;
  action:
    | {
        kind: "update";
        markPrice: string;
        unrealizedPnl: string;
        bestPrice: string;
        stopPrice: string;
        trailingPrice: string | null;
      }
    | {
        kind: "close";
        settlement: RuntimeCycleSettlement;
        protection?: Pick<RuntimeCyclePosition, "bestPrice" | "stopPrice" | "trailingPrice">;
      };
};

export type PersistRealtimeEntryInput = {
  entryOrderId?: string;
  expectedPendingPriceEventId?: bigint | null;
  signalAvailableAt?: Date;
  entryPriceEventId: bigint;
  workspaceId: string;
  deploymentId: string;
  executionRunId: string;
  strategyVersionId: string;
  symbol: string;
  expectedCandleAt: Date;
  quoteAt: Date;
  quotePrice: string;
  unrealizedPnl: string;
  maxOpenPositions: number;
  entryOrderType: "MARKET" | "LIMIT";
  position: RuntimeCyclePosition;
  factors: Prisma.InputJsonValue;
};

export class RuntimeStateConflictError extends Error {}
export class RuntimePositionNotFoundError extends Error {}
export class RuntimePositionStatusConflictError extends Error {}
export class RuntimeManualCloseNotAllowedError extends Error {}
export class RuntimeMarketPriceUnavailableError extends Error {}
export class RuntimeIdempotencyConflictError extends Error {}

export class RuntimeRepository {
  public constructor(
    private readonly prisma: CryptoAnalPrismaClient,
    private readonly riskPolicy: RuntimeRiskPolicy = defaultRuntimeRiskPolicy,
    private readonly marketEntryPolicy: RuntimeMarketEntryPolicy = defaultRuntimeMarketEntryPolicy,
    private readonly traceOptions: PositionTraceOptions = defaultPositionTraceOptions,
    private readonly exitPolicy: ExecutionExitPolicy = defaultExecutionExitPolicy,
    private readonly fundingPolicy?: ExecutionFundingPolicy,
  ) {
    if (fundingPolicy && !isLiquidityExitPolicy(exitPolicy))
      throw new Error("Funding requires liquidity exits");
  }

  public listActiveTargets(workspaceId: string) {
    return this.prisma.deployment.findMany({
      where: {
        workspaceId,
        environment: "DRY_RUN",
        status: { in: ["RUNNING", "PAUSED"] },
      },
      orderBy: { updatedAt: "asc" },
      select: {
        id: true,
        workspaceId: true,
        status: true,
        exchangeAccountId: true,
        exchangeConnection: { select: { status: true, revokedAt: true } },
        strategyVersion: { select: { id: true, config: true, configHash: true } },
        executionRuns: {
          where: { status: "RUNNING" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            context: true,
            contextHash: true,
            engineVersion: true,
            executionPolicy: true,
          },
        },
      },
    });
  }

  public async getIndicatorState(executionRunId: string, symbol: string) {
    const cursor = await this.prisma.runtimeCursor.findUnique({
      where: { executionRunId_symbol: { executionRunId, symbol } },
      select: { indicatorState: true },
    });
    return cursor?.indicatorState ?? null;
  }

  public async getCycleState(input: {
    workspaceId: string;
    exchangeAccountId: string;
    executionRunId: string;
    symbol: string;
    interval: string;
    lastCompleteCandleAt: Date;
    candleLimit: number;
  }) {
    const [cursor, position, instrument, candles] = await Promise.all([
      this.prisma.runtimeCursor.findUnique({
        where: {
          executionRunId_symbol: {
            executionRunId: input.executionRunId,
            symbol: input.symbol,
          },
        },
        select: {
          lastEvaluatedAt: true,
          pendingSignal: true,
          indicatorState: true,
          pendingPriceEventId: true,
        },
      }),
      this.prisma.position.findFirst({
        where: {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          symbol: input.symbol,
          status: "OPEN",
        },
        select: {
          id: true,
          instrumentRules: true,
          exitPolicy: true,
          executionPolicy: true,
          fundingPolicy: true,
          fundingState: true,
          fundingAccrued: true,
          fundingRemaining: true,
          remainingQuantity: true,
          remainingEntryFee: true,
          exitState: true,
          entryExecution: true,
          runtimeVersion: true,
          priceEventId: true,
          priceStreamId: true,
          managedThroughAt: true,
          symbol: true,
          side: true,
          openedAt: true,
          entryPrice: true,
          quantity: true,
          stopPrice: true,
          takePrice: true,
          trailingPrice: true,
          bestPrice: true,
          entryFee: true,
          entrySlippage: true,
          markPrice: true,
          unrealizedPnl: true,
          entryRegime: true,
          entrySession: true,
        },
      }),
      this.prisma.marketInstrument.findUnique({
        where: { symbol: input.symbol },
        select: instrumentRulesSelect,
      }),
      this.prisma.marketCandle.findMany({
        where: {
          symbol: input.symbol,
          interval: input.interval,
          isClosed: true,
          openTime: { lte: input.lastCompleteCandleAt },
        },
        orderBy: { openTime: "desc" },
        take: input.candleLimit,
        select: {
          symbol: true,
          openTime: true,
          open: true,
          high: true,
          low: true,
          close: true,
          turnover: true,
          finalizedAt: true,
          revisedAt: true,
        },
      }),
    ]);

    return { cursor, position, instrument, candles: candles.reverse() };
  }

  public async getDryRunEquity(
    workspaceId: string,
    exchangeAccountId: string,
    initialBalance: string,
  ) {
    const [trades, positions] = await this.prisma.$transaction(
      [
        this.prisma.trade.aggregate({
          where: {
            workspaceId,
            environment: "DRY_RUN",
            executionRun: { deployment: { exchangeAccountId } },
          },
          _sum: { netPnl: true },
        }),
        this.prisma.position.findMany({
          where: {
            workspaceId,
            environment: "DRY_RUN",
            status: "OPEN",
            executionRun: { deployment: { exchangeAccountId } },
          },
          select: {
            unrealizedPnl: true,
            entryFee: true,
            remainingEntryFee: true,
            realizedPnl: true,
          },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return positions
      .reduce(
        (equity, position) =>
          equity
            .add(position.realizedPnl)
            .add(position.unrealizedPnl)
            .sub(position.remainingEntryFee ?? position.entryFee),
        new Prisma.Decimal(initialBalance).add(trades._sum.netPnl ?? 0),
      )
      .toNumber();
  }

  public listRecentAccountTrades(workspaceId: string, exchangeAccountId: string, since: Date) {
    return this.prisma.trade.findMany({
      where: {
        workspaceId,
        environment: "DRY_RUN",
        executionRun: { deployment: { exchangeAccountId } },
        closedAt: { gte: since },
      },
      select: { closedAt: true, netPnl: true },
    });
  }

  public listRealtimePositions(workspaceId: string) {
    return this.prisma.position.findMany({
      where: {
        workspaceId,
        status: "OPEN",
        environment: "DRY_RUN",
        executionRun: {
          status: "RUNNING",
          deployment: { status: { in: ["RUNNING", "PAUSED"] } },
        },
      },
      orderBy: { openedAt: "asc" },
      select: {
        signalCandleAt: true,
        indicatorState: true,
        profitProtection: true,
        instrumentRules: true,
        exitPolicy: true,
        executionPolicy: true,
        fundingPolicy: true,
        fundingState: true,
        fundingAccrued: true,
        fundingRemaining: true,
        remainingQuantity: true,
        remainingEntryFee: true,
        exitState: true,
        entryExecution: true,
        id: true,
        runtimeVersion: true,
        priceEventId: true,
        priceStreamId: true,
        managedThroughAt: true,
        workspaceId: true,
        executionRunId: true,
        strategyVersionId: true,
        symbol: true,
        side: true,
        openedAt: true,
        entryPrice: true,
        markPrice: true,
        quantity: true,
        stopPrice: true,
        takePrice: true,
        trailingPrice: true,
        bestPrice: true,
        entryFee: true,
        entrySlippage: true,
        entryRegime: true,
        entrySession: true,
        strategyVersion: { select: { config: true, configHash: true } },
        executionRun: {
          select: {
            deployment: { select: { id: true, status: true, exchangeAccountId: true } },
          },
        },
      },
    });
  }

  public async persistRealtimeQuote(input: PersistRuntimeQuoteInput) {
    if (
      input.processedEventCount !== undefined &&
      (!Number.isInteger(input.processedEventCount) ||
        input.processedEventCount < 0 ||
        input.processedEventCount > 10_000)
    )
      throw new Error("Invalid trace event count");
    return this.prisma.$transaction(async (transaction) => {
      await lockRuntimeRisk(transaction, input.workspaceId);
      await transaction.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${`runtime:${input.executionRunId}`}))
      `);
      const position = await transaction.position.findFirst({
        where: {
          id: input.positionId,
          runtimeVersion: input.expectedPositionVersion,
          environment: "DRY_RUN",
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          strategyVersionId: input.strategyVersionId,
          symbol: input.symbol,
          status: "OPEN",
        },
        select: {
          id: true,
          profitProtection: true,
          instrumentRules: true,
          exitPolicy: true,
          executionPolicy: true,
          fundingPolicy: true,
          fundingState: true,
          fundingAccrued: true,
          fundingRemaining: true,
          remainingQuantity: true,
          remainingEntryFee: true,
          exitState: true,
          entryExecution: true,
          symbol: true,
          priceEventId: true,
          priceStreamId: true,
          managedThroughAt: true,
          markPrice: true,
          stopPrice: true,
          takePrice: true,
          trailingPrice: true,
          bestPrice: true,
          entrySlippage: true,
          signalCandleAt: true,
          indicatorState: true,
          side: true,
          quantity: true,
          entryPrice: true,
          entryFee: true,
          entryRegime: true,
          entrySession: true,
          openedAt: true,
          executionRun: {
            select: {
              status: true,
              deployment: { select: { id: true, status: true } },
            },
          },
          strategyVersion: { select: { config: true } },
        },
      });
      if (!position) return { applied: false, closed: false };
      if (
        position.executionRun.status !== "RUNNING" ||
        position.executionRun.deployment.id !== input.deploymentId ||
        (position.executionRun.deployment.status !== "RUNNING" &&
          position.executionRun.deployment.status !== "PAUSED")
      ) {
        return { applied: false, closed: false };
      }

      if (isLiquidityExitPolicy(position.exitPolicy) && input.action.kind === "close") {
        const full = await transaction.position.findUniqueOrThrow({ where: { id: position.id } });
        return latchLiquidityExit(transaction, full, input, {
          riskPolicy: this.riskPolicy,
          marketEntryPolicy: this.marketEntryPolicy,
          traceOptions: this.traceOptions,
          origin: (input.factors as { source?: string } | null)?.source ?? "journal",
        });
      }
      let exitProof: ReturnType<typeof buildExitTriggerProof> | undefined;
      if (
        position.exitPolicy &&
        input.action.kind === "close" &&
        ["stop-loss", "trailing-stop", "take-profit"].includes(input.action.settlement.exitReason)
      ) {
        const event = await transaction.marketPriceEvent.findUniqueOrThrow({
          where: { id: input.processedPrice.eventId },
        });
        if (
          (position.priceEventId !== null && event.id < position.priceEventId) ||
          event.symbol !== input.symbol ||
          event.streamId !== input.processedPrice.streamId ||
          !event.price.eq(input.quotePrice) ||
          +input.quoteAt !==
            Math.max(+event.observedAt, +(position.managedThroughAt ?? position.openedAt)) ||
          +input.quoteAt !== +input.processedPrice.throughAt ||
          +input.action.settlement.closedAt !== +input.quoteAt
        )
          throw new Error("Exit trigger does not match its durable price event");
        const protection = input.action.protection;
        const p: ExecutionPosition = {
          exitPolicy: readExecutionExitPolicy(position.exitPolicy)!,
          ...(position.instrumentRules
            ? { instrumentRules: position.instrumentRules as unknown as ExecutionInstrumentRules }
            : {}),
          symbol: position.symbol,
          side: position.side === "BUY" ? "long" : "short",
          entryRegime: position.entryRegime.toLowerCase() as ExecutionPosition["entryRegime"],
          entrySession: position.entrySession
            .toLowerCase()
            .replaceAll("_", "-") as ExecutionPosition["entrySession"],
          openedAt: position.openedAt,
          entryPrice: Number(position.entryPrice),
          quantity: Number(position.quantity),
          entryFee: Number(position.entryFee),
          entrySlippage: Number(position.entrySlippage),
          stopPrice: Number(protection?.stopPrice ?? position.stopPrice),
          takePrice: Number(position.takePrice),
          bestPrice: Number(protection?.bestPrice ?? position.bestPrice),
          trailingPrice: protection
            ? protection.trailingPrice === null
              ? null
              : Number(protection.trailingPrice)
            : (position.trailingPrice?.toNumber() ?? null),
        };
        exitProof = buildExitTriggerProof({
          position: p,
          event,
          settlement: input.action.settlement,
          config: position.strategyVersion.config as unknown as ExecutionStrategyConfig,
        });
      }

      const protection = input.profitProtection as { policyKey?: string } | undefined;
      const trace = await ensurePositionTrace(transaction, {
        positionId: position.id,
        workspaceId: input.workspaceId,
        strategyVersionId: input.strategyVersionId,
        position: {
          ...position,
          quantity: position.quantity.toFixed(),
          entryPrice: position.entryPrice.toFixed(),
          stopPrice: position.stopPrice.toFixed(),
          takePrice: position.takePrice.toFixed(),
          trailingPrice: position.trailingPrice?.toFixed() ?? null,
          bestPrice: position.bestPrice.toFixed(),
          entryFee: position.entryFee.toFixed(),
          entrySlippage: position.entrySlippage.toFixed(),
          ...(position.instrumentRules
            ? { instrumentRules: position.instrumentRules as unknown as ExecutionInstrumentRules }
            : {}),
        },
        eventId: position.priceEventId ?? input.processedPrice.eventId,
        streamId: position.priceStreamId,
        throughAt: position.managedThroughAt ?? position.openedAt,
        markPrice: (position.markPrice ?? position.entryPrice).toFixed(),
        signalCandleAt: position.signalCandleAt,
        indicatorState: position.indicatorState,
        profitProtectionState: position.profitProtection,
        fullFromEntry: false,
        riskPolicy: this.riskPolicy,
        marketEntryPolicy: this.marketEntryPolicy,
        options: this.traceOptions,
      });
      const previousProtection = position.profitProtection as { policyKey?: string } | null;
      const traceInputs = input.traceInputs as
        { signals?: unknown[]; recoveries?: unknown[]; policy?: unknown } | undefined;
      const policyHash =
        traceInputs && "policy" in traceInputs ? hashTracePayload(traceInputs.policy) : null;
      await transaction.positionExecutionTrace.update({
        where: { positionId: position.id },
        data: {
          eventCount:
            input.processedEventCount === undefined || position.priceEventId === null
              ? null
              : { increment: BigInt(input.processedEventCount) },
          ...(policyHash === null ? {} : { policyHash }),
        },
      });
      const recordTrace =
        (policyHash !== null && policyHash !== trace.policyHash) ||
        input.action.kind === "close" ||
        input.recoveryEvidence !== undefined ||
        (input.signalCandleAt !== undefined &&
          +input.signalCandleAt! !== +position.signalCandleAt!) ||
        (protection?.policyKey && protection.policyKey !== previousProtection?.policyKey) ||
        Boolean(traceInputs?.signals?.length || traceInputs?.recoveries?.length) ||
        (input.action.kind === "update" &&
          (input.action.stopPrice !== position.stopPrice.toFixed() ||
            input.action.trailingPrice !== (position.trailingPrice?.toFixed() ?? null)));
      if (recordTrace) {
        const payload = {
          quotePrice: input.quotePrice,
          quoteAt: input.quoteAt.toISOString(),
          processedPrice: {
            eventId: String(input.processedPrice.eventId),
            streamId: input.processedPrice.streamId,
            throughAt: input.processedPrice.throughAt.toISOString(),
          },
          decidedAt: (input.decidedAt ?? input.quoteAt).toISOString(),
          action:
            input.action.kind === "close"
              ? {
                  ...input.action,
                  settlement: {
                    ...input.action.settlement,
                    closedAt: input.action.settlement.closedAt.toISOString(),
                  },
                }
              : input.action,
          profitProtectionState: input.profitProtection ?? null,
          signalCandleAt:
            input.signalCandleAt?.toISOString() ?? position.signalCandleAt?.toISOString() ?? null,
          inputs: input.traceInputs ?? null,
          factors: input.factors,
          indicatorState: input.indicatorState ?? null,
        };
        await transaction.positionTraceRecord.create({
          data: {
            positionId: position.id,
            runtimeVersion: input.expectedPositionVersion + 1,
            eventId: input.processedPrice.eventId,
            kind: "journal",
            payload,
            payloadHash: hashTracePayload(payload),
          },
        });
      }
      if (protection?.policyKey && protection.policyKey !== previousProtection?.policyKey) {
        await transaction.auditEvent.create({
          data: {
            workspaceId: input.workspaceId,
            actorId: "worker",
            action: "position.profit-protection.activate",
            resourceType: "position",
            resourceId: position.id,
            outcome: "COMPLETED",
            requestId: `profit-protection:${position.id}:${input.processedPrice.eventId}`,
            metadata: {
              eventId: String(input.processedPrice.eventId),
              state: input.profitProtection!,
            },
          },
        });
      }
      if (input.recoveryEvidence) {
        await transaction.auditEvent.create({
          data: {
            workspaceId: input.workspaceId,
            actorId: "worker",
            action: "position.recover",
            resourceType: "position",
            resourceId: position.id,
            outcome: "COMPLETED",
            requestId: `runtime-recovery:${position.id}:${input.processedPrice.eventId}`,
            metadata: {
              executionRunId: input.executionRunId,
              eventId: String(input.processedPrice.eventId),
              recovery: input.recoveryEvidence,
            },
          },
        });
      }
      if (input.action.kind === "update") {
        await transaction.position.update({
          where: { id: position.id },
          data: {
            priceEventId: input.processedPrice.eventId,
            priceStreamId: input.processedPrice.streamId,
            managedThroughAt: input.processedPrice.throughAt,
            markPrice: input.action.markPrice,
            unrealizedPnl: input.action.unrealizedPnl,
            bestPrice: input.action.bestPrice,
            stopPrice: input.action.stopPrice,
            runtimeVersion: { increment: 1 },
            ...(input.signalCandleAt === undefined ? {} : { signalCandleAt: input.signalCandleAt }),
            ...(input.indicatorState === undefined ? {} : { indicatorState: input.indicatorState }),
            ...(input.profitProtection === undefined
              ? {}
              : { profitProtection: input.profitProtection }),
            trailingPrice: input.action.trailingPrice,
          },
        });
        await clearRecoveredCursor(transaction, input, false);
        return { applied: true, closed: false };
      }

      const correlationId = `runtime-quote:${position.id}:${input.quoteAt.toISOString()}`;
      const trade = await persistClosedPosition(
        transaction,
        {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          strategyVersionId: input.strategyVersionId,
          positionId: position.id,
          symbol: input.symbol,
          side: position.side,
          quantity: position.quantity.toFixed(),
          entryPrice: position.entryPrice.toFixed(),
          entryFee: position.entryFee.toFixed(),
          entryRegime: position.entryRegime,
          entrySession: position.entrySession,
          openedAt: position.openedAt,
          correlationId,
        },
        input.action.settlement,
        exitProof,
      );
      await transaction.decision.create({
        data: {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          strategyVersionId: input.strategyVersionId,
          positionId: position.id,
          tradeId: trade.id,
          symbol: input.symbol,
          action: "CLOSE",
          reasonCode: input.action.settlement.exitReason.toUpperCase().replaceAll("-", "_"),
          summary: `Позиция закрыта по realtime quote: ${input.action.settlement.exitReason}`,
          factors: exitProof
            ? {
                ...(input.factors &&
                typeof input.factors === "object" &&
                !Array.isArray(input.factors)
                  ? input.factors
                  : { details: input.factors }),
                exitTrigger: exitProof.payload,
              }
            : input.factors,
          marketSnapshotRef: `market-ticker:${input.symbol}:${input.quoteAt.toISOString()}`,
          correlationId,
          decidedAt: input.decidedAt ?? input.quoteAt,
        },
      });
      await transaction.position.update({
        where: { id: position.id },
        data: {
          priceEventId: input.processedPrice.eventId,
          priceStreamId: input.processedPrice.streamId,
          managedThroughAt: input.processedPrice.throughAt,
          runtimeVersion: { increment: 1 },
          ...input.action.protection,
          ...(input.signalCandleAt === undefined ? {} : { signalCandleAt: input.signalCandleAt }),
          ...(input.indicatorState === undefined ? {} : { indicatorState: input.indicatorState }),
          ...(input.profitProtection === undefined
            ? {}
            : { profitProtection: input.profitProtection }),
        },
      });
      await clearRecoveredCursor(transaction, input, true);
      await transaction.positionExecutionTrace.update({
        where: { positionId: position.id },
        data: { endEventId: input.processedPrice.eventId },
      });
      return { applied: true, closed: true };
    });
  }

  public async pendingExecutionOrder(input: {
    workspaceId: string;
    executionRunId: string;
    symbol: string;
    orderId: string;
  }) {
    const order = await this.prisma.order.findFirst({
      where: {
        id: input.orderId,
        workspaceId: input.workspaceId,
        executionRunId: input.executionRunId,
        symbol: input.symbol,
      },
      select: { id: true, status: true, execution: true },
    });
    return order ? { ...order, snapshot: storedEntryOrderSnapshot(order.execution) } : null;
  }

  public async submitRealtimeEntryOrder(input: {
    workspaceId: string;
    executionRunId: string;
    symbol: string;
    expectedCandleAt: Date;
    expectedPendingPriceEventId: bigint | null;
    entryPriceEventId: bigint;
    position: RuntimeCyclePosition;
    policy: ExecutionEntryLiquidityPolicy;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await lockRuntimeRisk(tx, input.workspaceId);
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${input.executionRunId}`}))`,
      );
      const cursor = await tx.runtimeCursor.findUnique({
        where: {
          executionRunId_symbol: { executionRunId: input.executionRunId, symbol: input.symbol },
        },
        include: {
          executionRun: {
            include: {
              strategyVersion: { select: { config: true } },
              deployment: {
                include: { exchangeConnection: { select: { status: true, revokedAt: true } } },
              },
            },
          },
        },
      });
      if (
        !cursor ||
        cursor.workspaceId !== input.workspaceId ||
        +cursor.lastEvaluatedAt! !== +input.expectedCandleAt ||
        cursor.pendingPriceEventId !== input.expectedPendingPriceEventId ||
        !cursor.pendingSignal ||
        (cursor.pendingPriceEventId !== null &&
          input.entryPriceEventId <= cursor.pendingPriceEventId)
      )
        return { applied: false };
      const pending = cursor.pendingSignal as Record<string, unknown>,
        run = cursor.executionRun,
        dep = run.deployment;
      if (
        pending.executionOrderId ||
        pending.mode !== "realtime" ||
        run.status !== "RUNNING" ||
        dep.status !== "RUNNING" ||
        dep.environment !== "DRY_RUN" ||
        dep.exchangeConnection?.status !== "ACTIVE" ||
        dep.exchangeConnection.revokedAt !== null
      )
        return { applied: false };
      const strategy = run.strategyVersion.config as unknown as ExecutionStrategyConfig;
      const pinned = readPinnedExecutionPolicy(run.executionPolicy);
      const marketEntryPolicy = pinned?.payload.settings.marketEntry ?? this.marketEntryPolicy;
      const fundingPolicy = pinned ? pinned.payload.settings.funding : this.fundingPolicy;
      const exitPolicy = pinned?.payload.settings.exit ?? this.exitPolicy;
      const liquidityPolicy = pinned?.payload.settings.entryLiquidity ?? input.policy;
      const event = await tx.marketPriceEvent.findUniqueOrThrow({
        where: { id: input.entryPriceEventId },
      });
      const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!
        .now;
      const expiresAt = runtimeEntryExpiresAt(
        strategy.entry.orderType === "market" ? "MARKET" : "LIMIT",
        new Date(String(pending.detectedAt)),
        new Date(String(pending.expiresAt)),
        marketEntryPolicy,
      );
      if (
        !Number.isFinite(+expiresAt) ||
        +now >= +expiresAt ||
        event.symbol !== input.symbol ||
        pending.side !== (input.position.side === "BUY" ? "long" : "short") ||
        event.observedAt < new Date(String(pending.detectedAt)) ||
        event.receivedAt < new Date(String(pending.availableAt))
      )
        return { applied: false };
      if (
        await tx.position.count({
          where: { executionRunId: run.id, symbol: input.symbol, status: "OPEN" },
        })
      )
        return { applied: false };
      const failure = await checkRuntimeEntry(tx, {
        workspaceId: input.workspaceId,
        exchangeAccountId: dep.exchangeAccountId,
        strategyConfig: run.strategyVersion.config,
        policy: this.riskPolicy,
        eventId: event.id,
        signalAvailableAt: new Date(String(pending.availableAt)),
        position: input.position,
      });
      if (failure) return { applied: false, riskFailure: failure };
      if (strategy.entry.orderType === "market") {
        const marketFailure = runtimeMarketEntryFailure(
          {
            detectedAt: new Date(String(pending.detectedAt)),
            expiresAt,
            signalPrice: Number(pending.signalPrice),
            now,
            quotePrice: Number(event.price),
            quoteAt: event.observedAt,
          },
          marketEntryPolicy,
        );
        if (marketFailure) return { applied: false, riskFailure: marketFailure };
      }
      const quote = { ...event, price: Number(event.price) };
      const bookFailure = entryLiquidityBookFailure(quote, liquidityPolicy);
      if (bookFailure) return { applied: false, riskFailure: bookFailure };
      const data = event.executionData as unknown as ExecutionEntryOrder["placementData"];
      const book = data[5]!;
      if (
        +now - book[4] > liquidityPolicy.maximumBookAgeMs ||
        +now - book[5] > liquidityPolicy.maximumBookAgeMs
      )
        return { applied: false, riskFailure: "ENTRY_BOOK_STALE" };
      if (fundingPolicy) {
        const market = await tx.fundingMarketState.findUnique({ where: { symbol: input.symbol } });
        if (
          !market ||
          +now - +market.observedAt > 120000 ||
          market.observedAt > new Date(+now + 1000) ||
          market.nextFundingAt <= now
        )
          return { applied: false, riskFailure: "FUNDING_DATA_UNAVAILABLE" };
      }
      const snapshot: ExecutionEntryOrder = {
        version: entryLiquidityVersion,
        ...(pinned ? { executionPolicy: pinned } : {}),
        ...(fundingPolicy
          ? {
              fundingPolicy: readExecutionFundingPolicy(fundingPolicy)!,
              fundingNextAt: (
                await tx.fundingMarketState.findUniqueOrThrow({ where: { symbol: input.symbol } })
              ).nextFundingAt.toISOString(),
            }
          : {}),
        exitPolicy: readExecutionExitPolicy(exitPolicy)!,
        symbol: input.symbol,
        side: pending.side as "long" | "short",
        timeInForce: strategy.entry.orderType === "market" ? "IOC" : "PostOnly",
        quantity: input.position.quantity,
        limitPrice:
          strategy.entry.orderType === "limit"
            ? String(
                executionLimitPrice(
                  {
                    side: pending.side as "long" | "short",
                    signalPrice: Number(pending.signalPrice),
                  },
                  strategy,
                  input.position.instrumentRules,
                ),
              )
            : null,
        signalPrice: String(pending.signalPrice),
        decisionPrice: event.price.toFixed(),
        submitReferencePrice:
          strategy.entry.orderType === "limit"
            ? input.position.entryPrice
            : input.position.side === "BUY"
              ? book[2]
              : book[0],
        submittedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        submitEventId: String(event.id),
        streamId: event.streamId,
        instrumentRules: input.position.instrumentRules!,
        policy: liquidityPolicy,
        placementData: data,
      };
      readExecutionEntryOrder(snapshot);
      const requested = { ...input.position, entryPrice: snapshot.submitReferencePrice };
      if (executionInstrumentSizeFailure(requested, snapshot.instrumentRules))
        return { applied: false, riskFailure: "INVALID_ENTRY_SIZE" };
      const cancelled = entryPostOnlyCrosses(snapshot);
      const order = await tx.order.create({
        data: {
          workspaceId: input.workspaceId,
          executionRunId: run.id,
          symbol: input.symbol,
          clientOrderId: `runtime-liquidity:${run.id}:${input.symbol}:${input.expectedCandleAt.toISOString()}`,
          side: input.position.side,
          type: strategy.entry.orderType === "market" ? "MARKET" : "LIMIT",
          status: cancelled ? "CANCELLED" : "OPEN",
          quantity: snapshot.quantity,
          expiresAt,
          price: snapshot.limitPrice,
          execution: {
            snapshot,
            hash: hashTracePayload(snapshot),
            ...(cancelled
              ? {
                  terminal: {
                    reason: "ENTRY_POST_ONLY_WOULD_TAKE",
                    cancelledAt: now.toISOString(),
                    cancelledQuantity: snapshot.quantity,
                  },
                }
              : {}),
          },
        },
      });
      const reason = cancelled ? "ENTRY_POST_ONLY_WOULD_TAKE" : "ENTRY_ORDER_SUBMITTED";
      const decision = await tx.decision.create({
        data: {
          workspaceId: input.workspaceId,
          executionRunId: run.id,
          strategyVersionId: run.strategyVersionId,
          symbol: input.symbol,
          action: cancelled ? "SKIP" : "HOLD",
          reasonCode: reason,
          summary: cancelled
            ? "PostOnly заявка отменена: немедленно забрала бы ликвидность"
            : "Заявка подготовлена; ожидается новое событие после отправки",
          factors: withRuntimeSignal(
            { orderId: order.id, entryExecution: snapshot },
            runtimeSignalState({
              executionRunId: run.id,
              symbol: input.symbol,
              candleAt: input.expectedCandleAt,
              status: cancelled ? "REJECTED" : "PENDING",
              observedAt: now,
              reasonCode: reason,
              pending: cursor.pendingSignal,
            }),
          ),
          correlationId: `runtime-order:${order.id}:submitted`,
          decidedAt: now,
        },
        select: { id: true },
      });
      await tx.runtimeCursor.update({
        where: { executionRunId_symbol: { executionRunId: run.id, symbol: input.symbol } },
        data: {
          pendingPriceEventId: event.id,
          pendingSignal: cancelled
            ? Prisma.DbNull
            : { ...(cursor.pendingSignal as Prisma.InputJsonObject), executionOrderId: order.id },
          lastDecisionId: decision.id,
        },
      });
      return { applied: true, orderId: order.id, cancelled };
    });
  }

  public async cancelInactiveEntryOrders(workspaceId: string) {
    const candidates = await this.prisma.order.findMany({
      where: {
        workspaceId,
        status: "OPEN",
        positionId: null,
        execution: { path: ["snapshot", "version"], equals: entryLiquidityVersion },
        executionRun: { environment: "DRY_RUN" },
        OR: [
          { expiresAt: { lte: new Date() } },
          { executionRun: { status: { not: "RUNNING" } } },
          { executionRun: { deployment: { status: { not: "RUNNING" } } } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: { id: true, executionRunId: true, symbol: true },
    });
    for (const candidate of candidates)
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${candidate.executionRunId}`}))`,
        );
        const order = await tx.order.findFirst({
          where: { id: candidate.id, status: "OPEN", positionId: null },
          include: {
            executionRun: {
              select: {
                status: true,
                strategyVersionId: true,
                deployment: { select: { status: true } },
              },
            },
          },
        });
        if (!order) return;
        const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!
          .now;
        const expired = order.expiresAt && order.expiresAt <= now;
        if (
          !expired &&
          order.executionRun.status === "RUNNING" &&
          order.executionRun.deployment.status === "RUNNING"
        )
          return;
        const reason = expired ? "ENTRY_SIGNAL_EXPIRED" : "ENTRY_DEPLOYMENT_NOT_RUNNING";
        await cancelPendingEntryOrder(
          tx,
          { executionOrderId: order.id },
          workspaceId,
          order.executionRunId,
          reason,
          now,
        );
        const cursor = await tx.runtimeCursor.findUnique({
          where: {
            executionRunId_symbol: { executionRunId: order.executionRunId, symbol: order.symbol },
          },
        });
        if (
          cursor?.pendingSignal &&
          (cursor.pendingSignal as { executionOrderId?: unknown }).executionOrderId === order.id
        ) {
          const decision = await tx.decision.create({
            data: {
              workspaceId,
              executionRunId: order.executionRunId,
              strategyVersionId: order.executionRun.strategyVersionId,
              symbol: order.symbol,
              action: "SKIP",
              reasonCode: reason,
              summary: `Заявка отменена: ${reason}`,
              factors: withRuntimeSignal(
                { orderId: order.id },
                runtimeSignalState({
                  executionRunId: order.executionRunId,
                  symbol: order.symbol,
                  candleAt: cursor.lastEvaluatedAt!,
                  status: expired ? "EXPIRED" : "REJECTED",
                  observedAt: now,
                  reasonCode: reason,
                  pending: cursor.pendingSignal,
                }),
              ),
              correlationId: `runtime-order:${order.id}:cancel`,
              decidedAt: now,
            },
            select: { id: true },
          });
          await tx.runtimeCursor.update({
            where: {
              executionRunId_symbol: { executionRunId: order.executionRunId, symbol: order.symbol },
            },
            data: { pendingSignal: Prisma.DbNull, lastDecisionId: decision.id },
          });
        }
      });
  }

  public async advanceLiquidityPosition(input: {
    workspaceId: string;
    executionRunId: string;
    positionId: string;
    expectedPositionVersion: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await lockRuntimeRisk(tx, input.workspaceId);
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${input.executionRunId}`}))`,
      );
      const p = await tx.position.findFirst({
        where: {
          id: input.positionId,
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          runtimeVersion: input.expectedPositionVersion,
          status: "OPEN",
          environment: "DRY_RUN",
        },
        include: { executionRun: { include: { deployment: true } } },
      });
      if (
        !p ||
        !isLiquidityExitPolicy(p.exitPolicy) ||
        !p.exitState ||
        p.executionRun.status !== "RUNNING" ||
        !["RUNNING", "PAUSED"].includes(p.executionRun.deployment.status)
      )
        return { applied: false, closed: false };
      return advanceLiquidityExit(tx, p, p.executionRun.deployment.exchangeAccountId);
    });
  }

  public async persistRealtimeEntry(input: PersistRealtimeEntryInput) {
    return this.prisma.$transaction(async (transaction) => {
      await lockRuntimeRisk(transaction, input.workspaceId);
      await transaction.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${`runtime:${input.executionRunId}`}))
      `);
      const [deployment, executionRun, cursor, currentPosition, instrument] = await Promise.all([
        transaction.deployment.findFirst({
          where: { id: input.deploymentId, workspaceId: input.workspaceId },
          select: {
            status: true,
            environment: true,
            exchangeAccountId: true,
            exchangeConnection: { select: { status: true, revokedAt: true } },
          },
        }),
        transaction.executionRun.findFirst({
          where: {
            id: input.executionRunId,
            workspaceId: input.workspaceId,
            deploymentId: input.deploymentId,
          },
          select: { status: true, strategyVersion: { select: { config: true } } },
        }),
        transaction.runtimeCursor.findUnique({
          where: {
            executionRunId_symbol: {
              executionRunId: input.executionRunId,
              symbol: input.symbol,
            },
          },
          select: {
            lastEvaluatedAt: true,
            pendingSignal: true,
            indicatorState: true,
            pendingPriceEventId: true,
          },
        }),
        transaction.position.findFirst({
          where: {
            workspaceId: input.workspaceId,
            executionRunId: input.executionRunId,
            symbol: input.symbol,
            status: "OPEN",
          },
          select: { id: true },
        }),
        transaction.marketInstrument.findUnique({
          where: { symbol: input.symbol },
          select: { status: true, enabled: true },
        }),
      ]);
      if (
        deployment?.status !== "RUNNING" ||
        deployment.environment !== "DRY_RUN" ||
        executionRun?.status !== "RUNNING" ||
        !cursor ||
        !cursor.pendingSignal ||
        cursor.lastEvaluatedAt?.getTime() !== input.expectedCandleAt.getTime() ||
        (input.expectedPendingPriceEventId !== undefined &&
          cursor.pendingPriceEventId !== input.expectedPendingPriceEventId) ||
        (cursor.pendingPriceEventId !== null &&
          input.entryPriceEventId <= cursor.pendingPriceEventId) ||
        currentPosition
      ) {
        return { applied: false, capacityReached: false };
      }
      if (
        deployment.exchangeConnection?.status !== "ACTIVE" ||
        deployment.exchangeConnection.revokedAt !== null
      )
        return {
          applied: false,
          capacityReached: false,
          waitingReason: "ENTRY_CONNECTION_UNAVAILABLE" as const,
        };
      if (!instrument?.enabled || instrument.status !== "Trading")
        return {
          applied: false,
          capacityReached: false,
          waitingReason: "INSTRUMENT_UNAVAILABLE" as const,
        };
      const pending = cursor.pendingSignal as Record<string, unknown>;
      if (
        !!input.position.entryExecution !== !!input.entryOrderId ||
        (!input.entryOrderId && !!input.position.exitPolicy) ||
        (!!pending.executionOrderId && pending.executionOrderId !== input.entryOrderId)
      )
        return {
          applied: false,
          capacityReached: false,
          riskFailure: "INVALID_ENTRY_EXECUTION_PROOF",
        };
      const configuredOrderType = (
        executionRun.strategyVersion.config as { entry?: { orderType?: string } }
      ).entry?.orderType;
      if (input.entryOrderType !== (configuredOrderType === "market" ? "MARKET" : "LIMIT"))
        return { applied: false, capacityReached: false, riskFailure: "INVALID_ENTRY_ORDER_TYPE" };
      const detectedAt =
        typeof pending.detectedAt === "string" ? Date.parse(pending.detectedAt) : NaN;
      const storedExpiresAt =
        typeof pending.expiresAt === "string" ? Date.parse(pending.expiresAt) : NaN;
      const expiresAt = +runtimeEntryExpiresAt(
        input.entryOrderType,
        new Date(detectedAt),
        new Date(storedExpiresAt),
        this.marketEntryPolicy,
      );
      const availableAt =
        typeof pending.availableAt === "string" ? Date.parse(pending.availableAt) : NaN;
      const entryEvent = await transaction.marketPriceEvent.findUniqueOrThrow({
        where: { id: input.entryPriceEventId },
      });
      const now = (
        await transaction.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      )[0]!.now;
      if (
        pending.mode !== "realtime" ||
        pending.side !== (input.position.side === "BUY" ? "long" : "short") ||
        ![detectedAt, expiresAt, availableAt].every(Number.isFinite) ||
        expiresAt <= detectedAt
      )
        return { applied: false, capacityReached: false, riskFailure: "INVALID_PENDING_SIGNAL" };
      if (+now >= expiresAt || +entryEvent.observedAt >= expiresAt)
        return { applied: false, capacityReached: false, riskFailure: "ENTRY_SIGNAL_EXPIRED" };
      if (input.entryOrderType === "MARKET") {
        const marketFailure = runtimeMarketEntryFailure(
          {
            detectedAt: new Date(detectedAt),
            expiresAt: new Date(expiresAt),
            signalPrice: typeof pending.signalPrice === "number" ? pending.signalPrice : NaN,
            quotePrice: Number(entryEvent.price),
            quoteAt: entryEvent.observedAt,
            now,
          },
          this.marketEntryPolicy,
        );
        if (marketFailure)
          return { applied: false, capacityReached: false, riskFailure: marketFailure };
      }
      if (+entryEvent.observedAt < detectedAt || +entryEvent.receivedAt < availableAt)
        return {
          applied: false,
          capacityReached: false,
          riskFailure: "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY",
        };
      let entryProof: {
        orderId: string;
        snapshot: ExecutionEntryOrder;
        result: Extract<ReturnType<typeof evaluateExecutionEntryOrder>, { kind: "fill" }>;
        consumedQuantity: string;
        publicConsumedQuantity: string;
      } | null = null;
      if (input.entryOrderId) {
        const order = await transaction.order.findFirst({
          where: {
            id: input.entryOrderId,
            workspaceId: input.workspaceId,
            executionRunId: input.executionRunId,
            symbol: input.symbol,
            status: "OPEN",
            positionId: null,
          },
        });
        if (!order || pending.executionOrderId !== order.id)
          return { applied: false, capacityReached: false, riskFailure: "ENTRY_ORDER_UNAVAILABLE" };
        const snapshot = storedEntryOrderSnapshot(order.execution);
        if (
          +now >= Date.parse(snapshot.expiresAt) ||
          +now - +entryEvent.receivedAt > snapshot.policy.maximumBookAgeMs
        )
          return {
            applied: false,
            capacityReached: false,
            riskFailure: "ENTRY_ORDER_EXPIRED_OR_STALE",
          };
        const quote = { ...entryEvent, price: Number(entryEvent.price) };
        const offered = evaluateExecutionEntryOrder(snapshot, quote);
        if (offered.kind !== "fill")
          return { applied: false, capacityReached: false, riskFailure: offered.reason };
        const latest = await transaction.marketPriceEvent.findFirst({
          where: { symbol: input.symbol },
          orderBy: { id: "desc" },
          select: { streamId: true },
        });
        if (latest?.streamId !== entryEvent.streamId)
          return {
            applied: false,
            capacityReached: false,
            riskFailure: "ENTRY_ORDER_STREAM_CHANGED",
          };
        const sources = await transaction.fill.findMany({
          where: {
            workspaceId: input.workspaceId,
            order: {
              executionRun: {
                environment: "DRY_RUN",
                deployment: { exchangeAccountId: deployment.exchangeAccountId },
              },
            },
            execution: { path: ["payload", "sourceKey"], equals: offered.sourceKey },
          },
          select: { quantity: true },
        });
        const consumed = sources.reduce(
          (sum, fill) => sum.add(fill.quantity),
          new Prisma.Decimal(0),
        );
        let publicConsumed = new Prisma.Decimal(0);
        if (snapshot.timeInForce === "IOC") {
          const book = (
            entryEvent.executionData as unknown as ExecutionEntryOrder["placementData"]
          )[5]!;
          const [history] = await transaction.$queryRaw<Array<{ quantity: string }>>(Prisma.sql`
            SELECT coalesce(sum(("executionData"->>1)::numeric),0)::text AS quantity FROM "MarketPriceEvent"
            WHERE symbol=${input.symbol} AND "streamId"=${entryEvent.streamId}
            AND id>${BigInt(snapshot.submitEventId)} AND id<${entryEvent.id}
            AND "observedAt">=${new Date(book[4])} AND "receivedAt"<=${entryEvent.receivedAt}
            AND "executionData"->5->>6=${book[6]}
            AND "executionData"->>2=${snapshot.side === "long" ? "Buy" : "Sell"}
            AND coalesce("executionData"->>3,'false')<>'true' AND coalesce("executionData"->>4,'false')<>'true'
            AND ${snapshot.side === "long" ? Prisma.sql`price>=${book[2]}::numeric` : Prisma.sql`price<=${book[0]}::numeric`}
          `);
          publicConsumed = new Prisma.Decimal(history!.quantity);
        }
        const result = evaluateExecutionEntryOrder(
          snapshot,
          quote,
          consumed.add(publicConsumed).toFixed(),
        );
        const marker = input.position.entryExecution;
        if (
          result.kind !== "fill" ||
          !marker ||
          marker.version !== entryLiquidityVersion ||
          marker.orderId !== order.id ||
          marker.requestedQuantity !== snapshot.quantity ||
          !order.quantity.eq(snapshot.quantity) ||
          order.side !== input.position.side ||
          order.type !== input.entryOrderType ||
          (snapshot.timeInForce === "IOC") !== (input.entryOrderType === "MARKET") ||
          !new Prisma.Decimal(input.position.quantity).gt(0) ||
          new Prisma.Decimal(input.position.quantity).gt(
            result.kind === "fill" ? result.quantity : 0,
          ) ||
          !new Prisma.Decimal(input.position.entryPrice).eq(
            result.kind === "fill" ? result.price : 0,
          ) ||
          hashTracePayload(input.position.fundingPolicy ?? null) !==
            hashTracePayload(snapshot.fundingPolicy ?? null) ||
          hashTracePayload(input.position.exitPolicy ?? null) !==
            hashTracePayload(snapshot.exitPolicy ?? null) ||
          hashTracePayload(input.position.instrumentRules) !==
            hashTracePayload(snapshot.instrumentRules) ||
          +input.position.openedAt !== +entryEvent.observedAt ||
          !entryEvent.price.eq(input.quotePrice)
        )
          return {
            applied: false,
            capacityReached: false,
            riskFailure: result.kind === "fill" ? "INVALID_ENTRY_EXECUTION_PROOF" : result.reason,
          };
        const costs = (executionRun.strategyVersion.config as unknown as ExecutionStrategyConfig)
          .costs;
        const fee = new Prisma.Decimal(result.price)
          .mul(input.position.quantity)
          .mul(result.role === "maker" ? costs.makerFeeBps : costs.takerFeeBps)
          .div(10000)
          .toDecimalPlaces(18);
        if (!fee.eq(new Prisma.Decimal(input.position.entryFee).toDecimalPlaces(18)))
          return { applied: false, capacityReached: false, riskFailure: "INVALID_ENTRY_FILL_FEE" };
        input.position = {
          ...input.position,
          entryFee: fee.toFixed(),
          entrySlippage: new Prisma.Decimal(result.price)
            .minus(entryEvent.price)
            .abs()
            .mul(input.position.quantity)
            .toDecimalPlaces(18)
            .toFixed(),
        };
        entryProof = {
          orderId: order.id,
          snapshot,
          result,
          consumedQuantity: consumed.toFixed(),
          publicConsumedQuantity: publicConsumed.toFixed(),
        };
      }
      const riskFailure = await checkRuntimeEntry(transaction, {
        workspaceId: input.workspaceId,
        exchangeAccountId: deployment.exchangeAccountId,
        strategyConfig: executionRun.strategyVersion.config,
        policy: this.riskPolicy,
        eventId: input.entryPriceEventId,
        ...(entryProof ? { partialFill: true } : {}),
        ...(input.signalAvailableAt ? { signalAvailableAt: input.signalAvailableAt } : {}),
        position: input.position,
      });
      if (riskFailure) return { applied: false, capacityReached: false, riskFailure };

      const openPositions = await transaction.position.count({
        where: {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          status: "OPEN",
        },
      });
      if (openPositions >= input.maxOpenPositions) {
        return { applied: false, capacityReached: true };
      }

      const fillAt = (
        await transaction.$queryRaw<Array<{ fillAt: Date }>>`SELECT clock_timestamp() AS "fillAt"`
      )[0]!.fillAt;
      if (+fillAt >= expiresAt)
        return { applied: false, capacityReached: false, riskFailure: "ENTRY_SIGNAL_EXPIRED" };
      const correlationId = `runtime-entry:${input.executionRunId}:${input.symbol}:${input.quoteAt.toISOString()}`;
      if (input.position.fundingPolicy && !entryProof)
        return {
          applied: false,
          capacityReached: false,
          riskFailure: "FUNDING_ENTRY_PROOF_REQUIRED",
        };
      const fundingMarket = input.position.fundingPolicy
        ? await transaction.fundingMarketState.findUnique({ where: { symbol: input.symbol } })
        : null;
      if (
        input.position.fundingPolicy &&
        (!fundingMarket || +now - +fundingMarket.observedAt > 120000)
      )
        return { applied: false, capacityReached: false, riskFailure: "FUNDING_DATA_UNAVAILABLE" };
      const position = await transaction.position.create({
        data: {
          workspaceId: input.workspaceId,
          ...(entryProof?.snapshot.executionPolicy
            ? {
                executionPolicy: entryProof.snapshot
                  .executionPolicy as unknown as Prisma.InputJsonValue,
              }
            : {}),
          ...(input.position.fundingPolicy
            ? {
                fundingPolicy: input.position.fundingPolicy,
                fundingState: initialPositionFundingState(
                  input.position.openedAt,
                  new Date(entryProof!.snapshot.fundingNextAt!),
                ),
                fundingAccrued: "0",
                fundingRemaining: "0",
              }
            : {}),
          priceEventId: entryEvent.id,
          priceStreamId: entryEvent.streamId,
          managedThroughAt: entryEvent.observedAt,
          signalCandleAt: input.expectedCandleAt,
          ...(cursor?.indicatorState == null
            ? {}
            : { indicatorState: cursor.indicatorState as Prisma.InputJsonValue }),
          executionRunId: input.executionRunId,
          strategyVersionId: input.strategyVersionId,
          symbol: input.symbol,
          environment: "DRY_RUN",
          side: input.position.side,
          ...(input.position.exitPolicy
            ? {
                exitPolicy: input.position.exitPolicy,
                ...(isLiquidityExitPolicy(input.position.exitPolicy)
                  ? {
                      remainingQuantity: input.position.quantity,
                      remainingEntryFee: input.position.entryFee,
                    }
                  : {}),
              }
            : {}),
          ...(input.position.entryExecution
            ? { entryExecution: input.position.entryExecution }
            : {}),
          entryRegime: input.position.entryRegime,
          entrySession: input.position.entrySession,
          status: "OPEN",
          quantity: input.position.quantity,
          entryPrice: input.position.entryPrice,
          stopPrice: input.position.stopPrice,
          takePrice: input.position.takePrice,
          trailingPrice: input.position.trailingPrice,
          bestPrice: input.position.bestPrice,
          entryFee: input.position.entryFee,
          entrySlippage: input.position.entrySlippage,
          ...(input.position.instrumentRules
            ? { instrumentRules: input.position.instrumentRules }
            : {}),
          markPrice: input.quotePrice,
          unrealizedPnl: input.unrealizedPnl,
          openedAt: input.position.openedAt,
        },
        select: { id: true },
      });
      if (entryProof) {
        const cancelled = new Prisma.Decimal(entryProof.snapshot.quantity).minus(
          input.position.quantity,
        );
        const terminal = {
          reason: cancelled.gt(0) ? "ENTRY_REMAINDER_CANCELLED_AFTER_FILL" : "ENTRY_ORDER_FILLED",
          filledQuantity: input.position.quantity,
          cancelledQuantity: cancelled.toFixed(),
          filledAt: fillAt.toISOString(),
          fillEventId: String(entryEvent.id),
        };
        await transaction.order.update({
          where: { id: entryProof.orderId },
          data: {
            positionId: position.id,
            status: cancelled.gt(0) ? "CANCELLED" : "FILLED",
            execution: {
              snapshot: entryProof.snapshot,
              hash: hashTracePayload(entryProof.snapshot),
              terminal,
            },
          },
        });
        const payload = {
          version: entryLiquidityVersion,
          source: "dry-run-public-liquidity-model",
          role: entryProof.result.role,
          sourceKey: entryProof.result.sourceKey,
          sourceCapacity: entryProof.result.sourceCapacity,
          consumedQuantity: entryProof.consumedQuantity,
          publicConsumedQuantity: entryProof.publicConsumedQuantity,
          orderId: entryProof.orderId,
          event: {
            id: String(entryEvent.id),
            symbol: entryEvent.symbol,
            price: entryEvent.price.toFixed(),
            streamId: entryEvent.streamId,
            observedAt: entryEvent.observedAt.toISOString(),
            receivedAt: entryEvent.receivedAt.toISOString(),
            executionData: entryEvent.executionData,
          },
          signalPrice: entryProof.snapshot.signalPrice,
          decisionPrice: entryProof.snapshot.decisionPrice,
          submitReferencePrice: entryProof.snapshot.submitReferencePrice,
          decisionToFillBps: new Prisma.Decimal(input.position.entryPrice)
            .minus(entryProof.snapshot.decisionPrice)
            .mul(input.position.side === "BUY" ? 10000 : -10000)
            .div(entryProof.snapshot.decisionPrice)
            .toDecimalPlaces(18)
            .toFixed(),
        };
        await transaction.fill.create({
          data: {
            workspaceId: input.workspaceId,
            orderId: entryProof.orderId,
            quantity: input.position.quantity,
            price: input.position.entryPrice,
            fee: input.position.entryFee,
            feeAsset: "USDT",
            filledAt: input.position.openedAt,
            execution: { payload, hash: hashTracePayload(payload) },
          },
        });
      } else
        await createFilledOrder(transaction, {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          positionId: position.id,
          symbol: input.symbol,
          clientOrderId: `${correlationId}:entry`,
          side: input.position.side,
          type: input.entryOrderType,
          quantity: input.position.quantity,
          price: input.position.entryPrice,
          fee: input.position.entryFee,
          filledAt: input.position.openedAt,
        });
      await ensurePositionTrace(transaction, {
        positionId: position.id,
        workspaceId: input.workspaceId,
        strategyVersionId: input.strategyVersionId,
        position: input.position,
        eventId: entryEvent.id,
        streamId: entryEvent.streamId,
        throughAt: entryEvent.observedAt,
        markPrice: input.quotePrice,
        signalCandleAt: input.expectedCandleAt,
        indicatorState: cursor.indicatorState,
        profitProtectionState: null,
        fullFromEntry: true,
        riskPolicy: this.riskPolicy,
        marketEntryPolicy: this.marketEntryPolicy,
        options: this.traceOptions,
      });
      const entryFactors: Prisma.InputJsonValue = entryProof
        ? {
            ...(input.factors && typeof input.factors === "object" && !Array.isArray(input.factors)
              ? input.factors
              : { details: input.factors }),
            entryExecution: {
              model: entryLiquidityVersion,
              orderId: entryProof.orderId,
              role: entryProof.result.role,
              requestedQuantity: entryProof.snapshot.quantity,
              filledQuantity: input.position.quantity,
              cancelledQuantity: new Prisma.Decimal(entryProof.snapshot.quantity)
                .minus(input.position.quantity)
                .toFixed(),
              fillPrice: input.position.entryPrice,
              decisionPrice: entryProof.snapshot.decisionPrice,
              submittedAt: entryProof.snapshot.submittedAt,
            },
          }
        : input.factors;
      const decision = await transaction.decision.create({
        data: {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          strategyVersionId: input.strategyVersionId,
          positionId: position.id,
          symbol: input.symbol,
          action: "OPEN",
          reasonCode: "ENTRY_SIGNAL_FILLED_REALTIME",
          summary: entryProof
            ? `Исполнено ${input.position.quantity} из ${entryProof.snapshot.quantity}; неисполненный остаток отменён`
            : `Сигнал исполнен по realtime quote: ${input.position.side === "BUY" ? "long" : "short"}`,
          factors: withRuntimeSignal(
            input.entryOrderType === "MARKET"
              ? {
                  ...(entryFactors &&
                  typeof entryFactors === "object" &&
                  !Array.isArray(entryFactors)
                    ? entryFactors
                    : { details: entryFactors }),
                  marketEntryPolicy: this.marketEntryPolicy,
                }
              : entryFactors,
            runtimeSignalState({
              executionRunId: input.executionRunId,
              symbol: input.symbol,
              candleAt: input.expectedCandleAt,
              status: "FILLED",
              observedAt: fillAt,
              reasonCode: "ENTRY_SIGNAL_FILLED_REALTIME",
              pending: cursor.pendingSignal,
            }),
          ),
          marketSnapshotRef: `market-ticker:${input.symbol}:${input.quoteAt.toISOString()}`,
          correlationId,
          decidedAt: fillAt,
        },
        select: { id: true },
      });
      await transaction.runtimeCursor.update({
        where: {
          executionRunId_symbol: {
            executionRunId: input.executionRunId,
            symbol: input.symbol,
          },
        },
        data: {
          pendingSignal: Prisma.DbNull,
          pendingPriceEventId: entryEvent.id,
          lastDecisionId: decision.id,
        },
      });
      if (entryProof) {
        const p = input.position;
        const executionPosition: ExecutionPosition = {
          ...p,
          side: p.side === "BUY" ? "long" : "short",
          entryRegime: p.entryRegime.toLowerCase() as ExecutionPosition["entryRegime"],
          entrySession: p.entrySession
            .toLowerCase()
            .replaceAll("_", "-") as ExecutionPosition["entrySession"],
          entryPrice: Number(p.entryPrice),
          quantity: Number(p.quantity),
          stopPrice: Number(p.stopPrice),
          takePrice: Number(p.takePrice),
          trailingPrice: p.trailingPrice === null ? null : Number(p.trailingPrice),
          bestPrice: Number(p.bestPrice),
          entryFee: Number(p.entryFee),
          entrySlippage: Number(p.entrySlippage),
        };
        const immediate = evaluateExecutionPriceExit(
          executionPosition,
          {
            symbol: input.symbol,
            price: Number(entryEvent.price),
            observedAt: entryEvent.observedAt,
            source: "LastPrice",
          },
          executionRun.strategyVersion.config as unknown as ExecutionStrategyConfig,
        );
        if (immediate) {
          const settlement = {
            exitPrice: String(immediate.exitPrice),
            grossPnl: String(immediate.grossPnl),
            netPnl: String(immediate.netPnl),
            fees: String(immediate.fees),
            slippage: String(immediate.slippage),
            exitReason: immediate.exitReason,
            closedAt: new Date(immediate.closedAt),
          };
          if (isLiquidityExitPolicy(p.exitPolicy)) {
            const full = await transaction.position.findUniqueOrThrow({
              where: { id: position.id },
            });
            await latchLiquidityExit(
              transaction,
              full,
              {
                workspaceId: input.workspaceId,
                deploymentId: input.deploymentId,
                executionRunId: input.executionRunId,
                strategyVersionId: input.strategyVersionId,
                positionId: position.id,
                expectedPositionVersion: full.runtimeVersion,
                symbol: input.symbol,
                quotePrice: entryEvent.price.toFixed(),
                quoteAt: entryEvent.observedAt,
                processedPrice: {
                  eventId: entryEvent.id,
                  streamId: entryEvent.streamId,
                  throughAt: entryEvent.observedAt,
                },
                factors: { source: "entry-fill-protection" },
                action: { kind: "close", settlement },
                processedEventCount: 0,
              },
              {
                riskPolicy: this.riskPolicy,
                marketEntryPolicy: this.marketEntryPolicy,
                traceOptions: this.traceOptions,
                origin: "entry",
              },
            );
            return { applied: true, capacityReached: false };
          }
          const trade = await persistClosedPosition(
            transaction,
            {
              ...p,
              workspaceId: input.workspaceId,
              executionRunId: input.executionRunId,
              strategyVersionId: input.strategyVersionId,
              positionId: position.id,
              correlationId,
            },
            settlement,
            executionPosition.exitPolicy
              ? buildExitTriggerProof({
                  position: executionPosition,
                  event: entryEvent,
                  settlement,
                  config: executionRun.strategyVersion.config as unknown as ExecutionStrategyConfig,
                })
              : undefined,
          );
          await transaction.decision.create({
            data: {
              workspaceId: input.workspaceId,
              executionRunId: input.executionRunId,
              strategyVersionId: input.strategyVersionId,
              positionId: position.id,
              tradeId: trade.id,
              symbol: input.symbol,
              action: "CLOSE",
              reasonCode: immediate.exitReason,
              summary: "Защита сработала на событии частичного/полного входа",
              factors: { source: "entry-fill-protection", entryEventId: String(entryEvent.id) },
              correlationId: `${correlationId}:immediate-exit`,
              decidedAt: fillAt,
            },
          });
        }
      }
      return { applied: true, capacityReached: false };
    });
  }

  public async advancePendingEntry(input: {
    workspaceId: string;
    executionRunId: string;
    symbol: string;
    expectedCandleAt: Date;
    expectedPendingPriceEventId: bigint | null;
    throughEventId: bigint | null;
    rejectionReason?: string;
    waitingReason?: RuntimeEntryWaitReason;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${input.executionRunId}`}))`,
      );
      const cursor = await tx.runtimeCursor.findUnique({
        where: {
          executionRunId_symbol: { executionRunId: input.executionRunId, symbol: input.symbol },
        },
        select: {
          workspaceId: true,
          pendingSignal: true,
          lastEvaluatedAt: true,
          pendingPriceEventId: true,
          lastDecisionId: true,
          instrument: { select: instrumentRulesSelect },
          executionRun: {
            select: {
              id: true,
              strategyVersionId: true,
              strategyVersion: { select: { config: true } },
              status: true,
              deployment: {
                select: {
                  status: true,
                  environment: true,
                  exchangeConnection: { select: { status: true, revokedAt: true } },
                },
              },
            },
          },
        },
      });
      if (
        !cursor ||
        cursor.workspaceId !== input.workspaceId ||
        !cursor.pendingSignal ||
        +cursor.lastEvaluatedAt! !== +input.expectedCandleAt ||
        cursor.pendingPriceEventId !== input.expectedPendingPriceEventId
      )
        return false;
      const run = cursor.executionRun,
        deployment = run.deployment;
      if (
        run.status !== "RUNNING" ||
        deployment.status !== "RUNNING" ||
        deployment.environment !== "DRY_RUN"
      )
        return false;
      const gateReason: RuntimeEntryWaitReason | null =
        deployment.exchangeConnection?.status !== "ACTIVE" ||
        deployment.exchangeConnection.revokedAt !== null
          ? "ENTRY_CONNECTION_UNAVAILABLE"
          : !cursor.instrument.enabled || cursor.instrument.status !== "Trading"
            ? "INSTRUMENT_UNAVAILABLE"
            : null;
      const throughEventId = gateReason ? cursor.pendingPriceEventId : input.throughEventId;
      if (
        throughEventId !== null &&
        (cursor.pendingPriceEventId === null || throughEventId > cursor.pendingPriceEventId)
      ) {
        const event = await tx.marketPriceEvent.findUnique({ where: { id: throughEventId } });
        if (!event || event.symbol !== input.symbol) return false;
      } else if (throughEventId !== cursor.pendingPriceEventId) return false;
      const pending = cursor.pendingSignal as Record<string, unknown>;
      const configuredOrderType = (run.strategyVersion.config as { entry?: { orderType?: string } })
        .entry?.orderType;
      const expiresAt = +runtimeEntryExpiresAt(
        configuredOrderType === "market" ? "MARKET" : "LIMIT",
        new Date(typeof pending.detectedAt === "string" ? pending.detectedAt : NaN),
        new Date(typeof pending.expiresAt === "string" ? pending.expiresAt : NaN),
        this.marketEntryPolicy,
      );
      const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!
        .now;
      const reason = !Number.isFinite(expiresAt)
        ? "INVALID_PENDING_SIGNAL"
        : +now >= expiresAt
          ? "ENTRY_SIGNAL_EXPIRED"
          : gateReason
            ? undefined
            : input.rejectionReason;
      const previousDecision = cursor.lastDecisionId
        ? await tx.decision.findUnique({
            where: { id: cursor.lastDecisionId },
            select: { reasonCode: true, factors: true },
          })
        : null;
      const waitingReason = gateReason ?? input.waitingReason;
      let decisionId: string | undefined;
      if (reason) {
        await cancelPendingEntryOrder(
          tx,
          cursor.pendingSignal,
          input.workspaceId,
          run.id,
          reason,
          now,
        );
        const decision = await tx.decision.create({
          data: {
            workspaceId: input.workspaceId,
            executionRunId: run.id,
            strategyVersionId: run.strategyVersionId,
            symbol: input.symbol,
            action: "SKIP",
            reasonCode: reason,
            summary:
              reason === "STRATEGY_DAILY_LOSS_LIMIT"
                ? "Отложенный вход отменён: достигнут лимит закрытого убытка за сутки в часовом поясе стратегии"
                : reason === "MAX_ACCOUNT_STOP_RISK"
                  ? "Отложенный вход отменён: общий бюджет риска до стопов занят открытыми позициями"
                  : `Отложенный вход отменён: ${reason}`,
            factors: withRuntimeSignal(
              {
                source: "durable-price-events",
                pendingSignal: cursor.pendingSignal as Prisma.InputJsonValue,
                ...(configuredOrderType === "market"
                  ? { marketEntryPolicy: this.marketEntryPolicy }
                  : {}),
                lastWaitingReason: previousDecision?.reasonCode ?? null,
                lastEventId: throughEventId === null ? null : String(throughEventId),
              },
              runtimeSignalState({
                executionRunId: run.id,
                symbol: input.symbol,
                candleAt: input.expectedCandleAt,
                status: reason === "ENTRY_SIGNAL_EXPIRED" ? "EXPIRED" : "REJECTED",
                observedAt: now,
                reasonCode: reason,
                pending: cursor.pendingSignal,
              }),
            ),
            correlationId: `runtime-pending:${run.id}:${input.symbol}:${input.expectedCandleAt.toISOString()}:terminal`,
            decidedAt: now,
          },
          select: { id: true },
        });
        decisionId = decision.id;
      }
      if (!reason && waitingReason) {
        const previousState =
          previousDecision?.factors &&
          typeof previousDecision.factors === "object" &&
          !Array.isArray(previousDecision.factors)
            ? (previousDecision.factors as { runtimeSignal?: { status?: string; id?: string } })
                .runtimeSignal
            : null;
        const state = runtimeSignalState({
          executionRunId: run.id,
          symbol: input.symbol,
          candleAt: input.expectedCandleAt,
          status: "PENDING",
          observedAt: now,
          reasonCode: waitingReason,
          pending: cursor.pendingSignal,
        });
        if (
          previousDecision?.reasonCode !== waitingReason ||
          previousState?.status !== "PENDING" ||
          previousState.id !== state.id
        ) {
          const decision = await tx.decision.create({
            data: {
              workspaceId: input.workspaceId,
              executionRunId: run.id,
              strategyVersionId: run.strategyVersionId,
              symbol: input.symbol,
              action: "HOLD",
              reasonCode: waitingReason,
              summary: runtimeEntryWaitSummary(waitingReason),
              factors: withRuntimeSignal(
                {
                  source: "durable-price-events",
                  pendingSignal: cursor.pendingSignal as Prisma.InputJsonValue,
                  lastEventId: throughEventId === null ? null : String(throughEventId),
                },
                state,
              ),
              correlationId: `runtime-pending:${run.id}:${input.symbol}:${input.expectedCandleAt.toISOString()}:wait:${waitingReason}:${cursor.lastDecisionId ?? "initial"}`,
              decidedAt: now,
            },
            select: { id: true },
          });
          decisionId = decision.id;
        }
      }
      if (!reason && !decisionId && throughEventId === cursor.pendingPriceEventId) return true;
      await tx.runtimeCursor.update({
        where: { executionRunId_symbol: { executionRunId: run.id, symbol: input.symbol } },
        data: {
          pendingPriceEventId: throughEventId,
          ...(reason ? { pendingSignal: Prisma.DbNull } : {}),
          ...(decisionId ? { lastDecisionId: decisionId } : {}),
        },
      });
      return true;
    });
  }

  public listRealtimePendingEntries(workspaceId: string) {
    return this.prisma.runtimeCursor.findMany({
      where: {
        workspaceId,
        pendingSignal: { not: Prisma.DbNull },
        executionRun: {
          status: "RUNNING",
          deployment: {
            status: "RUNNING",
            environment: "DRY_RUN",
          },
        },
      },
      select: {
        symbol: true,
        lastEvaluatedAt: true,
        pendingSignal: true,
        pendingPriceEventId: true,
        instrument: { select: instrumentRulesSelect },
        executionRun: {
          select: {
            id: true,
            executionPolicy: true,
            strategyVersionId: true,
            strategyVersion: { select: { config: true } },
            deployment: {
              select: {
                id: true,
                workspaceId: true,
                exchangeAccountId: true,
                exchangeConnection: { select: { status: true, revokedAt: true } },
              },
            },
          },
        },
      },
    });
  }

  public async persistCycle(input: PersistRuntimeCycleInput) {
    return this.prisma.$transaction(async (transaction) => {
      await lockRuntimeRisk(transaction, input.workspaceId);
      await transaction.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${`runtime:${input.executionRunId}`}))
      `);

      const correlationId = runtimeCorrelationId(input);
      const existingDecision = await transaction.decision.findUnique({
        where: {
          workspaceId_correlationId: {
            workspaceId: input.workspaceId,
            correlationId,
          },
        },
        select: { id: true },
      });
      if (existingDecision) return { applied: false, decisionId: existingDecision.id };

      const deployment = await transaction.deployment.findFirst({
        where: { id: input.deploymentId, workspaceId: input.workspaceId },
        select: {
          status: true,
          environment: true,
          exchangeAccountId: true,
          exchangeConnection: { select: { status: true, revokedAt: true } },
        },
      });
      const executionRun = await transaction.executionRun.findFirst({
        where: {
          id: input.executionRunId,
          workspaceId: input.workspaceId,
          deploymentId: input.deploymentId,
        },
        select: { status: true, strategyVersion: { select: { config: true } } },
      });
      if (
        deployment?.status !== input.expectedDeploymentStatus ||
        deployment.environment !== "DRY_RUN" ||
        executionRun?.status !== "RUNNING"
      ) {
        throw new RuntimeStateConflictError();
      }

      const cursor = await transaction.runtimeCursor.findUnique({
        where: {
          executionRunId_symbol: {
            executionRunId: input.executionRunId,
            symbol: input.symbol,
          },
        },
        select: {
          lastEvaluatedAt: true,
          lastFailureCode: true,
          pendingSignal: true,
          pendingPriceEventId: true,
          lastDecisionId: true,
        },
      });
      if (cursor?.lastEvaluatedAt && cursor.lastEvaluatedAt >= input.candleAt) {
        return { applied: false, decisionId: null };
      }

      if (
        input.expectedLastEvaluatedAt !== undefined &&
        (cursor?.lastEvaluatedAt?.getTime() ?? null) !==
          (input.expectedLastEvaluatedAt?.getTime() ?? null)
      ) {
        throw new RuntimeStateConflictError();
      }

      const currentPosition = await transaction.position.findFirst({
        where: {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          symbol: input.symbol,
          status: "OPEN",
        },
        select: { id: true, runtimeVersion: true },
      });
      if ((currentPosition?.id ?? null) !== input.expectedPositionId) {
        throw new RuntimeStateConflictError();
      }

      if ((currentPosition?.runtimeVersion ?? null) !== input.expectedPositionVersion) {
        throw new RuntimeStateConflictError();
      }
      const entriesAllowed =
        deployment.status === "RUNNING" &&
        deployment.exchangeConnection?.status === "ACTIVE" &&
        deployment.exchangeConnection.revokedAt === null;

      let decision = input.decision;
      let action = input.positionAction;
      const proposedSignal =
        input.candidate && typeof input.candidate === "object" && !Array.isArray(input.candidate)
          ? (input.candidate as Prisma.InputJsonObject)
          : null;
      if (
        !entriesAllowed &&
        action.kind === "none" &&
        (proposedSignal?.side === "long" || proposedSignal?.side === "short" || input.pendingSignal)
      ) {
        decision = {
          action: "SKIP",
          reasonCode:
            deployment.status === "PAUSED" ? "DEPLOYMENT_PAUSED" : "ENTRY_CONNECTION_UNAVAILABLE",
          summary: "Новый сигнал отклонён состоянием deployment или подключения",
          factors: input.decision.factors,
        };
      }
      let decisionPositionId = currentPosition?.id ?? null;
      let decisionTradeId: string | null = null;
      if (action.kind === "open") {
        const [instrument, openPositions] = await Promise.all([
          transaction.marketInstrument.findUnique({
            where: { symbol: input.symbol },
            select: { status: true, enabled: true },
          }),
          transaction.position.count({
            where: {
              workspaceId: input.workspaceId,
              executionRunId: input.executionRunId,
              status: "OPEN",
            },
          }),
        ]);
        if (!entriesAllowed) {
          action = { kind: "none" };
          decision = {
            action: "SKIP",
            reasonCode:
              deployment.status === "PAUSED" ? "DEPLOYMENT_PAUSED" : "ENTRY_CONNECTION_UNAVAILABLE",
            summary: "Новый вход запрещён состоянием deployment или подключения",
            factors: input.decision.factors,
          };
        } else if (!instrument?.enabled || instrument.status !== "Trading") {
          action = { kind: "none" };
          decision = {
            action: "SKIP",
            reasonCode: "INSTRUMENT_UNAVAILABLE",
            summary: `Вход пропущен: ${input.symbol} недоступен для торговли`,
            factors: input.decision.factors,
          };
        } else if (openPositions >= input.maxOpenPositions) {
          action = { kind: "none" };
          decision = {
            action: "SKIP",
            reasonCode: "MAX_OPEN_POSITIONS",
            summary: "Вход пропущен: достигнут лимит открытых позиций",
            factors: input.decision.factors,
          };
        }
      }

      if (action.kind === "open") {
        const riskFailure = await checkRuntimeEntry(transaction, {
          workspaceId: input.workspaceId,
          exchangeAccountId: deployment.exchangeAccountId,
          strategyConfig: executionRun.strategyVersion.config,
          policy: this.riskPolicy,
          eventId: input.entryPriceEventId,
          ...(input.signalAvailableAt ? { signalAvailableAt: input.signalAvailableAt } : {}),
          position: action.position,
        });
        if (riskFailure) {
          action = { kind: "none" };
          decision = {
            action: "SKIP",
            reasonCode: riskFailure,
            summary:
              riskFailure === "STRATEGY_DAILY_LOSS_LIMIT"
                ? "Вход запрещён: достигнут лимит закрытого убытка за сутки в часовом поясе стратегии"
                : riskFailure === "MAX_ACCOUNT_STOP_RISK"
                  ? "Вход запрещён: недостаточно общего бюджета риска до стопов"
                  : "Вход запрещён независимым риск-контролем",
            factors: input.decision.factors,
          };
        }
      }
      const configuredEntryOrderType =
        (executionRun.strategyVersion.config as { entry?: { orderType?: string } }).entry
          ?.orderType === "market"
          ? "MARKET"
          : "LIMIT";
      if (action.kind === "open" && input.entryOrderType !== configuredEntryOrderType) {
        action = { kind: "none" };
        decision = {
          action: "SKIP",
          reasonCode: "INVALID_ENTRY_ORDER_TYPE",
          summary: "Тип входа не соответствует конфигурации стратегии",
          factors: input.decision.factors,
        };
      }
      if (action.kind === "open" && input.entryOrderType === "MARKET") {
        const entryEvent = await transaction.marketPriceEvent.findUniqueOrThrow({
          where: { id: input.entryPriceEventId! },
        });
        const now = (
          await transaction.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
        )[0]!.now;
        const detectedAt = new Date(+input.candleAt + Number(input.interval) * 60_000);
        const marketFailure = runtimeMarketEntryFailure(
          {
            detectedAt,
            expiresAt: new Date(+detectedAt + Number(input.interval) * 60_000),
            signalPrice: input.entrySignalPrice ?? NaN,
            quotePrice: Number(entryEvent.price),
            quoteAt: entryEvent.observedAt,
            now,
          },
          this.marketEntryPolicy,
        );
        if (marketFailure) {
          action = { kind: "none" };
          decision = {
            action: "SKIP",
            reasonCode: marketFailure,
            summary: `Рыночный вход отклонён: ${marketFailure}`,
            factors: input.decision.factors,
          };
        }
      }
      if (action.kind === "update") {
        await transaction.position.update({
          where: { id: action.positionId },
          data: {
            markPrice: action.markPrice,
            unrealizedPnl: action.unrealizedPnl,
            bestPrice: action.bestPrice,
            stopPrice: action.stopPrice,
            runtimeVersion: { increment: 1 },
            trailingPrice: action.trailingPrice,
          },
        });
      } else if (action.kind === "open") {
        const entryEvent = await transaction.marketPriceEvent.findUniqueOrThrow({
          where: { id: input.entryPriceEventId! },
        });
        const position = await transaction.position.create({
          data: {
            workspaceId: input.workspaceId,
            executionRunId: input.executionRunId,
            strategyVersionId: input.strategyVersionId,
            symbol: input.symbol,
            environment: "DRY_RUN",
            priceEventId: entryEvent.id,
            priceStreamId: entryEvent.streamId,
            managedThroughAt: entryEvent.observedAt,
            signalCandleAt: input.candleAt,
            ...(input.indicatorState === undefined ? {} : { indicatorState: input.indicatorState }),
            side: action.position.side,
            entryRegime: action.position.entryRegime,
            entrySession: action.position.entrySession,
            status: "OPEN",
            quantity: action.position.quantity,
            entryPrice: action.position.entryPrice,
            stopPrice: action.position.stopPrice,
            takePrice: action.position.takePrice,
            trailingPrice: action.position.trailingPrice,
            bestPrice: action.position.bestPrice,
            entryFee: action.position.entryFee,
            entrySlippage: action.position.entrySlippage,
            ...(action.position.instrumentRules
              ? { instrumentRules: action.position.instrumentRules }
              : {}),
            markPrice: action.markPrice,
            unrealizedPnl: action.unrealizedPnl,
            openedAt: action.position.openedAt,
          },
          select: { id: true, entryFee: true },
        });
        decisionPositionId = position.id;
        await ensurePositionTrace(transaction, {
          positionId: position.id,
          workspaceId: input.workspaceId,
          strategyVersionId: input.strategyVersionId,
          position: action.position,
          eventId: entryEvent.id,
          streamId: entryEvent.streamId,
          throughAt: entryEvent.observedAt,
          markPrice: action.markPrice,
          signalCandleAt: input.candleAt,
          indicatorState: (input.indicatorState ?? null) as Prisma.JsonValue,
          profitProtectionState: null,
          fullFromEntry: true,
          riskPolicy: this.riskPolicy,
          marketEntryPolicy: this.marketEntryPolicy,
          options: this.traceOptions,
        });
        await createFilledOrder(transaction, {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          positionId: position.id,
          symbol: input.symbol,
          clientOrderId: `${correlationId}:entry`,
          side: action.position.side,
          type: input.entryOrderType,
          quantity: action.position.quantity,
          price: action.position.entryPrice,
          fee: action.position.entryFee,
          filledAt: action.position.openedAt,
        });
        if (action.immediateSettlement) {
          const trade = await persistClosedPosition(
            transaction,
            {
              workspaceId: input.workspaceId,
              executionRunId: input.executionRunId,
              strategyVersionId: input.strategyVersionId,
              positionId: position.id,
              symbol: input.symbol,
              side: action.position.side,
              quantity: action.position.quantity,
              entryPrice: action.position.entryPrice,
              entryFee: position.entryFee.toFixed(),
              entryRegime: action.position.entryRegime,
              entrySession: action.position.entrySession,
              openedAt: action.position.openedAt,
              correlationId,
            },
            action.immediateSettlement,
          );
          decisionTradeId = trade.id;
        }
      } else if (action.kind === "close") {
        const position = await transaction.position.findUniqueOrThrow({
          where: { id: action.positionId },
          select: {
            id: true,
            side: true,
            exitPolicy: true,
            executionPolicy: true,
            fundingPolicy: true,
            fundingState: true,
            fundingAccrued: true,
            fundingRemaining: true,
            quantity: true,
            entryPrice: true,
            entryFee: true,
            entryRegime: true,
            entrySession: true,
            openedAt: true,
          },
        });
        if (isLiquidityExitPolicy(position.exitPolicy)) throw new RuntimeStateConflictError();
        const trade = await persistClosedPosition(
          transaction,
          {
            workspaceId: input.workspaceId,
            executionRunId: input.executionRunId,
            strategyVersionId: input.strategyVersionId,
            positionId: position.id,
            symbol: input.symbol,
            side: position.side,
            quantity: position.quantity.toFixed(),
            entryPrice: position.entryPrice.toFixed(),
            entryFee: position.entryFee.toFixed(),
            entryRegime: position.entryRegime,
            entrySession: position.entrySession,
            openedAt: position.openedAt,
            correlationId,
          },
          action.settlement,
        );
        decisionPositionId = position.id;
        decisionTradeId = trade.id;
      }

      let effectivePending = input.pendingSignal;
      const pendingDetails =
        effectivePending && typeof effectivePending === "object" && !Array.isArray(effectivePending)
          ? (effectivePending as Prisma.InputJsonObject)
          : null;
      if (pendingDetails?.mode === "realtime" && configuredEntryOrderType === "MARKET") {
        const detectedAt = new Date(
          typeof pendingDetails.detectedAt === "string" ? pendingDetails.detectedAt : NaN,
        );
        const expiresAt = runtimeEntryExpiresAt(
          "MARKET",
          detectedAt,
          new Date(typeof pendingDetails.expiresAt === "string" ? pendingDetails.expiresAt : NaN),
          this.marketEntryPolicy,
        );
        const now = (
          await transaction.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
        )[0]!.now;
        const failure = runtimeMarketEntryFailure(
          {
            detectedAt,
            expiresAt,
            signalPrice:
              typeof pendingDetails.signalPrice === "number" ? pendingDetails.signalPrice : NaN,
            now,
          },
          this.marketEntryPolicy,
        );
        if (Number.isFinite(+expiresAt))
          effectivePending = { ...pendingDetails, expiresAt: expiresAt.toISOString() };
        if (failure && action.kind === "none" && decision.action !== "SKIP") {
          decision = {
            action: "SKIP",
            reasonCode: failure,
            summary: `Рыночный сигнал отклонён: ${failure}`,
            factors: input.decision.factors,
          };
        }
      }
      const previousPending =
        cursor?.pendingSignal &&
        typeof cursor.pendingSignal === "object" &&
        !Array.isArray(cursor.pendingSignal)
          ? (cursor.pendingSignal as Prisma.InputJsonObject)
          : null;
      if (cursor?.lastEvaluatedAt && previousPending?.mode === "realtime") {
        const now = (
          await transaction.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
        )[0]!.now;
        const expiresAt = runtimeEntryExpiresAt(
          configuredEntryOrderType,
          new Date(
            typeof previousPending.detectedAt === "string" ? previousPending.detectedAt : NaN,
          ),
          new Date(typeof previousPending.expiresAt === "string" ? previousPending.expiresAt : NaN),
          this.marketEntryPolicy,
        );
        const reason = !Number.isFinite(+expiresAt)
          ? "INVALID_PENDING_SIGNAL"
          : +now >= +expiresAt
            ? "ENTRY_SIGNAL_EXPIRED"
            : "ENTRY_SIGNAL_SUPERSEDED";
        await cancelPendingEntryOrder(
          transaction,
          previousPending,
          input.workspaceId,
          input.executionRunId,
          reason,
          now,
        );
        const previousDecision = cursor.lastDecisionId
          ? await transaction.decision.findUnique({
              where: { id: cursor.lastDecisionId },
              select: { reasonCode: true },
            })
          : null;
        await transaction.decision.create({
          data: {
            workspaceId: input.workspaceId,
            executionRunId: input.executionRunId,
            strategyVersionId: input.strategyVersionId,
            symbol: input.symbol,
            action: "SKIP",
            reasonCode: reason,
            summary:
              reason === "ENTRY_SIGNAL_SUPERSEDED"
                ? "Прежний сигнал завершён при обработке новой свечи"
                : `Прежний сигнал завершён: ${reason}`,
            factors: withRuntimeSignal(
              {
                source: "runtime-candle-replacement",
                pendingSignal: previousPending,
                lastEventId:
                  cursor.pendingPriceEventId === null ? null : String(cursor.pendingPriceEventId),
                lastWaitingReason: previousDecision?.reasonCode ?? null,
                replacementCandleAt: input.candleAt.toISOString(),
                ...(configuredEntryOrderType === "MARKET"
                  ? { marketEntryPolicy: this.marketEntryPolicy }
                  : {}),
              },
              runtimeSignalState({
                executionRunId: input.executionRunId,
                symbol: input.symbol,
                candleAt: cursor.lastEvaluatedAt,
                status: reason === "ENTRY_SIGNAL_EXPIRED" ? "EXPIRED" : "REJECTED",
                observedAt: now,
                reasonCode: reason,
                pending: previousPending,
              }),
            ),
            correlationId: `runtime-pending:${input.executionRunId}:${input.symbol}:${cursor.lastEvaluatedAt.toISOString()}:terminal`,
            decidedAt: now,
          },
        });
      }
      const contextSnapshot = await ensureDecisionContextSnapshot(
        transaction,
        input.contextSnapshot,
      );
      const proposed =
        input.candidate && typeof input.candidate === "object" && !Array.isArray(input.candidate)
          ? (input.candidate as Prisma.InputJsonObject)
          : null;
      const pending =
        effectivePending && typeof effectivePending === "object" && !Array.isArray(effectivePending)
          ? (effectivePending as Prisma.InputJsonObject)
          : null;
      const hasSignal =
        proposed?.side === "long" ||
        proposed?.side === "short" ||
        pending?.mode === "realtime" ||
        input.decision.reasonCode === "ENTRY_SIGNAL_FILLED_REALTIME";
      const signalState = hasSignal
        ? runtimeSignalState({
            executionRunId: input.executionRunId,
            symbol: input.symbol,
            candleAt: input.candleAt,
            status:
              action.kind === "open"
                ? "FILLED"
                : entriesAllowed && pending?.mode === "realtime" && decision.action !== "SKIP"
                  ? "PENDING"
                  : decision.reasonCode === "ENTRY_SIGNAL_EXPIRED"
                    ? "EXPIRED"
                    : "REJECTED",
            observedAt: input.contextSnapshot.availableAt,
            reasonCode: decision.reasonCode,
            pending: effectivePending,
          })
        : null;
      if (signalState) {
        await transaction.auditEvent.create({
          data: {
            workspaceId: input.workspaceId,
            actorId: "worker",
            action: "runtime.signal.observed",
            resourceType: "runtime-signal",
            resourceId: signalState.id,
            outcome: "COMPLETED",
            requestId: correlationId,
            metadata: { ...signalState, status: "SIGNAL" },
          },
        });
      }
      const pendingToStore =
        signalState && pending?.mode === "realtime"
          ? signalState.status === "PENDING"
            ? { ...pending, signalId: signalState.id }
            : null
          : input.pendingSignal;
      const persistedDecision = await transaction.decision.create({
        data: {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          strategyVersionId: input.strategyVersionId,
          contextSnapshotId: contextSnapshot.id,
          positionId: decisionPositionId,
          tradeId: decisionTradeId,
          symbol: input.symbol,
          action: decision.action,
          mode: "EXECUTION",
          providerKind: "RULE_BASED",
          providerId: "cryptoanal-rule-engine",
          providerVersion: input.providerVersion,
          reasonCode: decision.reasonCode,
          summary: decision.summary,
          factors: signalState
            ? withRuntimeSignal(
                configuredEntryOrderType === "MARKET"
                  ? {
                      ...(decision.factors &&
                      typeof decision.factors === "object" &&
                      !Array.isArray(decision.factors)
                        ? (decision.factors as Prisma.InputJsonObject)
                        : { details: decision.factors }),
                      marketEntryPolicy: this.marketEntryPolicy,
                      signalPrice: input.entrySignalPrice ?? pending?.signalPrice ?? null,
                    }
                  : decision.factors,
                signalState,
              )
            : decision.factors,
          candidate: input.candidate,
          verdictReasonCode: decision.reasonCode,
          marketSnapshotRef: `decision-context:${contextSnapshot.contentHash}`,
          correlationId,
          decidedAt: input.contextSnapshot.availableAt,
        },
        select: { id: true },
      });
      await transaction.runtimeCursor.upsert({
        where: {
          executionRunId_symbol: {
            executionRunId: input.executionRunId,
            symbol: input.symbol,
          },
        },
        create: {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          symbol: input.symbol,
          lastEvaluatedAt: input.candleAt,
          ...(input.indicatorState === undefined ? {} : { indicatorState: input.indicatorState }),
          pendingSignal: entriesAllowed ? (pendingToStore ?? Prisma.DbNull) : Prisma.DbNull,
          pendingPriceEventId: null,
          lastDecisionId: persistedDecision.id,
        },
        update: {
          lastEvaluatedAt: input.candleAt,
          ...(input.indicatorState === undefined ? {} : { indicatorState: input.indicatorState }),
          pendingSignal: entriesAllowed ? (pendingToStore ?? Prisma.DbNull) : Prisma.DbNull,
          pendingPriceEventId: null,
          lastDecisionId: persistedDecision.id,
          ...(cursor?.lastFailureCode === "RUNTIME_RECOVERY_REQUIRED" &&
          currentPosition &&
          action.kind !== "close"
            ? {}
            : {
                lastFailureCode: null,
                lastFailureMessage: null,
                consecutiveFailures: 0,
              }),
        },
      });

      return { applied: true, decisionId: persistedDecision.id };
    });
  }

  public getManualCloseContext(workspaceId: string, positionId: string) {
    return this.prisma.position.findFirst({
      where: { id: positionId, workspaceId },
      select: {
        instrumentRules: true,
        exitPolicy: true,
        executionPolicy: true,
        fundingPolicy: true,
        fundingState: true,
        fundingAccrued: true,
        fundingRemaining: true,
        remainingQuantity: true,
        remainingEntryFee: true,
        exitState: true,
        entryExecution: true,
        id: true,
        symbol: true,
        side: true,
        status: true,
        openedAt: true,
        entryPrice: true,
        quantity: true,
        stopPrice: true,
        takePrice: true,
        trailingPrice: true,
        bestPrice: true,
        entryFee: true,
        entrySlippage: true,
        entryRegime: true,
        entrySession: true,
        executionRunId: true,
        strategyVersionId: true,
        strategyVersion: { select: { config: true } },
        instrument: {
          select: {
            snapshots: {
              orderBy: { observedAt: "desc" },
              take: 1,
              select: { price: true, observedAt: true },
            },
          },
        },
        executionRun: {
          select: { status: true, deployment: { select: { status: true } } },
        },
      },
    });
  }

  public async replayManualClose(workspaceId: string, positionId: string, idempotencyKey: string) {
    const receipt = await this.prisma.commandReceipt.findUnique({
      where: {
        workspaceId_idempotencyKey: { workspaceId, idempotencyKey },
      },
      select: { command: true, resourceType: true, resourceId: true, result: true },
    });
    if (!receipt) return null;
    return parseManualCloseReceipt(receipt, positionId);
  }

  public async requestManualLiquidityExit(input: {
    workspaceId: string;
    positionId: string;
    executionRunId: string;
    actorId: string;
    requestId: string;
    idempotencyKey: string;
    reason: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`command:${input.workspaceId}:${input.idempotencyKey}`}))`,
      );
      await lockRuntimeRisk(tx, input.workspaceId);
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${input.executionRunId}`}))`,
      );
      const receipt = await tx.commandReceipt.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: input.workspaceId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (receipt) return parseManualCloseReceipt(receipt, input.positionId);
      const p = await tx.position.findFirst({
        where: { id: input.positionId, workspaceId: input.workspaceId },
        include: { executionRun: { include: { deployment: true } } },
      });
      if (!p) throw new RuntimePositionNotFoundError();
      if (p.status !== "OPEN") throw new RuntimePositionStatusConflictError();
      if (
        p.executionRunId !== input.executionRunId ||
        p.environment !== "DRY_RUN" ||
        !isLiquidityExitPolicy(p.exitPolicy) ||
        p.executionRun.status !== "RUNNING" ||
        !["RUNNING", "PAUSED"].includes(p.executionRun.deployment.status)
      )
        throw new RuntimeManualCloseNotAllowedError();
      if (!p.exitState) {
        const event = await tx.marketPriceEvent.findFirst({
          where: { symbol: p.symbol },
          orderBy: { id: "desc" },
        });
        if (!event) throw new RuntimeMarketPriceUnavailableError();
        const at = new Date(Math.max(+event.observedAt, +(p.managedThroughAt ?? p.openedAt)));
        await latchLiquidityExit(
          tx,
          p,
          {
            workspaceId: p.workspaceId,
            deploymentId: p.executionRun.deploymentId,
            executionRunId: p.executionRunId,
            strategyVersionId: p.strategyVersionId,
            positionId: p.id,
            expectedPositionVersion: p.runtimeVersion,
            symbol: p.symbol,
            quotePrice: event.price.toFixed(),
            quoteAt: at,
            processedPrice: { eventId: event.id, streamId: event.streamId, throughAt: at },
            processedEventCount: await tx.marketPriceEvent.count({
              where: { symbol: p.symbol, id: { gt: p.priceEventId ?? 0n, lte: event.id } },
            }),
            factors: { source: "manual", reason: input.reason },
            action: {
              kind: "close",
              settlement: {
                exitPrice: "0",
                grossPnl: "0",
                netPnl: "0",
                fees: "0",
                slippage: "0",
                exitReason: "manual",
                closedAt: at,
              },
            },
          },
          {
            riskPolicy: this.riskPolicy,
            marketEntryPolicy: this.marketEntryPolicy,
            traceOptions: this.traceOptions,
            origin: "manual",
          },
        );
      }
      const result = {
        positionId: p.id,
        tradeId: null,
        status: "closing" as const,
        replayed: false,
      };
      await tx.commandReceipt.create({
        data: {
          workspaceId: input.workspaceId,
          idempotencyKey: input.idempotencyKey,
          command: "position.close",
          resourceType: "position",
          resourceId: p.id,
          result,
        },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          requestId: input.requestId,
          action: "position.close.request",
          resourceType: "position",
          resourceId: p.id,
          outcome: "COMPLETED",
          metadata: { reason: input.reason },
        },
      });
      return result;
    });
  }

  public async closeManually(input: {
    workspaceId: string;
    positionId: string;
    executionRunId: string;
    actorId: string;
    requestId: string;
    idempotencyKey: string;
    reason: string;
    quoteObservedAt: Date;
    maximumQuoteAgeMs: number;
    settlement: RuntimeCycleSettlement;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${`command:${input.workspaceId}:${input.idempotencyKey}`}))
      `);
      await lockRuntimeRisk(transaction, input.workspaceId);
      await transaction.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${`runtime:${input.executionRunId}`}))
      `);
      const receipt = await transaction.commandReceipt.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: input.workspaceId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { command: true, resourceType: true, resourceId: true, result: true },
      });
      if (receipt) {
        return parseManualCloseReceipt(receipt, input.positionId);
      }

      const locked = await transaction.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
        SELECT "id", "status"
        FROM "Position"
        WHERE "id" = ${input.positionId} AND "workspaceId" = ${input.workspaceId}
        FOR UPDATE
      `);
      if (!locked[0]) throw new RuntimePositionNotFoundError();
      if (locked[0].status !== "OPEN") throw new RuntimePositionStatusConflictError();

      const position = await transaction.position.findUniqueOrThrow({
        where: { id: input.positionId },
        select: {
          id: true,
          exitPolicy: true,
          executionPolicy: true,
          fundingPolicy: true,
          fundingState: true,
          fundingAccrued: true,
          fundingRemaining: true,
          environment: true,
          executionRunId: true,
          strategyVersionId: true,
          symbol: true,
          side: true,
          quantity: true,
          entryPrice: true,
          entryFee: true,
          entryRegime: true,
          entrySession: true,
          openedAt: true,
          executionRun: {
            select: { status: true, deployment: { select: { status: true } } },
          },
        },
      });
      if (
        isLiquidityExitPolicy(position.exitPolicy) ||
        position.executionRunId !== input.executionRunId ||
        position.environment !== "DRY_RUN" ||
        position.executionRun.status !== "RUNNING" ||
        (position.executionRun.deployment.status !== "RUNNING" &&
          position.executionRun.deployment.status !== "PAUSED")
      ) {
        throw new RuntimeManualCloseNotAllowedError();
      }
      if (
        input.quoteObservedAt.getTime() < Date.now() - input.maximumQuoteAgeMs ||
        input.settlement.closedAt.getTime() < input.quoteObservedAt.getTime()
      ) {
        throw new RuntimeMarketPriceUnavailableError();
      }

      const correlationId = `manual:${position.id}:${input.idempotencyKey}`;
      const trade = await persistClosedPosition(
        transaction,
        {
          workspaceId: input.workspaceId,
          executionRunId: position.executionRunId,
          strategyVersionId: position.strategyVersionId,
          positionId: position.id,
          symbol: position.symbol,
          side: position.side,
          quantity: position.quantity.toFixed(),
          entryPrice: position.entryPrice.toFixed(),
          entryFee: position.entryFee.toFixed(),
          entryRegime: position.entryRegime,
          entrySession: position.entrySession,
          openedAt: position.openedAt,
          correlationId,
        },
        input.settlement,
      );
      const decision = await transaction.decision.create({
        data: {
          workspaceId: input.workspaceId,
          executionRunId: position.executionRunId,
          strategyVersionId: position.strategyVersionId,
          positionId: position.id,
          tradeId: trade.id,
          symbol: position.symbol,
          action: "CLOSE",
          reasonCode: "MANUAL_CLOSE",
          summary: input.reason,
          factors: {
            quoteObservedAt: input.quoteObservedAt.toISOString(),
            exitPrice: input.settlement.exitPrice,
          },
          marketSnapshotRef: `market-snapshot:${position.symbol}:${input.quoteObservedAt.toISOString()}`,
          correlationId,
          decidedAt: input.settlement.closedAt,
        },
        select: { id: true },
      });
      await transaction.commandReceipt.create({
        data: {
          workspaceId: input.workspaceId,
          idempotencyKey: input.idempotencyKey,
          command: "position.close",
          resourceType: "position",
          resourceId: position.id,
          result: { positionId: position.id, tradeId: trade.id, decisionId: decision.id },
        },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "position.close",
          resourceType: "position",
          resourceId: position.id,
          outcome: "COMPLETED",
          reason: input.reason,
          requestId: input.requestId,
          metadata: {
            tradeId: trade.id,
            executionRunId: position.executionRunId,
            quoteObservedAt: input.quoteObservedAt.toISOString(),
          },
        },
      });

      return { positionId: position.id, tradeId: trade.id, replayed: false };
    });
  }

  public async recordFailure(input: {
    workspaceId: string;
    executionRunId: string;
    symbol: string;
    code: string;
    message: string;
  }) {
    await this.prisma.runtimeCursor.upsert({
      where: {
        executionRunId_symbol: {
          executionRunId: input.executionRunId,
          symbol: input.symbol,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        executionRunId: input.executionRunId,
        symbol: input.symbol,
        lastFailureCode: input.code,
        lastFailureMessage: input.message.slice(0, 500),
        consecutiveFailures: 1,
      },
      update: {
        lastFailureCode: input.code,
        lastFailureMessage: input.message.slice(0, 500),
        consecutiveFailures: { increment: 1 },
      },
    });
  }
}

async function clearRecoveredCursor(
  tx: Prisma.TransactionClient,
  input: PersistRuntimeQuoteInput,
  closed: boolean,
) {
  const latest = closed
    ? null
    : await tx.marketPriceEvent.findFirst({
        where: { symbol: input.symbol },
        orderBy: { id: "desc" },
        select: { id: true, streamId: true },
      });
  if (
    !closed &&
    latest &&
    (latest.id > input.processedPrice.eventId || latest.streamId !== input.processedPrice.streamId)
  )
    return;
  await tx.runtimeCursor.updateMany({
    where: {
      executionRunId: input.executionRunId,
      symbol: input.symbol,
      lastFailureCode: "RUNTIME_RECOVERY_REQUIRED",
    },
    data: { lastFailureCode: null, lastFailureMessage: null, consecutiveFailures: 0 },
  });
}

function storedEntryOrderSnapshot(value: unknown): ExecutionEntryOrder {
  const stored = value as { snapshot?: unknown; hash?: unknown };
  if (!stored?.snapshot || stored.hash !== hashTracePayload(stored.snapshot))
    throw new Error("Entry order snapshot checksum mismatch");
  return readExecutionEntryOrder(stored.snapshot);
}

async function cancelPendingEntryOrder(
  tx: Prisma.TransactionClient,
  pending: unknown,
  workspaceId: string,
  executionRunId: string,
  reason: string,
  now: Date,
) {
  const id =
    pending && typeof pending === "object" && !Array.isArray(pending)
      ? (pending as { executionOrderId?: unknown }).executionOrderId
      : null;
  if (typeof id !== "string") return;
  const order = await tx.order.findFirst({
    where: { id, workspaceId, executionRunId, status: "OPEN", positionId: null },
  });
  if (!order) return;
  const snapshot = storedEntryOrderSnapshot(order.execution);
  await tx.order.update({
    where: { id },
    data: {
      status: "CANCELLED",
      execution: {
        snapshot,
        hash: hashTracePayload(snapshot),
        terminal: {
          reason,
          cancelledAt: now.toISOString(),
          cancelledQuantity: snapshot.quantity,
          filledQuantity: "0",
        },
      },
    },
  });
}

async function createFilledOrder(
  transaction: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    executionRunId: string;
    positionId: string;
    symbol: string;
    clientOrderId: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    quantity: string;
    price: string;
    fee: string;
    filledAt: Date;
    execution?: ReturnType<typeof buildExitTriggerProof>;
  },
) {
  const order = await transaction.order.create({
    data: {
      workspaceId: input.workspaceId,
      executionRunId: input.executionRunId,
      positionId: input.positionId,
      symbol: input.symbol,
      clientOrderId: input.clientOrderId,
      side: input.side,
      type: input.type,
      status: "FILLED",
      quantity: input.quantity,
      price: input.price,
    },
    select: { id: true },
  });
  await transaction.fill.create({
    data: {
      workspaceId: input.workspaceId,
      orderId: order.id,
      quantity: input.quantity,
      price: input.price,
      fee: input.fee,
      feeAsset: "USDT",
      filledAt: input.filledAt,
      ...(input.execution
        ? { execution: input.execution as unknown as Prisma.InputJsonValue }
        : {}),
    },
  });
}

async function persistClosedPosition(
  transaction: Prisma.TransactionClient,
  position: {
    workspaceId: string;
    executionRunId: string;
    strategyVersionId: string;
    positionId: string;
    symbol: string;
    side: "BUY" | "SELL";
    quantity: string;
    entryPrice: string;
    entryFee: string;
    entryRegime: "BULL" | "BEAR" | "NEUTRAL" | "UNKNOWN";
    entrySession: "ASIA" | "EUROPE" | "US" | "OFF_HOURS" | "UNKNOWN";
    openedAt: Date;
    correlationId: string;
  },
  settlement: RuntimeCycleSettlement,
  exitProof?: ReturnType<typeof buildExitTriggerProof>,
) {
  const exitFee = Prisma.Decimal.max(
    new Prisma.Decimal(settlement.fees).sub(position.entryFee),
    0,
  ).toFixed();
  await createFilledOrder(transaction, {
    workspaceId: position.workspaceId,
    executionRunId: position.executionRunId,
    positionId: position.positionId,
    symbol: position.symbol,
    clientOrderId: `${position.correlationId}:exit`,
    side: position.side === "BUY" ? "SELL" : "BUY",
    type: "MARKET",
    quantity: position.quantity,
    price: settlement.exitPrice,
    fee: exitFee,
    filledAt: settlement.closedAt,
    ...(exitProof ? { execution: exitProof } : {}),
  });
  await transaction.position.update({
    where: { id: position.positionId },
    data: {
      status: "CLOSED",
      markPrice: settlement.exitPrice,
      realizedPnl: settlement.netPnl,
      unrealizedPnl: 0,
      closedAt: settlement.closedAt,
    },
  });
  await closePositionTrace(transaction, position.positionId, settlement);
  return transaction.trade.create({
    data: {
      workspaceId: position.workspaceId,
      positionId: position.positionId,
      executionRunId: position.executionRunId,
      strategyVersionId: position.strategyVersionId,
      symbol: position.symbol,
      environment: "DRY_RUN",
      side: position.side,
      entryRegime: position.entryRegime,
      entrySession: position.entrySession,
      quantity: position.quantity,
      averageEntryPrice: position.entryPrice,
      averageExitPrice: settlement.exitPrice,
      grossPnl: settlement.grossPnl,
      fees: settlement.fees,
      funding: 0,
      slippage: settlement.slippage,
      netPnl: settlement.netPnl,
      exitReason: settlement.exitReason,
      openedAt: position.openedAt,
      closedAt: settlement.closedAt,
    },
    select: { id: true },
  });
}

function runtimeCorrelationId(input: PersistRuntimeCycleInput) {
  return `runtime:${input.executionRunId}:${input.symbol}:${input.interval}:${input.candleAt.toISOString()}`;
}

function getJsonString(value: Prisma.JsonValue, key: string) {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const entry = value[key];
  return typeof entry === "string" ? entry : null;
}

function parseManualCloseReceipt(
  receipt: {
    command: string;
    resourceType: string;
    resourceId: string;
    result: Prisma.JsonValue;
  },
  positionId: string,
) {
  if (
    receipt.command !== "position.close" ||
    receipt.resourceType !== "position" ||
    receipt.resourceId !== positionId
  ) {
    throw new RuntimeIdempotencyConflictError();
  }
  const tradeId = getJsonString(receipt.result, "tradeId");
  if (getJsonString(receipt.result, "status") === "closing")
    return { positionId, tradeId: null, status: "closing" as const, replayed: true };
  if (!tradeId) throw new RuntimeIdempotencyConflictError();
  return { positionId, tradeId, replayed: true };
}
