import { Prisma } from "./generated/prisma/client";
import {
  entryLiquidityVersion,
  evaluateExecutionEntryOrder,
  entryLiquidityBookFailure,
  readExecutionEntryOrder,
  type ExecutionEntryOrder,
  type EntryLiquidityEvent,
} from "../../application/src/execution-entry-liquidity";
import { readExecutionMarketData } from "../../application/src/execution-market-data";
import {
  roundExecutionStep,
  type ExecutionInstrumentRules,
} from "../../application/src/execution-instrument";
import {
  liquidityExitVersion,
  readExecutionExitPolicy,
  isLiquidityExitPolicy,
  type LiquidityExecutionExitPolicy,
} from "../../application/src/execution-exit-policy";
import type { ExecutionExitReason } from "../../application/src/execution-engine";

const D = Prisma.Decimal.clone({ precision: 80 });
export const exitDecimal = (value: string | number | { toFixed(): string }) =>
  new D(typeof value === "object" ? value.toFixed() : value);
export type LiquidityExitState = {
  version: typeof liquidityExitVersion;
  positionId: string;
  originalQuantity: string;
  originalEntryFee: string;
  originalEntrySlippage: string;
  closedQuantity: string;
  entryFeesAllocated: string;
  exitFees: string;
  grossPnl: string;
  netPnl: string;
  exitNotional: string;
  exitSlippage: string;
  intent: {
    reason: ExecutionExitReason;
    requestedAt: string;
    triggerAt: string;
    triggerEventId: string;
    triggerPrice: string;
    source: string;
  };
  order: null | { id: string; snapshot: LiquidityExitOrder };
  waitingReason: string | null;
};
export type LiquidityExitOrder = {
  version: typeof liquidityExitVersion;
  positionId: string;
  intent: LiquidityExitState["intent"];
  policy: LiquidityExecutionExitPolicy;
  ioc: ExecutionEntryOrder;
};
export type ExitPositionBasis = {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: string;
  entryFee: string;
  entrySlippage: string;
  entryPrice: string;
  instrumentRules: ExecutionInstrumentRules;
  policy: LiquidityExecutionExitPolicy;
};
export function initialLiquidityExitState(
  p: ExitPositionBasis,
  intent: LiquidityExitState["intent"],
): LiquidityExitState {
  return {
    version: liquidityExitVersion,
    positionId: p.id,
    originalQuantity: p.quantity,
    originalEntryFee: p.entryFee,
    originalEntrySlippage: p.entrySlippage,
    closedQuantity: "0",
    entryFeesAllocated: "0",
    exitFees: "0",
    grossPnl: "0",
    netPnl: "0",
    exitNotional: "0",
    exitSlippage: "0",
    intent,
    order: null,
    waitingReason: null,
  };
}
export function readLiquidityExitState(value: unknown): LiquidityExitState | null {
  if (value == null) return null;
  const s = value as LiquidityExitState;
  if (
    s.version !== liquidityExitVersion ||
    !s.positionId ||
    !s.intent ||
    !s.intent.reason ||
    !Number.isFinite(Date.parse(s.intent.requestedAt)) ||
    !Number.isFinite(Date.parse(s.intent.triggerAt)) ||
    !/^[1-9]\d*$/.test(s.intent.triggerEventId)
  )
    throw new Error("Invalid liquidity exit state");
  for (const key of [
    "originalQuantity",
    "originalEntryFee",
    "originalEntrySlippage",
    "closedQuantity",
    "entryFeesAllocated",
    "exitFees",
    "grossPnl",
    "netPnl",
    "exitNotional",
    "exitSlippage",
  ] as const)
    if (!exitDecimal(s[key]).isFinite()) throw new Error("Invalid exit amount");
  if (
    !exitDecimal(s.originalQuantity).gt(0) ||
    exitDecimal(s.closedQuantity).lt(0) ||
    exitDecimal(s.closedQuantity).gt(s.originalQuantity) ||
    exitDecimal(s.entryFeesAllocated).lt(0) ||
    exitDecimal(s.entryFeesAllocated).gt(s.originalEntryFee)
  )
    throw new Error("Invalid exit remaining quantity or fee");
  for (const key of [
    "originalEntryFee",
    "originalEntrySlippage",
    "exitFees",
    "exitNotional",
    "exitSlippage",
  ] as const)
    if (exitDecimal(s[key]).lt(0)) throw new Error("Negative exit amount");
  if (s.order) readExecutionEntryOrder(s.order.snapshot.ioc);
  if (
    s.order &&
    (s.order.snapshot.version !== liquidityExitVersion ||
      s.order.snapshot.positionId !== s.positionId ||
      !isLiquidityExitPolicy(readExecutionExitPolicy(s.order.snapshot.policy)))
  )
    throw new Error("Invalid exit order state");
  return s;
}
export function remainingExitQuantity(s: LiquidityExitState) {
  return exitDecimal(s.originalQuantity).sub(s.closedQuantity).toFixed();
}
export function remainingExitEntryFee(s: LiquidityExitState) {
  return exitDecimal(s.originalEntryFee).sub(s.entryFeesAllocated).toFixed();
}

