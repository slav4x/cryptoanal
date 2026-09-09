import type { StrategyConfigDto } from "@cryptoanal/contracts";

export type ActiveDay = StrategyConfigDto["schedule"]["activeDays"][number];

export type StrategyConfigDraft = {
  symbols: string;
  timeframe: string;
  signalFamily: string;
  direction: string;
  emaFastPeriod: string;
  emaSlowPeriod: string;
  rsiPeriod: string;
  rsiOversold: string;
  rsiOverbought: string;
  breakoutLookbackPeriod: string;
  meanReversionLookbackPeriod: string;
  meanReversionEntryZScore: string;
  momentumLookbackPeriod: string;
  momentumThresholdPercent: string;
  minimumVolume24hUsdt: string;
  minimumAtrPercent: string;
  maximumAtrPercent: string;
  riskPerTradePercent: string;
  maxOpenPositions: string;
  maxDailyLossPercent: string;
  orderType: string;
  limitOffsetBps: string;
  stopLossPercent: string;
  takeProfitPercent: string;
  trailingStopPercent: string;
  makerFeeBps: string;
  takerFeeBps: string;
  slippageBps: string;
  timezone: string;
  activeDays: ActiveDay[];
};

export const defaultStrategyConfigDraft: StrategyConfigDraft = {
  symbols: "",
  timeframe: "15m",
  signalFamily: "ema-crossover",
  direction: "both",
  emaFastPeriod: "20",
  emaSlowPeriod: "50",
  rsiPeriod: "14",
  rsiOversold: "30",
  rsiOverbought: "70",
  breakoutLookbackPeriod: "20",
  meanReversionLookbackPeriod: "20",
  meanReversionEntryZScore: "2",
  momentumLookbackPeriod: "20",
  momentumThresholdPercent: "2",
  minimumVolume24hUsdt: "10000000",
  minimumAtrPercent: "0.5",
  maximumAtrPercent: "8",
  riskPerTradePercent: "1",
  maxOpenPositions: "3",
  maxDailyLossPercent: "3",
  orderType: "market",
  limitOffsetBps: "0",
  stopLossPercent: "2",
  takeProfitPercent: "4",
  trailingStopPercent: "0",
  makerFeeBps: "2",
  takerFeeBps: "5.5",
  slippageBps: "3",
  timezone: "UTC",
  activeDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
};

export function strategyConfigToDraft(config: StrategyConfigDto): StrategyConfigDraft {
  return {
    symbols: config.universe.symbols.join(", "),
    timeframe: config.universe.timeframe,
    signalFamily: config.signal.family,
    direction: config.signal.direction,
    emaFastPeriod: String(config.signal.emaFastPeriod),
    emaSlowPeriod: String(config.signal.emaSlowPeriod),
    rsiPeriod: String(config.signal.rsiPeriod),
    rsiOversold: String(config.signal.rsiOversold),
    rsiOverbought: String(config.signal.rsiOverbought),
    breakoutLookbackPeriod: String(config.signal.breakoutLookbackPeriod),
    meanReversionLookbackPeriod: String(config.signal.meanReversionLookbackPeriod),
    meanReversionEntryZScore: String(config.signal.meanReversionEntryZScore),
    momentumLookbackPeriod: String(config.signal.momentumLookbackPeriod),
    momentumThresholdPercent: String(config.signal.momentumThresholdPercent),
    minimumVolume24hUsdt: String(config.filters.minimumVolume24hUsdt),
    minimumAtrPercent: String(config.filters.minimumAtrPercent),
    maximumAtrPercent: String(config.filters.maximumAtrPercent),
    riskPerTradePercent: String(config.risk.riskPerTradePercent),
    maxOpenPositions: String(config.risk.maxOpenPositions),
    maxDailyLossPercent: String(config.risk.maxDailyLossPercent),
    orderType: config.entry.orderType,
    limitOffsetBps: String(config.entry.limitOffsetBps),
    stopLossPercent: String(config.exit.stopLossPercent),
    takeProfitPercent: String(config.exit.takeProfitPercent),
    trailingStopPercent: String(config.exit.trailingStopPercent),
    makerFeeBps: String(config.costs.makerFeeBps),
    takerFeeBps: String(config.costs.takerFeeBps),
    slippageBps: String(config.costs.slippageBps),
    timezone: config.schedule.timezone,
    activeDays: config.schedule.activeDays,
  };
}

export function draftToStrategyConfig(draft: StrategyConfigDraft): StrategyConfigDto {
  return {
    schemaVersion: 1,
    universe: {
      symbols: Array.from(
        new Set(
          draft.symbols
            .split(/[\s,]+/)
            .map((symbol) => symbol.trim().toUpperCase())
            .filter(Boolean),
        ),
      ),
      timeframe: draft.timeframe as StrategyConfigDto["universe"]["timeframe"],
    },
    signal: {
      family: draft.signalFamily as StrategyConfigDto["signal"]["family"],
      direction: draft.direction as StrategyConfigDto["signal"]["direction"],
      emaFastPeriod: toNumber(draft.emaFastPeriod),
      emaSlowPeriod: toNumber(draft.emaSlowPeriod),
      rsiPeriod: toNumber(draft.rsiPeriod),
      rsiOversold: toNumber(draft.rsiOversold),
      rsiOverbought: toNumber(draft.rsiOverbought),
      breakoutLookbackPeriod: toNumber(draft.breakoutLookbackPeriod),
      meanReversionLookbackPeriod: toNumber(draft.meanReversionLookbackPeriod),
      meanReversionEntryZScore: toNumber(draft.meanReversionEntryZScore),
      momentumLookbackPeriod: toNumber(draft.momentumLookbackPeriod),
      momentumThresholdPercent: toNumber(draft.momentumThresholdPercent),
    },
    filters: {
      minimumVolume24hUsdt: toNumber(draft.minimumVolume24hUsdt),
      minimumAtrPercent: toNumber(draft.minimumAtrPercent),
      maximumAtrPercent: toNumber(draft.maximumAtrPercent),
    },
    risk: {
      riskPerTradePercent: toNumber(draft.riskPerTradePercent),
      maxOpenPositions: toNumber(draft.maxOpenPositions),
      maxDailyLossPercent: toNumber(draft.maxDailyLossPercent),
    },
    entry: {
      orderType: draft.orderType as StrategyConfigDto["entry"]["orderType"],
      limitOffsetBps: toNumber(draft.limitOffsetBps),
    },
    exit: {
      stopLossPercent: toNumber(draft.stopLossPercent),
      takeProfitPercent: toNumber(draft.takeProfitPercent),
      trailingStopPercent: toNumber(draft.trailingStopPercent),
    },
    costs: {
      makerFeeBps: toNumber(draft.makerFeeBps),
      takerFeeBps: toNumber(draft.takerFeeBps),
      slippageBps: toNumber(draft.slippageBps),
    },
    schedule: { timezone: draft.timezone, activeDays: draft.activeDays },
  };
}

function toNumber(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}
