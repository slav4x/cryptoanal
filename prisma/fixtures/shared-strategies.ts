import type { StrategyConfigDto } from "../../packages/contracts/src/index";

type ReportedMetrics = {
  verdict: "passed" | "warning";
  netPnl: number;
  returnPercent: number;
  trades: number;
  profitFactor: number;
  maxDrawdownPercent: number;
};

export type SharedStrategyDefinition = {
  name: string;
  description: string;
  config: StrategyConfigDto;
  reportedBacktest: ReportedMetrics & {
    source: "shared-report";
    startDate: "2026-06-01";
    endDate: "2026-09-20";
    initialCapital: "10000";
  };
};

type RawStrategy = {
  family: "momentum" | "breakout";
  name: string;
  symbols: string[];
  lookback: number;
  threshold?: number;
  stopLoss?: number;
  takeProfit?: number;
  metrics: ReportedMetrics;
};

const allSymbols = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "NEARUSDT",
  "LINKUSDT",
  "AVAXUSDT",
];

const rawStrategies: RawStrategy[] = [
  m(
    "Mom4h-L BTC+ETH+LINK lb12t1.5",
    ["BTCUSDT", "ETHUSDT", "LINKUSDT"],
    12,
    1.5,
    [1548.03, 15.48, 47, 1.55, 9.85],
  ),
  b(
    "Brk4h-L BTC+ETH+SOL+LINK lb30 1.5/3",
    ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT"],
    30,
    1.5,
    3,
    [1503.67, 15.04, 71, 1.73, 4.03],
  ),
  m(
    "Mom4h-L BTC+ETH+SOL+LINK lb8t0.8",
    ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT"],
    8,
    0.8,
    [1484.87, 14.85, 57, 1.39, 12.41],
  ),
  m("Momentum 4h lb=10 thr=1%", allSymbols, 10, 1, [1406.35, 14.06, 28, 1.53, 12.33], "warning"),
  m(
    "Mom4h-L BTC+ETH+LINK lb8t0.8",
    ["BTCUSDT", "ETHUSDT", "LINKUSDT"],
    8,
    0.8,
    [1403.69, 14.04, 49, 1.44, 12.9],
  ),
  b(
    "Brk4h-L SOL+LINK+DOGE lb30 2/4",
    ["SOLUSDT", "LINKUSDT", "DOGEUSDT"],
    30,
    2,
    4,
    [1366.48, 13.66, 46, 1.79, 5.33],
  ),
  m(
    "Mom4h-L BTC+ETH+SOL+LINK lb10t1",
    ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT"],
    10,
    1,
    [1355.38, 13.55, 65, 1.32, 11.89],
  ),
  b(
    "Brk4h-L BTC+ETH+SOL+LINK lb40 2/4",
    ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT"],
    40,
    2,
    4,
    [1232.07, 12.32, 57, 1.53, 5.97],
  ),
  b(
    "Brk4h-L BTC+ETH+SOL+LINK lb30 2/4",
    ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT"],
    30,
    2,
    4,
    [1212.52, 12.13, 60, 1.5, 7.22],
  ),
  b(
    "Brk4h-L BTC+SOL+LINK lb30 1.5/3",
    ["BTCUSDT", "SOLUSDT", "LINKUSDT"],
    30,
    1.5,
    3,
    [1194.26, 11.94, 57, 1.74, 3.5],
  ),
  b(
    "Brk4h-L SOL+LINK+XRP lb30 2/4",
    ["SOLUSDT", "LINKUSDT", "XRPUSDT"],
    30,
    2,
    4,
    [1184.33, 11.84, 51, 1.58, 5.34],
  ),
  m(
    "Mom4h-L BTC+ETH+SOL+LINK lb12t1.5",
    ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT"],
    12,
    1.5,
    [1170.37, 11.7, 59, 1.31, 12.14],
  ),
  b(
    "Brk4h-L SOL+LINK+DOGE lb40 2/4",
    ["SOLUSDT", "LINKUSDT", "DOGEUSDT"],
    40,
    2,
    4,
    [1158.36, 11.58, 43, 1.7, 4.65],
  ),
  b(
    "Brk4h-L SOL+LINK+DOGE lb30 1.5/3",
    ["SOLUSDT", "LINKUSDT", "DOGEUSDT"],
    30,
    1.5,
    3,
    [1138.95, 11.39, 54, 1.73, 2.7],
  ),
  m(
    "Mom4h-L BTC+ETH+SOL lb8t0.8",
    ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    8,
    0.8,
    [1133.41, 11.33, 49, 1.35, 13.18],
  ),
  b(
    "Brk4h-L BTC+SOL+LINK lb30 2/4",
    ["BTCUSDT", "SOLUSDT", "LINKUSDT"],
    30,
    2,
    4,
    [1130.46, 11.3, 50, 1.58, 5.85],
  ),
  b(
    "Brk4h-L SOL+LINK+XRP lb40 2/4",
    ["SOLUSDT", "LINKUSDT", "XRPUSDT"],
    40,
    2,
    4,
    [1124.01, 11.24, 49, 1.57, 4.66],
  ),
  m(
    "Mom4h-L BTC+ETH+NEAR lb15t2",
    ["BTCUSDT", "ETHUSDT", "NEARUSDT"],
    15,
    2,
    [1049.9, 10.5, 55, 1.31, 10.38],
  ),
  b(
    "Brk4h-L BTC+SOL+LINK lb40 2/4",
    ["BTCUSDT", "SOLUSDT", "LINKUSDT"],
    40,
    2,
    4,
    [989.24, 9.89, 49, 1.51, 5.82],
  ),
];

