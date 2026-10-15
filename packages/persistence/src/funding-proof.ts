import {
  executionFundingVersion,
  fundingAmount,
  fundingExposure,
  validateFundingDataset,
  allocateFunding,
  type ExecutionFundingDataset,
  type ExecutionFundingEvent,
} from "../../application/src/execution-funding";
import { hashTracePayload } from "./position-trace";
import { exitDecimal } from "./liquidity-exit-model";
import { readPositionFundingState, type PositionFundingState } from "./funding-repository";
export type FundingReplayBalance = {
  accrued: string;
  remaining: string;
  state: PositionFundingState;
  paid: Record<string, ExecutionFundingEvent>;
};
export type FundingExposureBasis = {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: string;
  openedAt: string;
};
export type FundingRecord = {
  version: string;
  positionId: string;
  targetAt: string;
  appliedAt: string;
  before: PositionFundingState;
  after: PositionFundingState;
  accruedBefore: string;
  accrued: string;
  remainingBefore: string;
  remaining: string;
  payments: Array<{
    event: ExecutionFundingEvent;
    quantity: string;
    amount: string;
    remainingApplied: string;
    closedAllocation: string;
  }>;
  exposure: {
    quantity: string;
    openedAt: string;
    exits: Array<{ quantity: string; filledAt: string }>;
  };
  snapshotId: string | null;
  snapshotHash: string | null;
  market: null | { observedAt: string; nextFundingAt: string; checkedThrough: string };
};
export type LoadFundingSnapshot = (
  id: string,
) => Promise<null | { payload: unknown; payloadHash: string }>;
const same = (a: unknown, b: unknown, label: string) => {
  if (hashTracePayload(a) !== hashTracePayload(b)) throw new Error(`Funding ${label} mismatch`);
};
export async function verifyFundingRecord(
  value: unknown,
  basis: FundingExposureBasis,
  balance: FundingReplayBalance,
  exits: FundingRecord["exposure"]["exits"],
  load?: LoadFundingSnapshot,
): Promise<FundingReplayBalance> {
  const p = value as FundingRecord;
  if (
    p.version !== executionFundingVersion ||
    p.positionId !== basis.id ||
    !Number.isFinite(Date.parse(p.targetAt)) ||
    !Number.isFinite(Date.parse(p.appliedAt)) ||
    Date.parse(p.targetAt) > Date.parse(p.appliedAt) + 1000
  )
    throw new Error("Invalid funding trace record");
  readPositionFundingState(p.before);
  readPositionFundingState(p.after);
  same(p.before, balance.state, "state chain");
  if (
    !exitDecimal(p.accruedBefore).eq(balance.accrued) ||
    !exitDecimal(p.remainingBefore).eq(balance.remaining)
  )
    throw new Error("Funding previous balance mismatch");
  same(
    p.exposure,
    { quantity: basis.quantity, openedAt: basis.openedAt, exits },
    "exposure timeline",
  );
  let data: ExecutionFundingDataset | null = null;
  if (p.snapshotId) {
    const source = load ? await load(p.snapshotId) : null;
    if (!source) throw new Error("Funding source snapshot is missing");
    if (
      hashTracePayload(source.payload) !== source.payloadHash ||
      source.payloadHash !== p.snapshotHash
    )
      throw new Error("Funding source checksum mismatch");
    data = source.payload as ExecutionFundingDataset;
    validateFundingDataset(
      data,
      [basis.symbol],
      new Date(basis.openedAt),
      new Date(Math.min(Date.parse(p.targetAt), Date.parse(data.throughAt))),
    );
  } else if (p.payments.length || p.after.status !== "pending")
    throw new Error("Funding data cannot be known without source history");
  const expected =
    data?.events
      .filter(
        (e) =>
          e.symbol === basis.symbol &&
          Date.parse(e.settledAt) > Date.parse(basis.openedAt) &&
          Date.parse(e.settledAt) <= Date.parse(p.targetAt) &&
          fundingExposure(p.exposure, e.settledAt) !== "0" &&
          !balance.paid[e.settledAt],
      )
      .sort((a, b) => Date.parse(a.settledAt) - Date.parse(b.settledAt)) ?? [];
  same(
    p.payments.map((e) => e.event),
    expected,
    "new payment coverage",
  );
  let accrued = exitDecimal(balance.accrued),
    remaining = exitDecimal(balance.remaining);
  const paid = { ...balance.paid };
  const currentQuantity = exits.reduce((q, e) => q.sub(e.quantity), exitDecimal(basis.quantity));
  for (const payment of p.payments) {
    const quantity = fundingExposure(p.exposure, payment.event.settledAt),
      amount = fundingAmount(basis.side === "BUY" ? "long" : "short", quantity, payment.event);
    const rem = exitDecimal(amount)
      .mul(currentQuantity)
      .div(quantity)
      .toDecimalPlaces(18, 1)
      .toFixed();
    if (
      payment.quantity !== quantity ||
      payment.amount !== amount ||
      payment.remainingApplied !== rem ||
      !exitDecimal(payment.closedAllocation).eq(exitDecimal(amount).sub(rem))
    )
      throw new Error("Funding cash flow mismatch");
    accrued = accrued.add(amount);
    remaining = remaining.add(rem);
    paid[payment.event.settledAt] = payment.event;
  }
  for (const event of data?.events ?? [])
    if (balance.paid[event.settledAt])
      same(event, balance.paid[event.settledAt], "settled event revision");
  if (!accrued.eq(p.accrued) || !remaining.eq(p.remaining))
    throw new Error("Funding ending balance mismatch");
  if (p.after.status === "ready") {
    if (
      !data ||
      !p.market ||
      p.after.throughAt !== p.targetAt ||
      Date.parse(p.appliedAt) - Date.parse(p.market.observedAt) > 120000 ||
      Date.parse(p.market.observedAt) > Date.parse(p.appliedAt) + 1000 ||
      p.market.checkedThrough !== data.throughAt ||
      p.after.nextFundingAt !== p.market.nextFundingAt ||
      (Date.parse(p.market.checkedThrough) < Date.parse(p.targetAt) &&
        Date.parse(p.market.nextFundingAt) <= Date.parse(p.targetAt))
    )
      throw new Error("Funding coverage is not confirmed");
    const expectedAt = Date.parse(balance.state.nextFundingAt);
    if (
      expectedAt > Date.parse(basis.openedAt) &&
      expectedAt <= Date.parse(p.targetAt) &&
      fundingExposure(p.exposure, balance.state.nextFundingAt) !== "0" &&
      !data.events.some((e) => Date.parse(e.settledAt) === expectedAt)
    )
      throw new Error("Expected funding settlement is missing");
  }
  return { accrued: accrued.toFixed(), remaining: remaining.toFixed(), state: p.after, paid };
}
export function verifyFundingAllocation(
  value: unknown,
  remaining: string,
  quantity: string,
  remainingQuantity: string,
) {
  const p = value as { before: string; allocated: string; remaining: string; accrued: string };
  if (
    !p ||
    !exitDecimal(p.before).eq(remaining) ||
    p.allocated !== allocateFunding(remaining, quantity, remainingQuantity) ||
    !exitDecimal(p.remaining).eq(exitDecimal(remaining).sub(p.allocated))
  )
    throw new Error("Funding exit allocation mismatch");
  return p;
}
