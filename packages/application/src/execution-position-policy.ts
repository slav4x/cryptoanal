import {
  updateExecutionTrailingAtPrice,
  type ExecutionPosition,
  type ExecutionQuote,
  type ExecutionStrategyConfig,
} from "./execution-engine";
import {
  applyExecutionProfitProtection,
  type ExecutionProfitProtectionPolicy,
  type ExecutionProfitProtectionState,
} from "./execution-profit-protection";
export function advanceExecutionQuoteProtection(
  position: ExecutionPosition,
  quote: ExecutionQuote,
  config: ExecutionStrategyConfig,
  policy: ExecutionProfitProtectionPolicy | null,
  state: ExecutionProfitProtectionState | null,
) {
  return applyExecutionProfitProtection(
    updateExecutionTrailingAtPrice(position, quote.price, config),
    quote,
    config,
    policy,
    state,
  );
}
