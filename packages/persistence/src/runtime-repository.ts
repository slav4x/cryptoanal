import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";

type RuntimeDeploymentStatus = "RUNNING" | "PAUSED";

export type RuntimeCyclePosition = {
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
  workspaceId: string;
  deploymentId: string;
  executionRunId: string;
  strategyVersionId: string;
  symbol: string;
  interval: string;
  candleAt: Date;
  expectedDeploymentStatus: RuntimeDeploymentStatus;
  expectedPositionId: string | null;
  pendingSignal: Prisma.InputJsonValue | null;
  maxOpenPositions: number;
  entryOrderType: "MARKET" | "LIMIT";
  decision: {
    action: "OPEN" | "CLOSE" | "HOLD" | "SKIP";
    reasonCode: string;
    summary: string;
    factors: Prisma.InputJsonValue;
  };
  positionAction: RuntimePositionAction;
};

export class RuntimeStateConflictError extends Error {}
export class RuntimePositionNotFoundError extends Error {}
export class RuntimePositionStatusConflictError extends Error {}
export class RuntimeManualCloseNotAllowedError extends Error {}
export class RuntimeMarketPriceUnavailableError extends Error {}
export class RuntimeIdempotencyConflictError extends Error {}

export class RuntimeRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public listActiveTargets(workspaceId: string) {
    return this.prisma.deployment.findMany({
      where: {
        workspaceId,
        OR: [
          {
            status: "RUNNING",
            exchangeConnection: { is: { status: "ACTIVE", revokedAt: null } },
          },
          { status: "PAUSED" },
        ],
      },
      orderBy: { updatedAt: "asc" },
      select: {
        id: true,
        workspaceId: true,
        status: true,
        exchangeAccountId: true,
        strategyVersion: { select: { id: true, config: true, configHash: true } },
        executionRuns: {
          where: { status: "RUNNING" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, contextHash: true, engineVersion: true },
        },
      },
    });
  }

  public async getCycleState(input: {
    workspaceId: string;
    executionRunId: string;
    symbol: string;
    interval: string;
    lastCompleteCandleAt: Date;
    candleLimit: number;
  }) {
    const [cursor, position, candles, recentTrades] = await Promise.all([
      this.prisma.runtimeCursor.findUnique({
        where: {
          executionRunId_symbol: {
            executionRunId: input.executionRunId,
            symbol: input.symbol,
          },
        },
        select: { lastEvaluatedAt: true, pendingSignal: true },
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
          entryRegime: true,
          entrySession: true,
        },
      }),
      this.prisma.marketCandle.findMany({
        where: {
          symbol: input.symbol,
          interval: input.interval,
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
        },
      }),
      this.prisma.trade.findMany({
        where: {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          closedAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1_000) },
        },
        select: { closedAt: true, netPnl: true },
      }),
    ]);

    return { cursor, position, candles: candles.reverse(), recentTrades };
  }

  public async getDryRunEquity(workspaceId: string, initialBalance: string) {
    const [trades, positions] = await Promise.all([
      this.prisma.trade.aggregate({
        where: { workspaceId, environment: "DRY_RUN" },
        _sum: { netPnl: true },
      }),
      this.prisma.position.findMany({
        where: { workspaceId, environment: "DRY_RUN", status: "OPEN" },
        select: { unrealizedPnl: true },
      }),
    ]);
    return positions
      .reduce(
        (equity, position) => equity.add(position.unrealizedPnl),
        new Prisma.Decimal(initialBalance).add(trades._sum.netPnl ?? 0),
      )
      .toNumber();
  }

  public async persistCycle(input: PersistRuntimeCycleInput) {
    return this.prisma.$transaction(async (transaction) => {
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
        select: { status: true },
      });
      const executionRun = await transaction.executionRun.findFirst({
        where: {
          id: input.executionRunId,
          workspaceId: input.workspaceId,
          deploymentId: input.deploymentId,
        },
        select: { status: true },
      });
      if (
        deployment?.status !== input.expectedDeploymentStatus ||
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
        select: { lastEvaluatedAt: true },
      });
      if (cursor?.lastEvaluatedAt && cursor.lastEvaluatedAt >= input.candleAt) {
        return { applied: false, decisionId: null };
      }

      const currentPosition = await transaction.position.findFirst({
        where: {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          symbol: input.symbol,
          status: "OPEN",
        },
        select: { id: true },
      });
      if ((currentPosition?.id ?? null) !== input.expectedPositionId) {
        throw new RuntimeStateConflictError();
      }

      let decision = input.decision;
      let action = input.positionAction;
      let decisionPositionId = currentPosition?.id ?? null;
      let decisionTradeId: string | null = null;
      if (action.kind === "open") {
        const openPositions = await transaction.position.count({
          where: {
            workspaceId: input.workspaceId,
            executionRunId: input.executionRunId,
            status: "OPEN",
          },
        });
        if (openPositions >= input.maxOpenPositions) {
          action = { kind: "none" };
          decision = {
            action: "SKIP",
            reasonCode: "MAX_OPEN_POSITIONS",
            summary: "Вход пропущен: достигнут лимит открытых позиций",
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
            trailingPrice: action.trailingPrice,
          },
        });
      } else if (action.kind === "open") {
        const position = await transaction.position.create({
          data: {
            workspaceId: input.workspaceId,
            executionRunId: input.executionRunId,
            strategyVersionId: input.strategyVersionId,
            symbol: input.symbol,
            environment: "DRY_RUN",
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
            markPrice: action.markPrice,
            unrealizedPnl: action.unrealizedPnl,
            openedAt: action.position.openedAt,
          },
          select: { id: true, entryFee: true },
        });
        decisionPositionId = position.id;
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
            quantity: true,
            entryPrice: true,
            entryFee: true,
            entryRegime: true,
            entrySession: true,
            openedAt: true,
          },
        });
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

      const persistedDecision = await transaction.decision.create({
        data: {
          workspaceId: input.workspaceId,
          executionRunId: input.executionRunId,
          strategyVersionId: input.strategyVersionId,
          positionId: decisionPositionId,
          tradeId: decisionTradeId,
          symbol: input.symbol,
          action: decision.action,
          reasonCode: decision.reasonCode,
          summary: decision.summary,
          factors: decision.factors,
          marketSnapshotRef: `market-candle:${input.symbol}:${input.interval}:${input.candleAt.toISOString()}`,
          correlationId,
          decidedAt: input.candleAt,
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
          pendingSignal: input.pendingSignal ?? Prisma.DbNull,
          lastDecisionId: persistedDecision.id,
        },
        update: {
          lastEvaluatedAt: input.candleAt,
          pendingSignal: input.pendingSignal ?? Prisma.DbNull,
          lastDecisionId: persistedDecision.id,
          lastFailureCode: null,
          lastFailureMessage: null,
          consecutiveFailures: 0,
        },
      });

      return { applied: true, decisionId: persistedDecision.id };
    });
  }

  public getManualCloseContext(workspaceId: string, positionId: string) {
    return this.prisma.position.findFirst({
      where: { id: positionId, workspaceId },
      select: {
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
  if (!tradeId) throw new RuntimeIdempotencyConflictError();
  return { positionId, tradeId, replayed: true };
}
