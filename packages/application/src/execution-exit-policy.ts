import type { ExecutionPosition, ExecutionQuote } from "./execution-engine";

export const executionExitPolicyVersion = "cryptoanal-exit-trigger@1";
export type ExecutionExitPolicy = {
  version: typeof executionExitPolicyVersion;
  triggerSource: "LastPrice";
  stopOrderType: "Market";
  takeOrderType: "Market";
  fillModel: "fixed-slippage@1";
};
export const defaultExecutionExitPolicy: ExecutionExitPolicy = {
  version: executionExitPolicyVersion,
  triggerSource: "LastPrice",
  stopOrderType: "Market",
  takeOrderType: "Market",
  fillModel: "fixed-slippage@1",
};

export function readExecutionExitPolicy(value: unknown): ExecutionExitPolicy | null {
  if (value == null) return null;
  const p = value as ExecutionExitPolicy;
  if (
    p.version !== executionExitPolicyVersion ||
    p.triggerSource !== "LastPrice" ||
    p.stopOrderType !== "Market" ||
    p.takeOrderType !== "Market" ||
    p.fillModel !== "fixed-slippage@1"
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
