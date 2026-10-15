import type { ServerConfig } from "@cryptoanal/config";
import {
  defaultLiquidityExitPolicy,
  enabledFundingPolicy,
  type ExecutionPolicySettings,
} from "@cryptoanal/application";
export function executionPolicySettingsFromConfig(c: ServerConfig): ExecutionPolicySettings {
  return {
    accountSafety: {
      initialBalance: c.DRY_RUN_INITIAL_BALANCE,
      maxDailyLossPercent: c.RUNTIME_MAX_DAILY_LOSS_PERCENT,
      maxAccountExposurePercent: c.RUNTIME_MAX_ACCOUNT_EXPOSURE_PERCENT,
      maxOpenPositions: c.RUNTIME_MAX_OPEN_POSITIONS,
      maxQuoteAgeMs: c.RUNTIME_QUOTE_MAX_AGE_MS,
    },
    profitProtection: c.RUNTIME_PROFIT_PROTECTION_ENABLED_AT
      ? {
          enabledAt: c.RUNTIME_PROFIT_PROTECTION_ENABLED_AT,
          breakEvenActivationR: c.RUNTIME_PROFIT_BREAK_EVEN_ACTIVATION_R,
          trailingActivationR: c.RUNTIME_PROFIT_TRAILING_ACTIVATION_R,
          trailingDistanceR: c.RUNTIME_PROFIT_TRAILING_DISTANCE_R,
        }
      : null,
    marketEntry: {
      ttlMs: c.RUNTIME_MARKET_ENTRY_TTL_MS,
      maxDeviationBps: c.RUNTIME_MARKET_ENTRY_MAX_DEVIATION_BPS,
    },
    entryLiquidity: {
      maximumSpreadBps: c.RUNTIME_ENTRY_MAX_SPREAD_BPS,
      maximumSlippageBps: c.RUNTIME_ENTRY_MAX_SLIPPAGE_BPS,
      maximumBookAgeMs: c.RUNTIME_ENTRY_BOOK_MAX_AGE_MS,
      makerParticipationBps: c.RUNTIME_ENTRY_MAKER_PARTICIPATION_BPS,
    },
    exit: {
      ...defaultLiquidityExitPolicy,
      triggerSource: c.RUNTIME_EXIT_TRIGGER_SOURCE,
      maximumSpreadBps: c.RUNTIME_EXIT_MAX_SPREAD_BPS,
      maximumSlippageBps: c.RUNTIME_EXIT_MAX_SLIPPAGE_BPS,
      maximumBookAgeMs: c.RUNTIME_EXIT_BOOK_MAX_AGE_MS,
      orderTtlMs: c.RUNTIME_EXIT_ORDER_TTL_MS,
    },
    funding: enabledFundingPolicy,
  };
}
