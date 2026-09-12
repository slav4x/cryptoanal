export type ExperimentPeriod = "24h" | "7d" | "30d" | "all";
export type ExperimentFamily = "ema-crossover" | "breakout" | "mean-reversion" | "momentum";
export type ExperimentRiskTier = "conservative" | "balanced" | "aggressive";
export type ExperimentSampleStage = "insufficient" | "preliminary" | "comparable" | "sufficient";

export type ExperimentTrade = {
  symbol: string;
  grossPnl: number;
  fees: number;
  funding: number;
  slippage: number;
  netPnl: number;
  openedAt: Date;
  closedAt: Date;
};

export type ExperimentPosition = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  entryPrice: number;
  markPrice: number | null;
  unrealizedPnl: number;
  openedAt: Date;
};

export type ExperimentSource = {
  id: string;
  status: "draft" | "ready" | "running" | "paused" | "stopped" | "failed";
  environment: "dry-run" | "demo" | "live";
  exchangeAccountId: string;
  createdAt: Date;
  startedAt: Date | null;
  strategy: { id: string; name: string };
  strategyVersion: {
    id: string;
    version: number;
    family: ExperimentFamily;
    timeframe: "5m" | "15m" | "30m" | "1h" | "4h";
    symbols: string[];
    riskPerTradePercent: number;
    maxOpenPositions: number;
  };
  trades: ExperimentTrade[];
  positions: ExperimentPosition[];
};

export type ExperimentRankingFilters = {
  period: ExperimentPeriod;
  family: ExperimentFamily | null;
  riskTier: ExperimentRiskTier | null;
  symbol: string | null;
};

export type ExperimentCheckpoint = {
  targetTrades: 30 | 100 | 200;
  reachedAt: Date | null;
  netPnl: number | null;
  returnPercent: number | null;
  maxDrawdownPercent: number | null;
  profitFactor: number | null;
};

export type ExperimentRankingItem = {
  rank: number;
  deploymentId: string;
  status: ExperimentSource["status"];
  environment: ExperimentSource["environment"];
  exchangeAccountId: string;
  strategy: ExperimentSource["strategy"];
  strategyVersion: ExperimentSource["strategyVersion"];
  riskTier: ExperimentRiskTier;
  startedAt: Date;
  runningDays: number;
  lastTradeAt: Date | null;
  trades: number;
  wins: number;
  losses: number;
  winRatePercent: number;
  grossPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  returnPercent: number;
  costs: number;
  profitFactor: number | null;
  expectancy: number;
  maxDrawdownPercent: number;
  averageHoldingMinutes: number;
  openPositions: number;
  grossExposure: number;
  longExposure: number;
  shortExposure: number;
  sample: {
    trades: number;
    stage: ExperimentSampleStage;
    nextTarget: 30 | 100 | 200 | null;
    progressPercent: number;
  };
  checkpoints: ExperimentCheckpoint[];
};

export type ExperimentRanking = {
  summary: {
    experiments: number;
    running: number;
    trades: number;
    openPositions: number;
    realizedPnl: number;
    unrealizedPnl: number;
    totalPnl: number;
    returnPercent: number;
    grossExposure: number;
    comparable: number;
  };
  items: ExperimentRankingItem[];
  options: {
    families: ExperimentFamily[];
    riskTiers: ExperimentRiskTier[];
    symbols: string[];
  };
};

const periodDurationMs: Record<ExperimentPeriod, number | null> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
  all: null,
};

const checkpointTargets = [30, 100, 200] as const;

