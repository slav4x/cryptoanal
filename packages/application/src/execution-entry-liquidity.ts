import {
  readExecutionMarketData,
  executionBookFailure,
  type StoredExecutionMarketData,
} from "./execution-market-data";
import {
  compareExecutionDecimals as cmp,
  executionDecimalProduct as mul,
  executionDecimalSum as add,
  roundExecutionStep,
  readExecutionInstrumentRules,
  type ExecutionInstrumentRules,
} from "./execution-instrument";
import { readExecutionExitPolicy, type ExecutionExitPolicy } from "./execution-exit-policy";

export const entryLiquidityVersion = "cryptoanal-entry-liquidity@1";
export type ExecutionEntryLiquidityPolicy = {
  maximumSpreadBps: number;
  maximumSlippageBps: number;
  maximumBookAgeMs: number;
  makerParticipationBps: number;
};
export const defaultEntryLiquidityPolicy: ExecutionEntryLiquidityPolicy = {
  maximumSpreadBps: 20,
  maximumSlippageBps: 50,
  maximumBookAgeMs: 1000,
  makerParticipationBps: 1000,
};
export type EntryExecutionMarker = {
  version: typeof entryLiquidityVersion;
  orderId: string;
  requestedQuantity: string;
};
export type ExecutionEntryOrder = {
  exitPolicy?: ExecutionExitPolicy;
  version: typeof entryLiquidityVersion;
  symbol: string;
  side: "long" | "short";
  timeInForce: "IOC" | "PostOnly";
  quantity: string;
  limitPrice: string | null;
  signalPrice: string;
  decisionPrice: string;
  submitReferencePrice: string;
  submittedAt: string;
  expiresAt: string;
  submitEventId: string;
  streamId: string;
  instrumentRules: ExecutionInstrumentRules;
  policy: ExecutionEntryLiquidityPolicy;
  placementData: StoredExecutionMarketData;
};
export type EntryLiquidityEvent = {
  id: bigint;
  symbol: string;
  price: number;
  observedAt: Date;
  receivedAt: Date;
  streamId: string;
  executionData?: unknown;
};
export type EntryLiquidityResult =
  | { kind: "wait" | "cancel"; reason: string }
  | {
      kind: "fill";
      price: string;
      quantity: string;
      role: "maker" | "taker";
      sourceKey: string;
      sourceCapacity: string;
    };

