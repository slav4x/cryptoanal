import {
  readExecutionInstrumentRules,
  instrumentRuleFields,
  instrumentRulesFreshness,
  type ExecutionInstrumentRules,
} from "../../application/src/execution-instrument";

export const defaultInstrumentMaximumAgeMs = 3600_000;
export const instrumentRulesSelect = {
  symbol: true,
  status: true,
  enabled: true,
  metadataSyncedAt: true,
  tickSize: true,
  qtyStep: true,
  minOrderQty: true,
  minNotional: true,
  maxOrderQty: true,
  maxMarketOrderQty: true,
  minPrice: true,
  maxPrice: true,
} as const;
type StoredInstrument = { symbol: string; metadataSyncedAt: Date | null } & Record<
  (typeof instrumentRuleFields)[number],
  { toFixed(): string } | null
>;
export function captureInstrumentRules(
  instrument: StoredInstrument | null,
  now = new Date(),
): {
  rules: ExecutionInstrumentRules | null;
  reason: string | null;
} {
  if (!instrument?.metadataSyncedAt || instrumentRuleFields.some((key) => instrument[key] === null))
    return { rules: null, reason: "INSTRUMENT_RULES_MISSING" };
  try {
    const rules = readExecutionInstrumentRules({
      version: 1,
      symbol: instrument.symbol,
      observedAt: instrument.metadataSyncedAt.toISOString(),
      ...Object.fromEntries(instrumentRuleFields.map((key) => [key, instrument[key]!.toFixed()])),
    })!;
    return { rules, reason: instrumentRulesFreshness(rules, now, defaultInstrumentMaximumAgeMs) };
  } catch {
    return { rules: null, reason: "INSTRUMENT_RULES_INVALID" };
  }
}
