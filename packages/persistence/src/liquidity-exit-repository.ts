import type { Prisma, Position } from "./generated/prisma/client";
import {
  hashTracePayload,
  ensurePositionTrace,
  closePositionTrace,
  type PositionTraceOptions,
} from "./position-trace";
import { readExecutionInstrumentRules } from "../../application/src/execution-instrument";
import {
  readExecutionExitPolicy,
  isLiquidityExitPolicy,
  liquidityExitVersion,
} from "../../application/src/execution-exit-policy";
import {
  evaluateExecutionPriceExit,
  type ExecutionPosition,
  type ExecutionStrategyConfig,
} from "../../application/src/execution-engine";
import {
  initialLiquidityExitState,
  readLiquidityExitState,
  remainingExitQuantity,
  remainingExitEntryFee,
  prepareLiquidityExitOrder,
  liquidityExitPreparationFailure,
  evaluateLiquidityExitOrder,
  applyLiquidityExitFill,
  liquidityExitSettlement,
  exitDecimal,
  type ExitPositionBasis,
  type LiquidityExitState,
} from "./liquidity-exit-model";
import { consumedExecutionLiquidity } from "./liquidity-consumption";
import type { PersistRuntimeQuoteInput } from "./runtime-repository";
import type { RuntimeRiskPolicy } from "./runtime-risk";
import type { RuntimeMarketEntryPolicy } from "./runtime-entry-policy";

