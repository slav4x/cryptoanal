import {
  executionBreakEvenPrice,
  executionInitialRiskDistance,
  updateExecutionTrailingAtPrice,
  type ExecutionPosition,
  type ExecutionQuote,
  type ExecutionStrategyConfig,
} from "./execution-engine";
import {
  executionDecimalProduct,
  executionDecimalSum,
  compareExecutionDecimals,
  normalizeExecutionTrailingPrice,
  instrumentPriceValid,
} from "./execution-instrument";
import { assertExecutionExitQuote } from "./execution-exit-policy";

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
  assertExecutionExitQuote(position, quote);
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
  if (position.instrumentRules) {
    const rules = position.instrumentRules;
    const risk = executionInitialRiskDistance(position, config);
    const favorable = executionDecimalProduct(
      executionDecimalSum(state.bestPrice, executionDecimalProduct(position.entryPrice, -1)),
      direction,
    );
    const reached = (r: number) =>
      compareExecutionDecimals(favorable, executionDecimalProduct(risk, r)) >= 0;
    let stopPrice = position.stopPrice,
      trailingPrice = position.trailingPrice;
    if (
      reached(policy.breakEvenActivationR) &&
      instrumentPriceValid(breakEven, rules) &&
      compareExecutionDecimals(
        executionDecimalProduct(
          executionDecimalSum(state.bestPrice, executionDecimalProduct(breakEven, -1)),
          direction,
        ),
        rules.tickSize,
      ) >= 0
    )
      stopPrice = direction === 1 ? Math.max(stopPrice, breakEven) : Math.min(stopPrice, breakEven);
    if (reached(policy.trailingActivationR)) {
      const candidate = normalizeExecutionTrailingPrice(
        executionDecimalSum(
          state.bestPrice,
          executionDecimalProduct(risk, policy.trailingDistanceR, -direction),
        ),
        state.bestPrice,
        position.side,
        rules,
      );
      if (
        candidate !== null &&
        (candidate - breakEven) * direction >= 0 &&
        (state.bestPrice - candidate) * direction > 0
      )
        trailingPrice =
          trailingPrice === null
            ? candidate
            : direction === 1
              ? Math.max(trailingPrice, candidate)
              : Math.min(trailingPrice, candidate);
    }
    return { position: { ...position, stopPrice, trailingPrice }, state };
  }
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
