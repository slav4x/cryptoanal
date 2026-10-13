import {
  executionBreakEvenPrice,
  updateExecutionTrailingAtPrice,
  type ExecutionPosition,
  type ExecutionQuote,
  type ExecutionStrategyConfig,
} from "./execution-engine";

export type ExecutionProfitProtectionPolicy = {
  enabledAt: string;
  breakEvenActivationR: number;
  trailingActivationR: number;
  trailingDistanceR: number;
};
export type ExecutionProfitProtectionState = {
  version: 1;
  policyKey: string;
  activatedAt: string;
  bestPrice: number;
};

export function readExecutionProfitProtectionState(
  value: unknown,
): ExecutionProfitProtectionState | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid profit protection checkpoint");
  const state = value as ExecutionProfitProtectionState;
  if (
    state.version !== 1 ||
    typeof state.policyKey !== "string" ||
    typeof state.activatedAt !== "string" ||
    !Number.isFinite(Date.parse(state.activatedAt)) ||
    !Number.isFinite(state.bestPrice) ||
    state.bestPrice <= 0
  )
    throw new Error("Invalid profit protection checkpoint");
  return { ...state };
}

export function applyExecutionProfitProtection(
  position: ExecutionPosition,
  quote: ExecutionQuote,
  config: ExecutionStrategyConfig,
  policy: ExecutionProfitProtectionPolicy | null,
  previous: ExecutionProfitProtectionState | null,
) {
  if (!policy) return { position, state: previous };
  if (
    !Number.isFinite(Date.parse(policy.enabledAt)) ||
    !Number.isFinite(policy.breakEvenActivationR) ||
    policy.breakEvenActivationR <= 0 ||
    !Number.isFinite(policy.trailingActivationR) ||
    policy.trailingActivationR <= 0 ||
    !Number.isFinite(policy.trailingDistanceR) ||
    policy.trailingDistanceR <= 0 ||
    policy.trailingDistanceR >= policy.trailingActivationR
  )
    throw new Error("Invalid profit protection policy");
  if (!Number.isFinite(quote.price) || quote.price <= 0)
    throw new Error("Invalid protection quote");
  if (+quote.observedAt < Date.parse(policy.enabledAt) || quote.observedAt < position.openedAt)
    return { position, state: previous };
  const policyKey = JSON.stringify([
    policy.enabledAt,
    policy.breakEvenActivationR,
    policy.trailingActivationR,
    policy.trailingDistanceR,
  ]);
  const prior = previous?.policyKey === policyKey ? previous : null;
  const state: ExecutionProfitProtectionState = {
    version: 1,
    policyKey,
    activatedAt: prior?.activatedAt ?? quote.observedAt.toISOString(),
    bestPrice: prior
      ? position.side === "long"
        ? Math.max(prior.bestPrice, quote.price)
        : Math.min(prior.bestPrice, quote.price)
      : quote.price,
  };
  const direction = position.side === "long" ? 1 : -1;
  const breakEven = executionBreakEvenPrice(position, config);
  const trailingCandidate =
    state.bestPrice -
    direction *
      position.entryPrice *
      (config.exit.stopLossPercent / 100) *
      policy.trailingDistanceR;
  const canBreakEven = direction * (state.bestPrice - breakEven) >= 0;
  const canTrail = direction * (trailingCandidate - breakEven) >= 0;
  // Track only prices observed under this policy, never the pre-activation peak.
  const protectedPosition = updateExecutionTrailingAtPrice(
    { ...position, bestPrice: state.bestPrice },
    quote.price,
    {
      ...config,
      exit: {
        ...config.exit,
        breakEvenActivationR: canBreakEven ? policy.breakEvenActivationR : 0,
        trailingActivationR: policy.trailingActivationR,
        trailingStopPercent: canTrail
          ? (position.entryPrice / state.bestPrice) *
            config.exit.stopLossPercent *
            policy.trailingDistanceR
          : 0,
      },
    },
  );
  return { position: { ...protectedPosition, bestPrice: position.bestPrice }, state };
}
