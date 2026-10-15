export type ExecutionInstrumentRules = {
  version: 1;
  symbol: string;
  observedAt: string;
  tickSize: string;
  qtyStep: string;
  minOrderQty: string;
  minNotional: string;
  maxOrderQty: string;
  maxMarketOrderQty: string;
  minPrice: string;
  maxPrice: string;
};
export const instrumentRuleFields = [
  "tickSize",
  "qtyStep",
  "minOrderQty",
  "minNotional",
  "maxOrderQty",
  "maxMarketOrderQty",
  "minPrice",
  "maxPrice",
] as const;

type DecimalInput = number | string;
function fraction(value: DecimalInput): { n: bigint; d: bigint } {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match || String(value).length > 100) throw new Error("Invalid execution decimal");
  const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  if (!Number.isInteger(scale) || Math.abs(scale) > 400) throw new Error("Invalid decimal scale");
  const n = BigInt(`${match[1] === "-" ? "-" : ""}${match[2]}${match[3] ?? ""}`);
  return scale < 0 ? { n: n * 10n ** BigInt(-scale), d: 1n } : { n, d: 10n ** BigInt(scale) };
}
function format(n: bigint, d: bigint): string {
  const sign = n < 0n ? "-" : "";
  const digits = String(n < 0n ? -n : n).padStart(String(d).length, "0");
  const scale = String(d).length - 1;
  return scale === 0
    ? `${sign}${digits}`
    : `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
}
export function executionDecimalProduct(...values: DecimalInput[]): string {
  const result = values.reduce<{ n: bigint; d: bigint }>(
    (a, value) => {
      const b = fraction(value);
      return { n: a.n * b.n, d: a.d * b.d };
    },
    { n: 1n, d: 1n },
  );
  return format(result.n, result.d);
}
export function executionDecimalSum(left: DecimalInput, right: DecimalInput): string {
  const a = fraction(left),
    b = fraction(right);
  return format(a.n * b.d + b.n * a.d, a.d * b.d);
}
export function compareExecutionDecimals(left: DecimalInput, right: DecimalInput): number {
  const a = fraction(left),
    b = fraction(right),
    delta = a.n * b.d - b.n * a.d;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
export function roundExecutionStep(
  value: DecimalInput,
  step: string,
  mode: "floor" | "ceil",
): string {
  const a = fraction(value),
    b = fraction(step);
  if (a.n < 0n || b.n <= 0n) throw new Error("Invalid execution step");
  const numerator = a.n * b.d,
    denominator = a.d * b.n;
  const units =
    numerator / denominator + (mode === "ceil" && numerator % denominator !== 0n ? 1n : 0n);
  return format(units * b.n, b.d);
}
export function floorExecutionRatio(
  numerator: DecimalInput,
  denominator: DecimalInput,
  step: string,
): string {
  return roundExecutionRatio(numerator, denominator, step, "floor");
}
export function roundExecutionRatio(
  numerator: DecimalInput,
  denominator: DecimalInput,
  step: string,
  mode: "floor" | "ceil",
): string {
  const a = fraction(numerator),
    b = fraction(denominator),
    s = fraction(step);
  if (a.n < 0n || b.n <= 0n || s.n <= 0n) throw new Error("Invalid execution ratio");
  const n = a.n * b.d * s.d,
    d = a.d * b.n * s.n;
  const units = n / d + (mode === "ceil" && n % d !== 0n ? 1n : 0n);
  return format(units * s.n, s.d);
}
export function executionStepNumber(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || compareExecutionDecimals(number, value) !== 0)
    throw new Error("Instrument precision exceeds execution numeric range");
  return number;
}
export function readExecutionInstrumentRules(value: unknown): ExecutionInstrumentRules | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid instrument rules");
  const rules = value as ExecutionInstrumentRules;
  if (
    rules.version !== 1 ||
    typeof rules.symbol !== "string" ||
    !rules.symbol ||
    typeof rules.observedAt !== "string" ||
    !Number.isFinite(Date.parse(rules.observedAt))
  )
    throw new Error("Invalid instrument rules snapshot");
  for (const key of instrumentRuleFields) {
    const field = rules[key];
    if (
      typeof field !== "string" ||
      !/^\d+(?:\.\d{1,18})?$/.test(field) ||
      field.length > 60 ||
      !Number.isFinite(Number(field)) ||
      compareExecutionDecimals(field, 0) < (key === "minNotional" ? 0 : 1)
    )
      throw new Error(`Invalid instrument rule ${key}`);
  }
  if (
    compareExecutionDecimals(rules.maxOrderQty, rules.minOrderQty) < 0 ||
    compareExecutionDecimals(rules.maxMarketOrderQty, rules.minOrderQty) < 0 ||
    compareExecutionDecimals(rules.maxPrice, rules.minPrice) < 0
  )
    throw new Error("Inconsistent instrument limits");
  return {
    version: 1,
    symbol: rules.symbol,
    observedAt: rules.observedAt,
    ...Object.fromEntries(instrumentRuleFields.map((key) => [key, rules[key]])),
  } as ExecutionInstrumentRules;
}
export function instrumentRulesFreshness(
  rules: ExecutionInstrumentRules,
  now: Date,
  maximumAgeMs: number,
): string | null {
  const age = +now - Date.parse(rules.observedAt);
  return !Number.isFinite(age) || age < -1000 || age > maximumAgeMs
    ? "INSTRUMENT_RULES_STALE"
    : null;
}
export function instrumentPriceValid(
  price: DecimalInput,
  rules: ExecutionInstrumentRules,
): boolean {
  return (
    compareExecutionDecimals(price, rules.minPrice) >= 0 &&
    compareExecutionDecimals(price, rules.maxPrice) <= 0 &&
    compareExecutionDecimals(roundExecutionStep(price, rules.tickSize, "floor"), price) === 0
  );
}
export function normalizeExecutionTrailingPrice(
  value: string,
  peak: number,
  side: "long" | "short",
  rules: ExecutionInstrumentRules,
): number | null {
  const direction = side === "long" ? 1 : -1;
  if (
    compareExecutionDecimals(value, 0) <= 0 ||
    compareExecutionDecimals(value, peak) * direction >= 0
  )
    return null;
  let price = roundExecutionStep(value, rules.tickSize, direction === 1 ? "ceil" : "floor");
  if (compareExecutionDecimals(price, peak) * direction >= 0) {
    price = roundExecutionStep(peak, rules.tickSize, direction === 1 ? "floor" : "ceil");
    if (compareExecutionDecimals(price, peak) === 0)
      price = executionDecimalSum(price, executionDecimalProduct(rules.tickSize, -direction));
  }
  return instrumentPriceValid(price, rules) ? executionStepNumber(price) : null;
}

export function executionInstrumentSizeFailure(
  position: {
    quantity: DecimalInput;
    entryPrice: DecimalInput;
    stopPrice: DecimalInput;
    takePrice: DecimalInput;
    trailingPrice: DecimalInput | null;
  },
  rules: ExecutionInstrumentRules,
  partialFill = false,
): string | null {
  if (compareExecutionDecimals(position.quantity, 0) <= 0) return "ENTRY_SIZE_ROUNDED_TO_ZERO";
  if (
    compareExecutionDecimals(
      roundExecutionStep(position.quantity, rules.qtyStep, "floor"),
      position.quantity,
    ) !== 0
  )
    return "INVALID_QUANTITY_STEP";
  if (!partialFill && compareExecutionDecimals(position.quantity, rules.minOrderQty) < 0)
    return "ENTRY_BELOW_MIN_QUANTITY";
  if (
    !partialFill &&
    compareExecutionDecimals(
      executionDecimalProduct(position.quantity, position.entryPrice),
      rules.minNotional,
    ) < 0
  )
    return "ENTRY_BELOW_MIN_NOTIONAL";
  if (
    compareExecutionDecimals(position.quantity, rules.maxOrderQty) > 0 ||
    compareExecutionDecimals(position.quantity, rules.maxMarketOrderQty) > 0
  )
    return "ENTRY_ABOVE_MAX_QUANTITY";
  if (
    [
      position.entryPrice,
      position.stopPrice,
      position.takePrice,
      ...(position.trailingPrice === null ? [] : [position.trailingPrice]),
    ].some((price) => !instrumentPriceValid(price, rules))
  )
    return "INVALID_PRICE_STEP_OR_RANGE";
  return null;
}
