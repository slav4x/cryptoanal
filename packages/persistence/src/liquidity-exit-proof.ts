import { verifyFundingAllocation } from "./funding-proof";
import type { ExecutionStrategyConfig } from "../../application/src/execution-engine";
import { liquidityExitVersion } from "../../application/src/execution-exit-policy";
import { hashTracePayload } from "./position-trace";
import {
  applyLiquidityExitFill,
  evaluateLiquidityExitOrder,
  exitDecimal,
  liquidityExitPreparationFailure,
  prepareLiquidityExitOrder,
  readLiquidityExitState,
  type ExitPositionBasis,
  type LiquidityExitOrder,
  type LiquidityExitState,
} from "./liquidity-exit-model";

export type ExitReceiptEvent = {
  id: string;
  symbol: string;
  price: string;
  observedAt: string;
  receivedAt: string;
  streamId: string;
  executionData: unknown;
};
type ExitResult = ReturnType<typeof evaluateLiquidityExitOrder>;
type AppliedFill = ReturnType<typeof applyLiquidityExitFill>;
export type LiquidityExitStep = {
  version: typeof liquidityExitVersion;
  basis: ExitPositionBasis;
  before: LiquidityExitState;
  after: LiquidityExitState;
  event: ExitReceiptEvent;
  now: string;
  fundingAllocation?: { before: string; allocated: string; remaining: string; accrued: string };
  scan: { cursor: string; latestEventId: string; exhausted: boolean };
  action:
    | { kind: "submit"; orderId: string; snapshot: LiquidityExitOrder }
    | { kind: "blocked"; reason: string }
    | {
        kind: "fill" | "cancel" | "wait";
        orderId: string;
        result: ExitResult;
        own: string;
        publicConsumed: string;
        fill?: AppliedFill;
      };
};
export function exitReceiptEvent(e: ExitReceiptEvent) {
  if (
    !/^[1-9]\d*$/.test(e.id) ||
    ![e.observedAt, e.receivedAt].every((t) => Number.isFinite(Date.parse(t))) ||
    !exitDecimal(e.price).gt(0)
  )
    throw new Error("Invalid liquidity receipt event");
  return {
    ...e,
    id: BigInt(e.id),
    price: Number(e.price),
    observedAt: new Date(e.observedAt),
    receivedAt: new Date(e.receivedAt),
  };
}
const same = (actual: unknown, expected: unknown, label: string) => {
  if (hashTracePayload(actual) !== hashTracePayload(expected))
    throw new Error(`Liquidity exit ${label} mismatch`);
};
export function verifyLiquidityExitStep(
  value: unknown,
  config: ExecutionStrategyConfig,
  basis?: ExitPositionBasis,
  before?: LiquidityExitState,
) {
  const s = value as LiquidityExitStep;
  if (s.version !== liquidityExitVersion || !s.basis || !Number.isFinite(Date.parse(s.now)))
    throw new Error("Invalid liquidity exit step");
  readLiquidityExitState(s.before);
  readLiquidityExitState(s.after);
  if (basis) same(s.basis, basis, "basis");
  if (before) same(s.before, before, "state chain");
  if (
    s.basis.id !== s.before.positionId ||
    s.basis.quantity !== s.before.originalQuantity ||
    s.basis.entryFee !== s.before.originalEntryFee ||
    s.basis.entrySlippage !== s.before.originalEntrySlippage
  )
    throw new Error("Liquidity exit position mismatch");
  const event = exitReceiptEvent(s.event),
    now = new Date(s.now),
    a = s.action;
  if (event.symbol !== s.basis.symbol || +now < Date.parse(s.before.intent.requestedAt))
    throw new Error("Liquidity exit event or clock mismatch");
  let expected: LiquidityExitState;
  if (a.kind === "submit") {
    const order = prepareLiquidityExitOrder(s.basis, s.before, event, now);
    if (!order || !a.orderId) throw new Error("Liquidity exit submission invalid");
    same(a.snapshot, order, "order snapshot");
    expected = { ...s.before, order: { id: a.orderId, snapshot: order }, waitingReason: null };
  } else if (a.kind === "blocked") {
    const reason =
      liquidityExitPreparationFailure(s.basis, s.before, event, now) ??
      (prepareLiquidityExitOrder(s.basis, s.before, event, now) ? null : "EXIT_SIZE_UNAVAILABLE");
    if (reason !== a.reason) throw new Error("Liquidity exit block reason mismatch");
    expected = { ...s.before, waitingReason: reason };
  } else {
    const active = s.before.order;
    if (!active || active.id !== a.orderId) throw new Error("Liquidity exit active order mismatch");
    for (const quantity of [a.own, a.publicConsumed])
      if (!exitDecimal(quantity).isFinite() || exitDecimal(quantity).lt(0))
        throw new Error("Invalid exit consumed liquidity");
    let result: ExitResult =
      event.id > BigInt(s.scan.cursor)
        ? evaluateLiquidityExitOrder(active.snapshot, event, a.own, a.publicConsumed)
        : { kind: "wait", reason: "EXIT_WAITING_EVENT" };
    if (
      result.kind === "wait" &&
      s.scan.exhausted &&
      +now >= Date.parse(active.snapshot.ioc.expiresAt)
    )
      result = { kind: "cancel", reason: "EXIT_ORDER_EXPIRED" };
    same(a.result, result, "evaluation");
    if (result.kind !== a.kind) throw new Error("Liquidity exit action mismatch");
    if (result.kind === "fill") {
      const applied = applyLiquidityExitFill(
        s.basis,
        s.before,
        result.price,
        result.quantity,
        config.costs.takerFeeBps,
        s.event.price,
      );
      same(a.fill, applied, "accounting");
      expected = applied.state;
      if (s.fundingAllocation) {
        verifyFundingAllocation(
          s.fundingAllocation,
          s.fundingAllocation.before,
          result.quantity,
          exitDecimal(s.before.originalQuantity).sub(s.before.closedQuantity).toFixed(),
        );
        if (applied.remainingQuantity === "0" && s.after.waitingReason === "EXIT_WAITING_FUNDING")
          expected = { ...expected, waitingReason: "EXIT_WAITING_FUNDING" };
      }
    } else
      expected =
        result.kind === "cancel"
          ? { ...s.before, order: null, waitingReason: result.reason }
          : s.before;
  }
  same(s.after, expected, "remaining balance");
  return { state: expected, step: s, status: "matched" as const };
}
export function verifyLiquidityExitFill(
  fill: {
    quantity: string | { toFixed(): string };
    price: string | { toFixed(): string };
    fee: string | { toFixed(): string };
    realizedGrossPnl: string | { toFixed(): string } | null;
    realizedNetPnl: string | { toFixed(): string } | null;
    entryFeeAllocated: string | { toFixed(): string } | null;
    filledAt: Date;
    fundingAllocated?: string | { toFixed(): string } | null;
    execution: unknown;
  },
  config: ExecutionStrategyConfig,
  basis: ExitPositionBasis,
) {
  const receipt = fill.execution as {
    hash: string;
    payload: {
      version: string;
      source: string;
      positionId: string;
      orderId: string;
      snapshot: LiquidityExitOrder;
      before: LiquidityExitState;
      after: LiquidityExitState;
      event: ExitReceiptEvent;
      own: string;
      publicConsumed: string;
      sourceKey: string;
      sourceCapacity: string;
      quantity: string;
      price: string;
      role: string;
      fundingAllocation?: { before: string; allocated: string; remaining: string; accrued: string };
      fill: AppliedFill;
    };
  };
  if (!receipt || hashTracePayload(receipt.payload) !== receipt.hash)
    throw new Error("Liquidity exit receipt checksum mismatch");
  const p = receipt.payload;
  if (
    p.version !== liquidityExitVersion ||
    p.source !== "dry-run-public-liquidity-exit" ||
    p.positionId !== basis.id ||
    p.before.order?.id !== p.orderId
  )
    throw new Error("Invalid liquidity exit receipt");
  same(p.snapshot, p.before.order.snapshot, "fill snapshot");
  same(p.snapshot.policy, basis.policy, "fill policy");
  const result = evaluateLiquidityExitOrder(
    p.snapshot,
    exitReceiptEvent(p.event),
    p.own,
    p.publicConsumed,
  );
  if (
    result.kind !== "fill" ||
    result.sourceKey !== p.sourceKey ||
    result.sourceCapacity !== p.sourceCapacity ||
    result.quantity !== p.quantity ||
    result.price !== p.price ||
    result.role !== p.role
  )
    throw new Error("Liquidity exit fill source mismatch");
  const applied = applyLiquidityExitFill(
    basis,
    p.before,
    result.price,
    result.quantity,
    config.costs.takerFeeBps,
    p.event.price,
  );
  same(p.fill, applied, "fill accounting");
  const expected =
    p.fundingAllocation &&
    applied.remainingQuantity === "0" &&
    p.after.waitingReason === "EXIT_WAITING_FUNDING"
      ? { ...applied.state, waitingReason: "EXIT_WAITING_FUNDING" }
      : applied.state;
  same(p.after, expected, "fill balance");
  if (p.fundingAllocation) {
    const allocation = verifyFundingAllocation(
      p.fundingAllocation,
      p.fundingAllocation.before,
      result.quantity,
      exitDecimal(p.before.originalQuantity).sub(p.before.closedQuantity).toFixed(),
    );
    if (
      fill.fundingAllocated == null ||
      !exitDecimal(fill.fundingAllocated).eq(allocation.allocated)
    )
      throw new Error("Funding allocation column mismatch");
  }
  for (const [actual, expected] of [
    [fill.quantity, result.quantity],
    [fill.price, result.price],
    [fill.fee, applied.exitFee],
    [fill.realizedGrossPnl, applied.grossPnl],
    [fill.realizedNetPnl, applied.netPnl],
    [fill.entryFeeAllocated, applied.entryFee],
  ] as const)
    if (actual === null || !exitDecimal(actual).eq(expected))
      throw new Error("Liquidity exit stored fill mismatch");
  if (+fill.filledAt !== Date.parse(p.event.observedAt))
    throw new Error("Liquidity exit fill time mismatch");
  return {
    status: "matched" as const,
    quantity: result.quantity,
    netPnl: applied.netPnl,
    remainingQuantity: applied.remainingQuantity,
  };
}
