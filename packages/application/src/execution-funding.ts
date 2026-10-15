import type {
  ExecutionPosition,
  EnrichedExecutionCandle,
  ExecutionStrategyConfig,
} from "./execution-engine";
import {
  compareExecutionDecimals as cmp,
  executionDecimalProduct as mul,
  executionDecimalSum as add,
  roundExecutionRatio,
  roundExecutionStep,
} from "./execution-instrument";

export const executionFundingVersion = "cryptoanal-funding@mark-open-v1";
export const enabledFundingPolicy = {
  version: executionFundingVersion,
  status: "enabled",
  priceModel: "mark-kline-open@1",
  boundary: "before-exit-after-entry@1",
  rounding: "towards-zero-18@1",
  reason:
    "USDT linear funding scenario: settled rates, mark-kline open, explicit boundary; exchange inclusion within 5 seconds is uncertain",
} as const;
export type ExecutionFundingPolicy = typeof enabledFundingPolicy;
export type ExecutionFundingEvent = {
  symbol: string;
  settledAt: string;
  rate: string;
  markPrice: string;
  markInterval: "1" | "60";
};
export type ExecutionFundingDataset = {
  version: 1;
  policy: ExecutionFundingPolicy;
  symbols: string[];
  startsAt: string;
  throughAt: string;
  coverage: "complete";
  events: ExecutionFundingEvent[];
};
export function readExecutionFundingPolicy(value: unknown): ExecutionFundingPolicy | null {
  if (value == null) return null;
  const p = value as ExecutionFundingPolicy;
  if (
    p.version !== executionFundingVersion ||
    p.status !== "enabled" ||
    p.priceModel !== enabledFundingPolicy.priceModel ||
    p.boundary !== enabledFundingPolicy.boundary ||
    p.rounding !== enabledFundingPolicy.rounding
  )
    throw new Error("Unsupported funding policy");
  return { ...p };
}
export function fundingAmount(
  side: "long" | "short",
  quantity: string,
  event: ExecutionFundingEvent,
): string {
  if (
    !Number.isFinite(Date.parse(event.settledAt)) ||
    !event.symbol ||
    !/^-?\d+(?:\.\d{1,18})?$/.test(event.rate) ||
    cmp(quantity, "0") < 0 ||
    cmp(event.markPrice, "0") <= 0 ||
    Math.abs(Number(event.rate)) > 1 ||
    !["1", "60"].includes(event.markInterval) ||
    Date.parse(event.settledAt) % (Number(event.markInterval) * 60000) !== 0
  )
    throw new Error("Invalid funding event");
  const amount = mul(quantity, event.markPrice, event.rate, side === "long" ? 1 : -1),
    sign = cmp(amount, 0) < 0 ? -1 : 1;
  return mul(roundExecutionStep(mul(amount, sign), "0.000000000000000001", "floor"), sign);
}
export function allocateFunding(
  remainingFunding: string,
  quantity: string,
  remainingQuantity: string,
): string {
  if (cmp(quantity, 0) <= 0 || cmp(quantity, remainingQuantity) > 0)
    throw new Error("Invalid funding allocation quantity");
  if (cmp(quantity, remainingQuantity) === 0) return remainingFunding;
  const sign = cmp(remainingFunding, 0) < 0 ? -1 : 1;
  return mul(
    roundExecutionRatio(
      mul(remainingFunding, sign, quantity),
      remainingQuantity,
      "0.000000000000000001",
      "floor",
    ),
    sign,
  );
}
export function fundingExposure(
  input: {
    quantity: string;
    openedAt: string;
    exits: Array<{ quantity: string; filledAt: string }>;
  },
  settledAt: string,
): string {
  const at = Date.parse(settledAt);
  if (
    !Number.isFinite(at) ||
    !Number.isFinite(Date.parse(input.openedAt)) ||
    cmp(input.quantity, 0) <= 0 ||
    input.exits.some(
      (f) =>
        !Number.isFinite(Date.parse(f.filledAt)) ||
        Date.parse(f.filledAt) < Date.parse(input.openedAt) ||
        cmp(f.quantity, 0) <= 0,
    )
  )
    throw new Error("Invalid funding exposure time");
  if (Date.parse(input.openedAt) >= at) return "0";
  const quantity = input.exits
    .filter((f) => Date.parse(f.filledAt) < at)
    .reduce((q, f) => add(q, mul(f.quantity, -1)), input.quantity);
  if (cmp(quantity, 0) < 0) throw new Error("Negative funding exposure");
  return quantity;
}
export function validateFundingDataset(
  data: ExecutionFundingDataset,
  symbols: string[],
  startsAt: Date,
  throughAt: Date,
) {
  if (!readExecutionFundingPolicy(data.policy)) throw new Error("Funding policy is required");
  if (
    !data.symbols.length ||
    new Set(data.symbols).size !== data.symbols.length ||
    Date.parse(data.startsAt) > Date.parse(data.throughAt) ||
    data.version !== 1 ||
    data.coverage !== "complete" ||
    !Number.isFinite(Date.parse(data.startsAt)) ||
    !Number.isFinite(Date.parse(data.throughAt)) ||
    Date.parse(data.startsAt) > +startsAt ||
    Date.parse(data.throughAt) < +throughAt ||
    symbols.some((s) => !data.symbols.includes(s))
  )
    throw new Error("Funding history coverage is incomplete");
  const keys = new Set<string>();
  for (const e of data.events) {
    fundingAmount("long", "1", e);
    const key = `${e.symbol}:${Date.parse(e.settledAt)}`;
    if (
      !data.symbols.includes(e.symbol) ||
      Date.parse(e.settledAt) < Date.parse(data.startsAt) ||
      Date.parse(e.settledAt) > Date.parse(data.throughAt) ||
      keys.has(key)
    )
      throw new Error("Invalid or duplicate funding history event");
    keys.add(key);
  }
}
export function fundingBetween(
  data: ExecutionFundingDataset,
  position: { symbol: string; side: "long" | "short"; quantity: number; openedAt: Date },
  from: Date,
  through: Date,
): string {
  validateFundingDataset(data, [position.symbol], position.openedAt, through);
  return data.events
    .filter(
      (e) =>
        e.symbol === position.symbol &&
        Date.parse(e.settledAt) > Math.max(+position.openedAt, +from) &&
        Date.parse(e.settledAt) <= +through,
    )
    .reduce((sum, e) => add(sum, fundingAmount(position.side, String(position.quantity), e)), "0");
}