export const sharedStrategies = rawStrategies.map(toDefinition);

function m(
  name: string,
  symbols: string[],
  lookback: number,
  threshold: number,
  values: [number, number, number, number, number],
  verdict: ReportedMetrics["verdict"] = "passed",
): RawStrategy {
  return {
    family: "momentum",
    name,
    symbols,
    lookback,
    threshold,
    metrics: metrics(values, verdict),
  };
}

function b(
  name: string,
  symbols: string[],
  lookback: number,
  stopLoss: number,
  takeProfit: number,
  values: [number, number, number, number, number],
): RawStrategy {
  return {
    family: "breakout",
    name,
    symbols,
    lookback,
    stopLoss,
    takeProfit,
    metrics: metrics(values, "passed"),
  };
}

function metrics(
  [netPnl, returnPercent, trades, profitFactor, maxDrawdownPercent]: [
    number,
    number,
    number,
    number,
    number,
  ],
  verdict: ReportedMetrics["verdict"],
): ReportedMetrics {
  return { verdict, netPnl, returnPercent, trades, profitFactor, maxDrawdownPercent };
}

function toDefinition(raw: RawStrategy): SharedStrategyDefinition {
  const config = baseConfig(raw.symbols, raw.family);
  if (raw.family === "momentum") {
    config.signal.momentumLookbackPeriod = raw.lookback;
    config.signal.momentumThresholdPercent = raw.threshold ?? 2;
    if (raw.name === "Momentum 4h lb=10 thr=1%") {
      config.signal.direction = "both";
      config.risk.riskPerTradePercent = 0.3;
      config.risk.maxOpenPositions = 4;
      config.exit.stopLossPercent = 8;
      config.exit.takeProfitPercent = 24;
      config.costs.slippageBps = 2;
    }
  } else {
    config.signal.breakoutLookbackPeriod = raw.lookback;
    config.exit.stopLossPercent = raw.stopLoss ?? 2;
    config.exit.takeProfitPercent = raw.takeProfit ?? 4;
  }

  return {
    name: raw.name,
    description: "Импортировано из общего research-набора; требуется локальная валидация.",
    config,
    reportedBacktest: {
      source: "shared-report",
      startDate: "2026-06-01",
      endDate: "2026-09-20",
      initialCapital: "10000",
      ...raw.metrics,
    },
  };
}

function baseConfig(
  symbols: string[],
  family: StrategyConfigDto["signal"]["family"],
): StrategyConfigDto {
  return {
    schemaVersion: 1,
    universe: { symbols, timeframe: "4h" },
    signal: {
      family,
      direction: "long",
      emaFastPeriod: 20,
      emaSlowPeriod: 50,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      breakoutLookbackPeriod: 20,
      meanReversionLookbackPeriod: 20,
      meanReversionEntryZScore: 2,
      momentumLookbackPeriod: 20,
      momentumThresholdPercent: 2,
    },
    filters: { minimumVolume24hUsdt: 10_000_000, minimumAtrPercent: 0.1, maximumAtrPercent: 10 },
    risk: {
      riskPerTradePercent: 1,
      maxOpenPositions: 3,
      maxDailyLossPercent: 3,
    },
    entry: { orderType: "market", limitOffsetBps: 0 },
    exit: {
      stopLossPercent: family === "breakout" ? 2 : 3,
      takeProfitPercent: family === "breakout" ? 4 : 6,
      trailingStopPercent: 0,
      breakEvenActivationR: 0,
      trailingActivationR: 0,
      exitOnSignalReversal: false,
    },
    costs: { makerFeeBps: 2, takerFeeBps: 5.5, slippageBps: 3 },
    schedule: {
      timezone: "UTC",
      activeDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    },
  };
}
