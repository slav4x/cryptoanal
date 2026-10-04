import { Prisma } from "./generated/prisma/client";

export type RuntimeMarketEntryPolicy = { ttlMs: number; maxDeviationBps: number };
export const defaultRuntimeMarketEntryPolicy: RuntimeMarketEntryPolicy = {
  ttlMs: 60_000,
  maxDeviationBps: 50,
};

export function runtimeEntryExpiresAt(
  orderType: "MARKET" | "LIMIT",
  detectedAt: Date,
  expiresAt: Date,
  policy = defaultRuntimeMarketEntryPolicy,
): Date {
  return orderType === "MARKET"
    ? new Date(Math.min(+expiresAt, +detectedAt + policy.ttlMs))
    : expiresAt;
}

export function runtimeMarketEntryFailure(
  input: {
    detectedAt: Date;
    expiresAt: Date;
    signalPrice: number;
    now: Date;
    quotePrice?: number;
    quoteAt?: Date;
  },
  policy = defaultRuntimeMarketEntryPolicy,
): string | null {
  const { detectedAt, expiresAt, signalPrice, now, quotePrice, quoteAt } = input;
  if (
    ![+detectedAt, +expiresAt, +now, signalPrice].every(Number.isFinite) ||
    signalPrice <= 0 ||
    +expiresAt <= +detectedAt ||
    +detectedAt > +now
  )
    return "INVALID_ENTRY_SIGNAL";
  const deadline = runtimeEntryExpiresAt("MARKET", detectedAt, expiresAt, policy);
  if (+now >= +deadline || (quoteAt !== undefined && +quoteAt >= +deadline))
    return "ENTRY_SIGNAL_EXPIRED";
  if (quoteAt !== undefined && (!Number.isFinite(+quoteAt) || +quoteAt < +detectedAt))
    return "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY";
  if (quotePrice !== undefined) {
    if (!Number.isFinite(quotePrice) || quotePrice <= 0) return "INVALID_ENTRY_QUOTE";
    if (
      new Prisma.Decimal(quotePrice)
        .minus(signalPrice)
        .abs()
        .mul(10_000)
        .gt(new Prisma.Decimal(signalPrice).mul(policy.maxDeviationBps))
    )
      return "ENTRY_PRICE_DEVIATION";
  }
  return null;
}
