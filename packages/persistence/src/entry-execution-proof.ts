import { Prisma } from "./generated/prisma/client";
import { hashTracePayload } from "./position-trace";
import {
  evaluateExecutionEntryOrder,
  entryLiquidityVersion,
  readExecutionEntryOrder,
} from "../../application/src/execution-entry-liquidity";
import type { ExecutionStrategyConfig } from "../../application/src/execution-engine";

type Amount = string | { toFixed(): string };
const decimal = (value: Amount) =>
  new Prisma.Decimal(typeof value === "string" ? value : value.toFixed());
export function verifyEntryExecutionProof(
  order: {
    id: string;
    status: string;
    quantity: Amount;
    execution: unknown;
    fills: Array<{
      quantity: Amount;
      price: Amount;
      fee: Amount;
      filledAt: Date | string;
      execution: unknown;
    }>;
  },
  config: ExecutionStrategyConfig,
) {
  const envelope = order.execution as {
    snapshot: unknown;
    hash: string;
    terminal?: { filledQuantity?: string; cancelledQuantity?: string };
  };
  if (!envelope?.snapshot || envelope.hash !== hashTracePayload(envelope.snapshot))
    throw new Error("Entry order snapshot checksum mismatch");
  const snapshot = readExecutionEntryOrder(envelope.snapshot);
  if (!decimal(order.quantity).eq(snapshot.quantity))
    throw new Error("Entry order quantity mismatch");
  let filled = new Prisma.Decimal(0);
  for (const fill of order.fills) {
    const proof = fill.execution as {
      payload: {
        version: string;
        source: string;
        role: string;
        sourceKey: string;
        sourceCapacity: string;
        consumedQuantity: string;
        publicConsumedQuantity: string;
        orderId: string;
        event: {
          id: string;
          symbol: string;
          price: string;
          observedAt: string;
          receivedAt: string;
          streamId: string;
          executionData: unknown;
        };
      };
      hash: string;
    };
    if (!proof?.payload || proof.hash !== hashTracePayload(proof.payload))
      throw new Error("Entry fill checksum mismatch");
    const payload = proof.payload,
      event = payload.event;
    if (
      payload.version !== entryLiquidityVersion ||
      payload.source !== "dry-run-public-liquidity-model" ||
      payload.orderId !== order.id
    )
      throw new Error("Entry fill provenance mismatch");
    const result = evaluateExecutionEntryOrder(
      snapshot,
      {
        ...event,
        id: BigInt(event.id),
        price: Number(event.price),
        observedAt: new Date(event.observedAt),
        receivedAt: new Date(event.receivedAt),
      },
      new Prisma.Decimal(payload.consumedQuantity).add(payload.publicConsumedQuantity).toFixed(),
    );
    const quantity = decimal(fill.quantity),
      price = decimal(fill.price);
    if (
      result.kind !== "fill" ||
      !quantity.gt(0) ||
      quantity.gt(result.quantity) ||
      !price.eq(result.price) ||
      result.role !== payload.role ||
      result.sourceKey !== payload.sourceKey ||
      !new Prisma.Decimal(result.sourceCapacity).eq(payload.sourceCapacity) ||
      +new Date(fill.filledAt) !== Date.parse(event.observedAt)
    )
      throw new Error("Entry fill model mismatch");
    const fee = price
      .mul(quantity)
      .mul(result.role === "maker" ? config.costs.makerFeeBps : config.costs.takerFeeBps)
      .div(10000)
      .toDecimalPlaces(18);
    if (!fee.eq(decimal(fill.fee))) throw new Error("Entry fill fee mismatch");
    filled = filled.add(quantity);
  }
  const terminal = envelope.terminal;
  if (
    !terminal ||
    !filled.eq(terminal.filledQuantity ?? "0") ||
    !filled.add(terminal.cancelledQuantity ?? "0").eq(snapshot.quantity) ||
    (order.status === "FILLED" ? !filled.eq(snapshot.quantity) : order.status !== "CANCELLED") ||
    order.fills.length > 1
  )
    throw new Error("Entry terminal accounting mismatch");
  return {
    status: "matched" as const,
    model: entryLiquidityVersion,
    filledQuantity: filled.toFixed(),
    cancelledQuantity: new Prisma.Decimal(terminal.cancelledQuantity ?? "0").toFixed(),
    outcome: filled.isZero() ? "cancelled" : filled.eq(snapshot.quantity) ? "full" : "partial",
  };
}