export function buildExperimentRanking(
  sources: ExperimentSource[],
  initialCapital: number,
  filters: ExperimentRankingFilters,
  now = new Date(),
): ExperimentRanking {
  const options = {
    families: unique(sources.map((source) => source.strategyVersion.family)),
    riskTiers: unique(
      sources.map((source) => getRiskTier(source.strategyVersion.riskPerTradePercent)),
    ),
    symbols: unique(sources.flatMap((source) => source.strategyVersion.symbols)),
  };
  const startsAt = getPeriodStartsAt(filters.period, now);
  const filteredSources = sources.filter((source) => {
    const riskTier = getRiskTier(source.strategyVersion.riskPerTradePercent);
    return (
      (!filters.family || source.strategyVersion.family === filters.family) &&
      (!filters.riskTier || riskTier === filters.riskTier) &&
      (!filters.symbol || source.strategyVersion.symbols.includes(filters.symbol))
    );
  });

  const items = filteredSources
    .map((source) => {
      const dimensionTrades = source.trades
        .filter((trade) => !filters.symbol || trade.symbol === filters.symbol)
        .sort((left, right) => left.closedAt.getTime() - right.closedAt.getTime());
      const trades = dimensionTrades.filter(
        (trade) => !startsAt || trade.closedAt.getTime() >= startsAt.getTime(),
      );
      const positions = source.positions.filter(
        (position) => !filters.symbol || position.symbol === filters.symbol,
      );
      const wins = trades.filter((trade) => trade.netPnl > 0);
      const losses = trades.filter((trade) => trade.netPnl < 0);
      const grossProfit = sum(wins.map((trade) => trade.netPnl));
      const grossLoss = Math.abs(sum(losses.map((trade) => trade.netPnl)));
      const realizedPnl = sum(trades.map((trade) => trade.netPnl));
      const unrealizedPnl = sum(positions.map((position) => position.unrealizedPnl));
      const grossExposure = sum(positions.map(positionExposure));
      const longExposure = sum(
        positions.filter((position) => position.side === "buy").map(positionExposure),
      );
      const shortExposure = sum(
        positions.filter((position) => position.side === "sell").map(positionExposure),
      );
      const startedAt = source.startedAt ?? source.createdAt;
      const sample = buildSample(dimensionTrades.length);

      return {
        rank: 0,
        deploymentId: source.id,
        status: source.status,
        environment: source.environment,
        exchangeAccountId: source.exchangeAccountId,
        strategy: source.strategy,
        strategyVersion: source.strategyVersion,
        riskTier: getRiskTier(source.strategyVersion.riskPerTradePercent),
        startedAt,
        runningDays: round(Math.max(0, now.getTime() - startedAt.getTime()) / 86_400_000, 1),
        lastTradeAt: dimensionTrades.at(-1)?.closedAt ?? null,
        trades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRatePercent: percent(wins.length, trades.length),
        grossPnl: round(sum(trades.map((trade) => trade.grossPnl))),
        realizedPnl: round(realizedPnl),
        unrealizedPnl: round(unrealizedPnl),
        totalPnl: round(realizedPnl + unrealizedPnl),
        returnPercent: percent(realizedPnl + unrealizedPnl, initialCapital),
        costs: round(sum(trades.map((trade) => trade.fees + trade.funding + trade.slippage))),
        profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
        expectancy: trades.length > 0 ? round(realizedPnl / trades.length) : 0,
        maxDrawdownPercent: calculateMaxDrawdown(trades, initialCapital),
        averageHoldingMinutes:
          trades.length > 0
            ? round(
                sum(
                  trades.map(
                    (trade) => (trade.closedAt.getTime() - trade.openedAt.getTime()) / 60_000,
                  ),
                ) / trades.length,
                1,
              )
            : 0,
        openPositions: positions.length,
        grossExposure: round(grossExposure),
        longExposure: round(longExposure),
        shortExposure: round(shortExposure),
        sample,
        checkpoints: checkpointTargets.map((target) =>
          buildCheckpoint(dimensionTrades, target, initialCapital),
        ),
      } satisfies ExperimentRankingItem;
    })
    .sort(
      (left, right) =>
        right.returnPercent - left.returnPercent ||
        right.sample.trades - left.sample.trades ||
        left.strategy.name.localeCompare(right.strategy.name),
    )
    .map((item, index) => ({ ...item, rank: index + 1 }));

  const allocatedCapital = initialCapital * items.length;
  const realizedPnl = sum(items.map((item) => item.realizedPnl));
  const unrealizedPnl = sum(items.map((item) => item.unrealizedPnl));

  return {
    summary: {
      experiments: items.length,
      running: items.filter((item) => item.status === "running").length,
      trades: sum(items.map((item) => item.trades)),
      openPositions: sum(items.map((item) => item.openPositions)),
      realizedPnl: round(realizedPnl),
      unrealizedPnl: round(unrealizedPnl),
      totalPnl: round(realizedPnl + unrealizedPnl),
      returnPercent: percent(realizedPnl + unrealizedPnl, allocatedCapital),
      grossExposure: round(sum(items.map((item) => item.grossExposure))),
      comparable: items.filter(
        (item) => item.sample.stage === "comparable" || item.sample.stage === "sufficient",
      ).length,
    },
    items,
    options,
  };
}

export function getRiskTier(riskPerTradePercent: number): ExperimentRiskTier {
  if (riskPerTradePercent <= 0.5) return "conservative";
  if (riskPerTradePercent <= 1) return "balanced";
  return "aggressive";
}

function buildSample(trades: number): ExperimentRankingItem["sample"] {
  const stage: ExperimentSampleStage =
    trades < 30
      ? "insufficient"
      : trades < 100
        ? "preliminary"
        : trades < 200
          ? "comparable"
          : "sufficient";
  const nextTarget = checkpointTargets.find((target) => trades < target) ?? null;
  const previousTarget = nextTarget === 100 ? 30 : nextTarget === 200 ? 100 : nextTarget ? 0 : 200;
  const progressPercent = nextTarget
    ? ((trades - previousTarget) / (nextTarget - previousTarget)) * 100
    : 100;
  return { trades, stage, nextTarget, progressPercent: round(progressPercent, 1) };
}

function buildCheckpoint(
  trades: ExperimentTrade[],
  targetTrades: (typeof checkpointTargets)[number],
  initialCapital: number,
): ExperimentCheckpoint {
  if (trades.length < targetTrades) {
    return {
      targetTrades,
      reachedAt: null,
      netPnl: null,
      returnPercent: null,
      maxDrawdownPercent: null,
      profitFactor: null,
    };
  }
  const checkpointTrades = trades.slice(0, targetTrades);
  const wins = checkpointTrades.filter((trade) => trade.netPnl > 0);
  const losses = checkpointTrades.filter((trade) => trade.netPnl < 0);
  const netPnl = sum(checkpointTrades.map((trade) => trade.netPnl));
  const grossProfit = sum(wins.map((trade) => trade.netPnl));
  const grossLoss = Math.abs(sum(losses.map((trade) => trade.netPnl)));
  return {
    targetTrades,
    reachedAt: checkpointTrades.at(-1)?.closedAt ?? null,
    netPnl: round(netPnl),
    returnPercent: percent(netPnl, initialCapital),
    maxDrawdownPercent: calculateMaxDrawdown(checkpointTrades, initialCapital),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
  };
}

function calculateMaxDrawdown(trades: ExperimentTrade[], initialCapital: number): number {
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
  }
  return round(maxDrawdown);
}

function positionExposure(position: ExperimentPosition): number {
  return Math.abs(position.quantity * (position.markPrice ?? position.entryPrice));
}

function getPeriodStartsAt(period: ExperimentPeriod, now: Date): Date | null {
  const duration = periodDurationMs[period];
  return duration === null ? null : new Date(now.getTime() - duration);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percent(value: number, total: number): number {
  return total > 0 ? round((value / total) * 100) : 0;
}

function round(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}