export function readEntryExecutionMarker(value: unknown): EntryExecutionMarker | null {
  if (value == null) return null;
  const marker = value as EntryExecutionMarker;
  if (
    marker.version !== entryLiquidityVersion ||
    typeof marker.orderId !== "string" ||
    !marker.orderId ||
    typeof marker.requestedQuantity !== "string" ||
    !/^\d+(?:\.\d{1,18})?$/.test(marker.requestedQuantity) ||
    cmp(marker.requestedQuantity, "0") <= 0
  )
    throw new Error("Invalid entry execution marker");
  return marker;
}
export function readExecutionEntryOrder(value: unknown): ExecutionEntryOrder {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid execution entry order");
  const order = value as ExecutionEntryOrder;
  const positive = (part: unknown) =>
    typeof part === "string" && /^\d+(?:\.\d{1,18})?$/.test(part) && cmp(part, "0") > 0;
  if (
    order.version !== entryLiquidityVersion ||
    !order.symbol ||
    !["long", "short"].includes(order.side) ||
    !["IOC", "PostOnly"].includes(order.timeInForce) ||
    !positive(order.quantity) ||
    !positive(order.signalPrice) ||
    !positive(order.decisionPrice) ||
    !positive(order.submitReferencePrice) ||
    (order.timeInForce === "PostOnly" ? !positive(order.limitPrice) : order.limitPrice !== null) ||
    !Number.isFinite(Date.parse(order.submittedAt)) ||
    !Number.isFinite(Date.parse(order.expiresAt)) ||
    Date.parse(order.expiresAt) <= Date.parse(order.submittedAt) ||
    !/^[1-9]\d*$/.test(order.submitEventId) ||
    !order.streamId
  )
    throw new Error("Invalid execution entry order");
  const p = order.policy;
  if (
    !p ||
    ![p.maximumSpreadBps, p.maximumSlippageBps, p.maximumBookAgeMs, p.makerParticipationBps].every(
      Number.isFinite,
    ) ||
    p.maximumSpreadBps < 0 ||
    p.maximumSpreadBps > 10000 ||
    p.maximumSlippageBps < 0 ||
    p.maximumSlippageBps >= 10000 ||
    p.maximumBookAgeMs < 1 ||
    p.makerParticipationBps <= 0 ||
    p.makerParticipationBps > 10000
  )
    throw new Error("Invalid entry liquidity policy");
  if (readExecutionInstrumentRules(order.instrumentRules)?.symbol !== order.symbol)
    throw new Error("Invalid entry instrument snapshot");
  readExecutionMarketData(order.placementData);
  readExecutionExitPolicy(order.exitPolicy);
  return order;
}
export function entryLiquidityBookFailure(
  event: EntryLiquidityEvent,
  policy: ExecutionEntryLiquidityPolicy,
): string | null {
  if (!event.executionData) return "ENTRY_BOOK_UNAVAILABLE";
  const data = readExecutionMarketData(event.executionData);
  const failure = executionBookFailure(data, event, policy.maximumBookAgeMs);
  if (failure) return `ENTRY_${failure}`;
  const book = data.book!;
  return cmp(
    mul(add(book.ask[0], mul(book.bid[0], -1)), 20000),
    mul(add(book.ask[0], book.bid[0]), policy.maximumSpreadBps),
  ) > 0
    ? "ENTRY_SPREAD_LIMIT"
    : null;
}
export function entryPostOnlyCrosses(order: ExecutionEntryOrder): boolean {
  const book = readExecutionMarketData(order.placementData).book;
  return (
    !!book &&
    order.timeInForce === "PostOnly" &&
    (order.side === "long"
      ? cmp(order.limitPrice!, book.ask[0]) >= 0
      : cmp(order.limitPrice!, book.bid[0]) <= 0)
  );
}
export function evaluateExecutionEntryOrder(
  order: ExecutionEntryOrder,
  event: EntryLiquidityEvent,
  consumedQuantity = "0",
): EntryLiquidityResult {
  if (!/^\d+(?:\.\d{1,18})?$/.test(consumedQuantity) || cmp(consumedQuantity, "0") < 0)
    throw new Error("Invalid consumed liquidity");
  if (event.symbol !== order.symbol) throw new Error("Entry symbol mismatch");
  if (event.id <= BigInt(order.submitEventId))
    return { kind: "wait", reason: "ENTRY_BEFORE_SUBMISSION" };
  if (
    +event.observedAt >= Date.parse(order.expiresAt) ||
    +event.receivedAt >= Date.parse(order.expiresAt)
  )
    return { kind: "cancel", reason: "ENTRY_SIGNAL_EXPIRED" };
  if (event.streamId !== order.streamId)
    return { kind: "cancel", reason: "ENTRY_ORDER_STREAM_CHANGED" };
  if (
    +event.observedAt < Date.parse(order.submittedAt) ||
    +event.receivedAt < Date.parse(order.submittedAt)
  )
    return { kind: "wait", reason: "ENTRY_BEFORE_SUBMISSION" };
  const fail = (reason: string): EntryLiquidityResult => ({
    kind: order.timeInForce === "IOC" ? "cancel" : "wait",
    reason,
  });
  const bookFailure = entryLiquidityBookFailure(event, order.policy);
  if (bookFailure) return fail(bookFailure);
  const data = readExecutionMarketData(event.executionData),
    book = data.book!;
  if (
    order.timeInForce === "IOC" &&
    (book.observedAt < Date.parse(order.submittedAt) ||
      book.receivedAt < Date.parse(order.submittedAt))
  )
    return { kind: "wait", reason: "ENTRY_BOOK_AFTER_SUBMISSION_REQUIRED" };
  let price: string, capacity: string, sourceKey: string;
  if (order.timeInForce === "PostOnly") {
    if (data.trade.blockTrade === true || data.trade.rpiTrade === true)
      return { kind: "wait", reason: "ENTRY_SPECIAL_TRADE_EXCLUDED" };
    if (
      order.side === "long"
        ? data.trade.takerSide !== "Sell" || cmp(event.price, order.limitPrice!) >= 0
        : data.trade.takerSide !== "Buy" || cmp(event.price, order.limitPrice!) <= 0
    )
      return { kind: "wait", reason: "ENTRY_MAKER_TRADE_THROUGH_REQUIRED" };
    price = order.limitPrice!;
    capacity = mul(data.trade.quantity, mul(order.policy.makerParticipationBps, "0.0001"));
    sourceKey = `${event.streamId}:${order.symbol}:trade:${event.id}`;
  } else {
    [price, capacity] = order.side === "long" ? book.ask : book.bid;
    const bound = mul(
      order.submitReferencePrice,
      add(1, mul(order.policy.maximumSlippageBps, order.side === "long" ? "0.0001" : "-0.0001")),
    );
    if (order.side === "long" ? cmp(price, bound) > 0 : cmp(price, bound) < 0)
      return { kind: "cancel", reason: "ENTRY_SLIPPAGE_LIMIT" };
    // A pre-trade snapshot may still contain the liquidity consumed by this public trade.
    if (
      data.trade.blockTrade !== true &&
      data.trade.rpiTrade !== true &&
      (order.side === "long"
        ? data.trade.takerSide === "Buy" && cmp(event.price, price) >= 0
        : data.trade.takerSide === "Sell" && cmp(event.price, price) <= 0)
    )
      capacity = add(capacity, mul(data.trade.quantity, -1));
    sourceKey = `${event.streamId}:${order.symbol}:book:${book.updateId}:${order.side}`;
  }
  const available = add(capacity, mul(consumedQuantity, -1));
  if (cmp(available, "0") <= 0) return fail("ENTRY_LIQUIDITY_UNAVAILABLE");
  const quantity = roundExecutionStep(
    cmp(available, order.quantity) < 0 ? available : order.quantity,
    order.instrumentRules.qtyStep,
    "floor",
  );
  if (cmp(quantity, "0") <= 0) return fail("ENTRY_LIQUIDITY_UNAVAILABLE");
  return {
    kind: "fill",
    price,
    quantity,
    role: order.timeInForce === "IOC" ? "taker" : "maker",
    sourceKey,
    sourceCapacity: capacity,
  };
}
