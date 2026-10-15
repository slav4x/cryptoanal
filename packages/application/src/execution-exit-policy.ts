import type { ExecutionPosition, ExecutionQuote } from "./execution-engine";

export const executionExitPolicyVersion = "cryptoanal-exit-trigger@1";
export type FixedExecutionExitPolicy = {
  version: typeof executionExitPolicyVersion;
  triggerSource: "LastPrice";
  stopOrderType: "Market";
  takeOrderType: "Market";
  fillModel: "fixed-slippage@1";
};
export const defaultExecutionExitPolicy: FixedExecutionExitPolicy = {
  version: executionExitPolicyVersion,
  triggerSource: "LastPrice",
  stopOrderType: "Market",
  takeOrderType: "Market",
  fillModel: "fixed-slippage@1",
};
export const liquidityExitVersion = "cryptoanal-exit-liquidity@1";
export type LiquidityExecutionExitPolicy = {
  version: typeof liquidityExitVersion;
  triggerSource: "LastPrice";
  stopOrderType: "Market";
  takeOrderType: "Market";
  fillModel: "l1-ioc@1";
  maximumSpreadBps: number;
  maximumSlippageBps: number;
  maximumBookAgeMs: number;
  orderTtlMs: number;
};
export type ExecutionExitPolicy = FixedExecutionExitPolicy | LiquidityExecutionExitPolicy;
export const defaultLiquidityExitPolicy: LiquidityExecutionExitPolicy = {
  version: liquidityExitVersion,
  triggerSource: "LastPrice",
  stopOrderType: "Market",
  takeOrderType: "Market",
  fillModel: "l1-ioc@1",
  maximumSpreadBps: 50,
  maximumSlippageBps: 50,
  maximumBookAgeMs: 1000,
  orderTtlMs: 5000,
};
export function isLiquidityExitPolicy(value: unknown): value is LiquidityExecutionExitPolicy {
  return (value as { fillModel?: unknown } | null)?.fillModel === "l1-ioc@1";
}

export function readExecutionExitPolicy(value: unknown): ExecutionExitPolicy | null {
  if (value == null) return null;
  const p = value as ExecutionExitPolicy;
  if (
    (p.version !== executionExitPolicyVersion && p.version !== liquidityExitVersion) ||
    p.triggerSource !== "LastPrice" ||
    p.stopOrderType !== "Market" ||
    p.takeOrderType !== "Market" ||
    (p.version === executionExitPolicyVersion
      ? p.fillModel !== "fixed-slippage@1"
      : p.fillModel !== "l1-ioc@1" ||
        ![p.maximumSpreadBps, p.maximumSlippageBps, p.maximumBookAgeMs, p.orderTtlMs].every(
          Number.isFinite,
        ) ||
        p.maximumSpreadBps < 0 ||
        p.maximumSpreadBps > 10000 ||
        p.maximumSlippageBps < 0 ||
        p.maximumSlippageBps >= 10000 ||
        p.maximumBookAgeMs < 100 ||
        p.maximumBookAgeMs > 10000 ||
        p.orderTtlMs < 1000 ||
        p.orderTtlMs > 60000)
  )
    throw new Error("Unsupported exit trigger policy");
  return { ...p };
}

export function assertExecutionExitQuote(position: ExecutionPosition, quote: ExecutionQuote) {
  if (!position.exitPolicy) return;
  const policy = readExecutionExitPolicy(position.exitPolicy)!;
  if (quote.source !== policy.triggerSource)
    throw new Error("Exit trigger source does not match the pinned policy");
  if (
    quote.symbol !== position.symbol ||
    !Number.isFinite(quote.price) ||
    quote.price <= 0 ||
    !Number.isFinite(+quote.observedAt) ||
    quote.observedAt < position.openedAt
  )
    throw new Error("Invalid exit trigger quote");
}