const json = (v: unknown) => v as Prisma.InputJsonValue;
export function liquidityExitBasis(p: Position): ExitPositionBasis {
  const policy = readExecutionExitPolicy(p.exitPolicy),
    rules = readExecutionInstrumentRules(p.instrumentRules);
  if (!isLiquidityExitPolicy(policy) || !rules)
    throw new Error("Liquidity exit requires pinned policy and instrument rules");
  return {
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    quantity: p.quantity.toFixed(),
    entryFee: p.entryFee.toFixed(),
    entrySlippage: p.entrySlippage.toFixed(),
    entryPrice: p.entryPrice.toFixed(),
    instrumentRules: rules,
    policy,
  };
}
export async function latchLiquidityExit(
  tx: Prisma.TransactionClient,
  p: Position,
  input: PersistRuntimeQuoteInput,
  options: {
    riskPolicy: RuntimeRiskPolicy;
    marketEntryPolicy: RuntimeMarketEntryPolicy;
    traceOptions: PositionTraceOptions;
    origin?: string;
  },
) {
  if (p.exitState) return { applied: false, closed: false };
  if (input.action.kind !== "close") throw new Error("Exit request is missing");
  const event = await tx.marketPriceEvent.findUniqueOrThrow({
    where: { id: input.processedPrice.eventId },
  });
  if (
    event.symbol !== p.symbol ||
    event.streamId !== input.processedPrice.streamId ||
    !event.price.eq(input.quotePrice) ||
    (p.priceEventId !== null && event.id < p.priceEventId)
  )
    throw new Error("Exit request does not match its durable event");
  if (
    +input.quoteAt !== Math.max(+event.observedAt, +(p.managedThroughAt ?? p.openedAt)) ||
    +input.processedPrice.throughAt !== +input.quoteAt
  )
    throw new Error("Exit request checkpoint time mismatch");
  const config = (
    await tx.strategyVersion.findUniqueOrThrow({
      where: { id: p.strategyVersionId },
      select: { config: true },
    })
  ).config as unknown as ExecutionStrategyConfig;
  const protection = input.action.protection;
  const pos: ExecutionPosition = {
    ...liquidityExitBasis(p),
    exitPolicy: liquidityExitBasis(p).policy,
    side: p.side === "BUY" ? "long" : "short",
    symbol: p.symbol,
    openedAt: p.openedAt,
    quantity: Number(p.remainingQuantity ?? p.quantity),
    entryPrice: Number(p.entryPrice),
    entryFee: Number(p.remainingEntryFee ?? p.entryFee),
    entrySlippage: Number(p.entrySlippage),
    stopPrice: Number(protection?.stopPrice ?? p.stopPrice),
    takePrice: Number(p.takePrice),
    trailingPrice: protection
      ? protection.trailingPrice === null
        ? null
        : Number(protection.trailingPrice)
      : (p.trailingPrice?.toNumber() ?? null),
    bestPrice: Number(protection?.bestPrice ?? p.bestPrice),
    entryRegime: p.entryRegime.toLowerCase() as ExecutionPosition["entryRegime"],
    entrySession: p.entrySession
      .toLowerCase()
      .replaceAll("_", "-") as ExecutionPosition["entrySession"],
  };
  if (["stop-loss", "take-profit", "trailing-stop"].includes(input.action.settlement.exitReason)) {
    const trigger = evaluateExecutionPriceExit(
      pos,
      {
        symbol: p.symbol,
        price: Number(event.price),
        observedAt: input.quoteAt,
        source: "LastPrice",
      },
      config,
    );
    if (trigger?.exitReason !== input.action.settlement.exitReason)
      throw new Error("Liquidity exit trigger mismatch");
  }
  await ensurePositionTrace(tx, {
    positionId: p.id,
    workspaceId: p.workspaceId,
    strategyVersionId: p.strategyVersionId,
    position: {
      ...p,
      ...liquidityExitBasis(p),
      side: p.side,
      entryRegime: p.entryRegime,
      entrySession: p.entrySession,
      stopPrice: p.stopPrice.toFixed(),
      takePrice: p.takePrice.toFixed(),
      trailingPrice: p.trailingPrice?.toFixed() ?? null,
      bestPrice: p.bestPrice.toFixed(),
      exitPolicy: p.exitPolicy,
    },
    eventId: p.priceEventId ?? event.id,
    streamId: p.priceStreamId,
    throughAt: p.managedThroughAt ?? p.openedAt,
    markPrice: (p.markPrice ?? p.entryPrice).toFixed(),
    signalCandleAt: p.signalCandleAt,
    indicatorState: p.indicatorState,
    profitProtectionState: p.profitProtection,
    fullFromEntry: false,
    riskPolicy: options.riskPolicy,
    marketEntryPolicy: options.marketEntryPolicy,
    options: options.traceOptions,
  });
  const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
  const state = initialLiquidityExitState(liquidityExitBasis(p), {
    reason: input.action.settlement.exitReason as LiquidityExitState["intent"]["reason"],
    requestedAt: now.toISOString(),
    triggerAt: event.observedAt.toISOString(),
    triggerEventId: String(event.id),
    triggerPrice: event.price.toFixed(),
    source: options.origin ?? "journal",
  });
  const payload = {
    quotePrice: input.quotePrice,
    quoteAt: input.quoteAt.toISOString(),
    action: {
      ...input.action,
      settlement: {
        ...input.action.settlement,
        closedAt: input.action.settlement.closedAt.toISOString(),
      },
    },
    profitProtectionState: input.profitProtection ?? p.profitProtection,
    signalCandleAt: input.signalCandleAt?.toISOString() ?? p.signalCandleAt?.toISOString() ?? null,
    inputs: input.traceInputs ?? null,
    state,
    basis: liquidityExitBasis(p),
    origin: options.origin ?? "journal",
    recordedAt: now.toISOString(),
  };
  await tx.positionTraceRecord.create({
    data: {
      positionId: p.id,
      runtimeVersion: p.runtimeVersion + 1,
      eventId: event.id,
      kind: "liquidity-trigger",
      payload: json(payload),
      payloadHash: hashTracePayload(payload),
    },
  });
  await tx.positionExecutionTrace.update({
    where: { positionId: p.id },
    data: {
      eventCount: {
        increment: BigInt(
          await tx.marketPriceEvent.count({
            where: { symbol: p.symbol, id: { gt: p.priceEventId ?? 0n, lte: event.id } },
          }),
        ),
      },
    },
  });
  await tx.position.update({
    where: { id: p.id },
    data: {
      exitState: json(state),
      remainingQuantity: p.remainingQuantity ?? p.quantity,
      remainingEntryFee: p.remainingEntryFee ?? p.entryFee,
      priceEventId: event.id,
      priceStreamId: event.streamId,
      managedThroughAt: input.quoteAt,
      markPrice: event.price,
      unrealizedPnl: exitDecimal(event.price.toFixed())
        .sub(p.entryPrice.toFixed())
        .mul((p.remainingQuantity ?? p.quantity).toFixed())
        .mul(p.side === "BUY" ? 1 : -1)
        .toDecimalPlaces(18)
        .toFixed(),
      runtimeVersion: { increment: 1 },
      ...protection,
      ...(input.profitProtection ? { profitProtection: input.profitProtection } : {}),
      ...(input.indicatorState ? { indicatorState: input.indicatorState } : {}),
      ...(input.signalCandleAt ? { signalCandleAt: input.signalCandleAt } : {}),
    },
  });
  const decision = await tx.decision.create({
    data: {
      workspaceId: p.workspaceId,
      executionRunId: p.executionRunId,
      strategyVersionId: p.strategyVersionId,
      positionId: p.id,
      symbol: p.symbol,
      action: "HOLD",
      reasonCode: "EXIT_REQUESTED",
      summary: "Закрытие запрошено; остаток позиции остаётся под защитой",
      factors: json({ reason: state.intent.reason, trigger: state.intent }),
      correlationId: `exit-request:${p.id}`,
      decidedAt: now,
    },
  });
  return { applied: true, closed: false, decisionId: decision.id };
}