export function liquidityExitPreparationFailure(
  p: ExitPositionBasis,
  s: LiquidityExitState,
  event: EntryLiquidityEvent,
  now: Date,
): string | null {
  const policy = p.policy;
  if (s.order || !exitDecimal(remainingExitQuantity(s)).gt(0)) return "EXIT_NO_REMAINING_REQUEST";
  const failure = entryLiquidityBookFailure(event, { ...policy, makerParticipationBps: 1000 });
  if (failure) return failure.replace(/^ENTRY_/, "EXIT_");
  const data = readExecutionMarketData(event.executionData),
    book = data.book!;
  if (
    [+event.observedAt, +event.receivedAt, book.observedAt, book.receivedAt].some(
      (t) => t > +now + 1000,
    )
  )
    return "EXIT_BOOK_FROM_FUTURE";
  if (
    [+event.observedAt, +event.receivedAt, book.observedAt, book.receivedAt].some(
      (t) => +now - t > policy.maximumBookAgeMs,
    )
  )
    return "EXIT_BOOK_STALE";
  return null;
}
export function prepareLiquidityExitOrder(
  p: ExitPositionBasis,
  s: LiquidityExitState,
  event: EntryLiquidityEvent,
  now: Date,
): LiquidityExitOrder | null {
  const policy = p.policy;
  if (liquidityExitPreparationFailure(p, s, event, now)) return null;
  const book = readExecutionMarketData(event.executionData).book!;
  const quantity = roundExecutionStep(
    D.min(remainingExitQuantity(s), p.instrumentRules.maxMarketOrderQty).toFixed(),
    p.instrumentRules.qtyStep,
    "floor",
  );
  if (!exitDecimal(quantity).gt(0)) return null;
  const placement = event.executionData as ExecutionEntryOrder["placementData"];
  const ioc: ExecutionEntryOrder = {
    version: entryLiquidityVersion,
    symbol: p.symbol,
    side: p.side === "BUY" ? "short" : "long",
    timeInForce: "IOC",
    quantity,
    limitPrice: null,
    signalPrice: s.intent.triggerPrice,
    decisionPrice: String(event.price),
    submitReferencePrice: p.side === "BUY" ? book.bid[0] : book.ask[0],
    submittedAt: now.toISOString(),
    expiresAt: new Date(+now + policy.orderTtlMs).toISOString(),
    submitEventId: String(event.id),
    streamId: event.streamId,
    instrumentRules: p.instrumentRules,
    policy: {
      maximumSpreadBps: policy.maximumSpreadBps,
      maximumSlippageBps: policy.maximumSlippageBps,
      maximumBookAgeMs: policy.maximumBookAgeMs,
      makerParticipationBps: 1000,
    },
    placementData: placement,
  };
  return { version: liquidityExitVersion, positionId: p.id, intent: s.intent, policy, ioc };
}
export function evaluateLiquidityExitOrder(
  order: LiquidityExitOrder,
  event: EntryLiquidityEvent,
  own = "0",
  publicConsumed = "0",
) {
  if (event.streamId !== order.ioc.streamId)
    return { kind: "cancel" as const, reason: "EXIT_ORDER_STREAM_CHANGED" };
  const result = evaluateExecutionEntryOrder(
    order.ioc,
    event,
    exitDecimal(own).add(publicConsumed).toFixed(),
  );
  return result.kind === "fill"
    ? result
    : { ...result, reason: result.reason.replace(/^ENTRY_/, "EXIT_") };
}
export function applyLiquidityExitFill(
  p: ExitPositionBasis,
  s: LiquidityExitState,
  price: string,
  quantity: string,
  feeBps: number,
  reference: string,
) {
  if (
    ![price, reference].every(
      (value) => exitDecimal(value).isFinite() && exitDecimal(value).gt(0),
    ) ||
    !Number.isFinite(feeBps) ||
    feeBps < 0 ||
    feeBps >= 10000
  )
    throw new Error("Invalid exit fill price or fee");
  const q = exitDecimal(quantity),
    remaining = exitDecimal(remainingExitQuantity(s));
  if (
    !q.gt(0) ||
    q.gt(remaining) ||
    roundExecutionStep(quantity, p.instrumentRules.qtyStep, "floor") !== q.toFixed()
  )
    throw new Error("Invalid exit fill quantity");
  const entryFee = q.eq(remaining)
    ? exitDecimal(remainingExitEntryFee(s))
    : D.min(
        remainingExitEntryFee(s),
        exitDecimal(s.originalEntryFee).mul(q).div(s.originalQuantity).toDecimalPlaces(18),
      );
  const exitFee = exitDecimal(price).mul(q).mul(feeBps).div(10000).toDecimalPlaces(18);
  const gross = exitDecimal(price)
    .sub(p.entryPrice)
    .mul(q)
    .mul(p.side === "BUY" ? 1 : -1)
    .toDecimalPlaces(18);
  const net = gross.sub(entryFee).sub(exitFee).toDecimalPlaces(18);
  const next: LiquidityExitState = {
    ...s,
    closedQuantity: exitDecimal(s.closedQuantity).add(q).toFixed(),
    entryFeesAllocated: exitDecimal(s.entryFeesAllocated).add(entryFee).toFixed(),
    exitFees: exitDecimal(s.exitFees).add(exitFee).toFixed(),
    grossPnl: exitDecimal(s.grossPnl).add(gross).toFixed(),
    netPnl: exitDecimal(s.netPnl).add(net).toFixed(),
    exitNotional: exitDecimal(s.exitNotional)
      .add(exitDecimal(price).mul(q))
      .toDecimalPlaces(18)
      .toFixed(),
    exitSlippage: exitDecimal(s.exitSlippage)
      .add(exitDecimal(price).sub(reference).abs().mul(q))
      .toDecimalPlaces(18)
      .toFixed(),
    order: null,
    waitingReason: null,
  };
  return {
    state: next,
    grossPnl: gross.toFixed(),
    netPnl: net.toFixed(),
    entryFee: entryFee.toFixed(),
    exitFee: exitFee.toFixed(),
    remainingQuantity: remainingExitQuantity(next),
    remainingEntryFee: remainingExitEntryFee(next),
  };
}
export function liquidityExitSettlement(s: LiquidityExitState, closedAt: Date) {
  if (!exitDecimal(remainingExitQuantity(s)).eq(0)) throw new Error("Exit is not fully filled");
  return {
    exitPrice: exitDecimal(s.exitNotional).div(s.originalQuantity).toDecimalPlaces(18).toFixed(),
    grossPnl: s.grossPnl,
    netPnl: s.netPnl,
    fees: exitDecimal(s.originalEntryFee).add(s.exitFees).toFixed(),
    slippage: exitDecimal(s.originalEntrySlippage).add(s.exitSlippage).toFixed(),
    exitReason: s.intent.reason,
    closedAt,
  };
}