// OHLC exits retain their recorded open/close timestamp; intra-bar exposure is a scenario.
export function advanceFundedCandle(
  position: ExecutionPosition,
  candle: EnrichedExecutionCandle,
  config: ExecutionStrategyConfig,
  data?: ExecutionFundingDataset,
) {
  if (!data)
    return {
      ...advanceExecutionCandlePosition(position, candle, config),
      charges: [] as Array<{ settledAt: string; amount: string }>,
    };
  const through = new Date(+candle.openTime + fundingTimeframes[config.universe.timeframe] * 60000);
  if (
    !data.symbols.includes(position.symbol) ||
    Date.parse(data.startsAt) > +position.openedAt ||
    Date.parse(data.throughAt) < +through
  )
    throw new Error("Funding history coverage is incomplete");
  let funded = { ...position, fundingPaid: position.fundingPaid ?? 0 };
  const charges: Array<{ settledAt: string; amount: string }> = [];
  const accrue = (until: Date) => {
    const from = +(funded.fundingThroughAt ?? funded.openedAt);
    for (const event of data.events
      .filter(
        (e) =>
          e.symbol === position.symbol &&
          Date.parse(e.settledAt) > Math.max(from, +position.openedAt) &&
          Date.parse(e.settledAt) <= +until,
      )
      .sort((a, b) => Date.parse(a.settledAt) - Date.parse(b.settledAt))) {
      const amount = fundingAmount(position.side, String(position.quantity), event);
      funded = { ...funded, fundingPaid: Number(add(String(funded.fundingPaid), amount)) };
      charges.push({ settledAt: event.settledAt, amount });
    }
    funded = { ...funded, fundingThroughAt: until };
  };
  accrue(candle.openTime);
  const early = advanceExecutionCandlePosition(funded, candle, config);
  if (early.settlement && Date.parse(early.settlement.closedAt) <= +candle.openTime)
    return { ...early, charges };
  accrue(through);
  return { ...advanceExecutionCandlePosition(funded, candle, config), charges };
}
import { advanceExecutionCandlePosition } from "./execution-engine";
const fundingTimeframes = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};