export async function advanceLiquidityExit(
  tx: Prisma.TransactionClient,
  p: Position,
  exchangeAccountId: string,
) {
  let state = readLiquidityExitState(p.exitState);
  if (!state) return { applied: false, closed: false };
  const basis = liquidityExitBasis(p),
    before = structuredClone(state);
  if (
    state.positionId !== p.id ||
    !exitDecimal(state.originalQuantity).eq(p.quantity.toFixed()) ||
    !exitDecimal(remainingExitQuantity(state)).eq(
      p.remainingQuantity?.toFixed() ?? p.quantity.toFixed(),
    ) ||
    !exitDecimal(remainingExitEntryFee(state)).eq(
      p.remainingEntryFee?.toFixed() ?? p.entryFee.toFixed(),
    )
  )
    throw new Error("Exit state disagrees with position balance");
  const config = (
    await tx.strategyVersion.findUniqueOrThrow({
      where: { id: p.strategyVersionId },
      select: { config: true },
    })
  ).config as unknown as ExecutionStrategyConfig;
  const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
  const latest = await tx.marketPriceEvent.findFirst({
    where: { symbol: p.symbol },
    orderBy: { id: "desc" },
  });
  if (!latest) return { applied: false, closed: false };
  let event = latest,
    action: unknown,
    fill: ReturnType<typeof applyLiquidityExitFill> | null = null;
  let own = "0",
    publicConsumed = "0",
    scanned = 0;
  const cursor = p.priceEventId ?? 0n;
  if (!state.order) {
    const snapshot = prepareLiquidityExitOrder(
      basis,
      state,
      { ...latest, price: Number(latest.price) },
      now,
    );
    if (!snapshot) {
      const reason =
        liquidityExitPreparationFailure(
          basis,
          state,
          { ...latest, price: Number(latest.price) },
          now,
        ) ?? "EXIT_SIZE_UNAVAILABLE";
      if (latest.id === p.priceEventId && state.waitingReason === reason)
        return { applied: false, closed: false };
      state = { ...state, waitingReason: reason };
      action = { kind: "blocked", reason };
    } else {
      const order = await tx.order.create({
        data: {
          workspaceId: p.workspaceId,
          executionRunId: p.executionRunId,
          positionId: p.id,
          symbol: p.symbol,
          side: p.side === "BUY" ? "SELL" : "BUY",
          type: "MARKET",
          status: "OPEN",
          quantity: snapshot.ioc.quantity,
          expiresAt: new Date(snapshot.ioc.expiresAt),
          clientOrderId: `exit-ioc:${p.id}:${p.runtimeVersion}`,
          execution: json({ snapshot, hash: hashTracePayload(snapshot) }),
        },
      });
      state = { ...state, order: { id: order.id, snapshot }, waitingReason: null };
      action = { kind: "submit", orderId: order.id, snapshot };
    }
  } else {
    const active = state.order;
    const storedOrder = await tx.order.findUniqueOrThrow({ where: { id: active.id } });
    if (
      storedOrder.status !== "OPEN" ||
      hashTracePayload(active.snapshot) !==
        (storedOrder.execution as { hash?: string } | null)?.hash ||
      hashTracePayload((storedOrder.execution as { snapshot: unknown }).snapshot) !==
        hashTracePayload(active.snapshot)
    )
      throw new Error("Active exit order mismatch");
    const events = await tx.marketPriceEvent.findMany({
      where: {
        symbol: p.symbol,
        id: { gt: p.priceEventId ?? BigInt(active.snapshot.ioc.submitEventId) },
      },
      orderBy: { id: "asc" },
      take: 2000,
    });
    scanned = events.length;
    let result: ReturnType<typeof evaluateLiquidityExitOrder> = {
      kind: "wait",
      reason: "EXIT_WAITING_EVENT",
    };
    for (const candidate of events) {
      event = candidate;
      result = evaluateLiquidityExitOrder(active.snapshot, {
        ...candidate,
        price: Number(candidate.price),
      });
      if (result.kind === "wait") continue;
      if (result.kind === "fill") {
        ({ own, publicConsumed } = await consumedExecutionLiquidity(tx, {
          workspaceId: p.workspaceId,
          exchangeAccountId,
          sourceKey: result.sourceKey,
          order: active.snapshot.ioc,
          event: candidate,
        }));
        result = evaluateLiquidityExitOrder(
          active.snapshot,
          { ...candidate, price: Number(candidate.price) },
          own,
          publicConsumed,
        );
      }
      break;
    }
    if (
      result.kind === "wait" &&
      events.length < 2000 &&
      +now >= Date.parse(active.snapshot.ioc.expiresAt)
    )
      result = { kind: "cancel", reason: "EXIT_ORDER_EXPIRED" };
    if (result.kind === "wait" && (!events.length || event.id === p.priceEventId))
      return { applied: false, closed: false };
    if (!events.length) event = latest;
    if (result.kind === "fill") {
      fill = applyLiquidityExitFill(
        basis,
        state,
        result.price,
        result.quantity,
        config.costs.takerFeeBps,
        event.price.toFixed(),
      );
      state = fill.state;
    } else if (result.kind === "cancel")
      state = { ...state, order: null, waitingReason: result.reason };
    action = {
      kind: result.kind,
      orderId: active.id,
      result,
      own,
      publicConsumed,
      ...(fill ? { fill } : {}),
    };
    if (result.kind !== "wait") {
      const terminal = {
        reason: result.kind === "cancel" ? result.reason : "EXIT_IOC_FILLED",
        filledQuantity: result.kind === "fill" ? result.quantity : "0",
        cancelledQuantity: exitDecimal(active.snapshot.ioc.quantity)
          .sub(result.kind === "fill" ? result.quantity : "0")
          .toFixed(),
        at: now.toISOString(),
      };
      await tx.order.update({
        where: { id: active.id },
        data: {
          status:
            result.kind === "fill" && terminal.cancelledQuantity === "0" ? "FILLED" : "CANCELLED",
          execution: json({
            snapshot: active.snapshot,
            hash: hashTracePayload(active.snapshot),
            terminal,
          }),
        },
      });
      if (fill && result.kind === "fill") {
        const payload = {
          version: liquidityExitVersion,
          source: "dry-run-public-liquidity-exit",
          positionId: p.id,
          orderId: active.id,
          snapshot: active.snapshot,
          before,
          after: state,
          event: eventPayload(event),
          own,
          publicConsumed,
          sourceKey: result.sourceKey,
          sourceCapacity: result.sourceCapacity,
          quantity: result.quantity,
          price: result.price,
          role: "taker",
          fill,
        };
        await tx.fill.create({
          data: {
            workspaceId: p.workspaceId,
            orderId: active.id,
            quantity: result.quantity,
            price: result.price,
            fee: fill.exitFee,
            feeAsset: "USDT",
            filledAt: event.observedAt,
            realizedGrossPnl: fill.grossPnl,
            realizedNetPnl: fill.netPnl,
            entryFeeAllocated: fill.entryFee,
            execution: json({ payload, hash: hashTracePayload(payload) }),
          },
        });
      }
    }
  }
  const payload = {
    version: liquidityExitVersion,
    basis,
    before,
    after: state,
    event: eventPayload(event),
    now: now.toISOString(),
    scan: { cursor: String(cursor), latestEventId: String(latest.id), exhausted: scanned < 2000 },
    action,
  };
  await tx.positionTraceRecord.create({
    data: {
      positionId: p.id,
      runtimeVersion: p.runtimeVersion + 1,
      eventId: event.id,
      kind: "liquidity-step",
      payload: json(payload),
      payloadHash: hashTracePayload(payload),
    },
  });
  const count = await tx.marketPriceEvent.count({
    where: { symbol: p.symbol, id: { gt: p.priceEventId ?? 0n, lte: event.id } },
  });
  await tx.positionExecutionTrace.update({
    where: { positionId: p.id },
    data: { eventCount: { increment: BigInt(count) } },
  });
  const remaining = remainingExitQuantity(state),
    closed = exitDecimal(remaining).eq(0);
  const unrealized = exitDecimal(event.price.toFixed())
    .sub(p.entryPrice.toFixed())
    .mul(remaining)
    .mul(p.side === "BUY" ? 1 : -1)
    .toDecimalPlaces(18)
    .toFixed();
  await tx.position.update({
    where: { id: p.id },
    data: {
      remainingQuantity: remaining,
      remainingEntryFee: remainingExitEntryFee(state),
      realizedPnl: state.netPnl,
      unrealizedPnl: closed ? "0" : unrealized,
      exitState: json(state),
      priceEventId: event.id,
      priceStreamId: event.streamId,
      managedThroughAt: new Date(Math.max(+(p.managedThroughAt ?? p.openedAt), +event.observedAt)),
      markPrice: event.price,
      runtimeVersion: { increment: 1 },
      ...(closed ? { status: "CLOSED", closedAt: event.observedAt } : {}),
    },
  });
  if (closed) {
    const settlement = liquidityExitSettlement(state, event.observedAt);
    const trade = await tx.trade.create({
      data: {
        workspaceId: p.workspaceId,
        positionId: p.id,
        executionRunId: p.executionRunId,
        strategyVersionId: p.strategyVersionId,
        symbol: p.symbol,
        environment: "DRY_RUN",
        side: p.side,
        entryRegime: p.entryRegime,
        entrySession: p.entrySession,
        quantity: p.quantity,
        averageEntryPrice: p.entryPrice,
        averageExitPrice: settlement.exitPrice,
        grossPnl: settlement.grossPnl,
        netPnl: settlement.netPnl,
        fees: settlement.fees,
        slippage: settlement.slippage,
        funding: "0",
        exitReason: settlement.exitReason,
        openedAt: p.openedAt,
        closedAt: event.observedAt,
      },
    });
    await closePositionTrace(tx, p.id, settlement);
    await tx.decision.create({
      data: {
        workspaceId: p.workspaceId,
        executionRunId: p.executionRunId,
        strategyVersionId: p.strategyVersionId,
        positionId: p.id,
        tradeId: trade.id,
        symbol: p.symbol,
        action: "CLOSE",
        reasonCode: settlement.exitReason.toUpperCase().replaceAll("-", "_"),
        summary: "Позиция полностью закрыта",
        factors: json({ source: "liquidity-exit", state }),
        correlationId: `exit-complete:${p.id}`,
        decidedAt: now,
      },
    });
    await tx.runtimeCursor.updateMany({
      where: { executionRunId: p.executionRunId, symbol: p.symbol },
      data: { lastFailureCode: null, lastFailureMessage: null, consecutiveFailures: 0 },
    });
  } else if (fill)
    await tx.decision.create({
      data: {
        workspaceId: p.workspaceId,
        executionRunId: p.executionRunId,
        strategyVersionId: p.strategyVersionId,
        positionId: p.id,
        symbol: p.symbol,
        action: "HOLD",
        reasonCode: "EXIT_PARTIALLY_FILLED",
        summary: `Частично закрыто; осталось ${remaining}`,
        factors: json({ remainingQuantity: remaining, realizedPnl: state.netPnl }),
        correlationId: `exit-partial:${p.id}:${p.runtimeVersion}`,
        decidedAt: now,
      },
    });
  else if (state.waitingReason && state.waitingReason !== before.waitingReason)
    await tx.decision.create({
      data: {
        workspaceId: p.workspaceId,
        executionRunId: p.executionRunId,
        strategyVersionId: p.strategyVersionId,
        positionId: p.id,
        symbol: p.symbol,
        action: "HOLD",
        reasonCode: state.waitingReason,
        summary: "Закрытие ожидает подходящей ликвидности",
        factors: json({ remainingQuantity: remaining, reason: state.waitingReason }),
        correlationId: `exit-wait:${p.id}:${p.runtimeVersion}`,
        decidedAt: now,
      },
    });
  return { applied: true, closed };
}
export function eventPayload(event: {
  id: bigint;
  symbol: string;
  price: { toFixed(): string };
  observedAt: Date;
  receivedAt: Date;
  streamId: string;
  executionData: unknown;
}) {
  return {
    id: String(event.id),
    symbol: event.symbol,
    price: event.price.toFixed(),
    observedAt: event.observedAt.toISOString(),
    receivedAt: event.receivedAt.toISOString(),
    streamId: event.streamId,
    executionData: event.executionData,
  };
}
