export type PerformanceTrade = {
  id: string;
  symbol: string;
  environment: "dry-run" | "demo" | "live";
  entryRegime: "bull" | "bear" | "neutral" | "unknown";
  entrySession: "asia" | "europe" | "us" | "off-hours" | "unknown";
  grossPnl: number;
  fees: number;
  funding: number;
  slippage: number;
  netPnl: number;
  exitReason: string;
  openedAt: Date;
  closedAt: Date;
  strategy: {
    id: string;
    name: string;
    version: number;
  };
};

export type PerformanceBreakdown = {
  key: string;
  label: string;
  trades: number;
  wins: number;
  winRatePercent: number;
  grossPnl: number;
  netPnl: number;
  costs: number;
};

export type PerformancePnlDistributionBucket = {
  from: number;
  to: number;
  trades: number;
  netPnl: number;
};

export type PerformanceHoldingTimeBucket = {
  key: string;
  label: string;
  minMinutes: number;
  maxMinutes: number | null;
  trades: number;
  winRatePercent: number;
  netPnl: number;
};

export type PerformanceAnalytics = {
  summary: {
    trades: number;
    wins: number;
    losses: number;
    breakeven: number;
    winRatePercent: number;
    grossPnl: number;
    netPnl: number;
    totalFees: number;
    totalFunding: number;
    totalSlippage: number;
    profitFactor: number | null;
    expectancy: number;
    maxDrawdownPercent: number;
    averageWin: number;
    averageLoss: number;
    payoffRatio: number | null;
    bestTrade: number;
    worstTrade: number;
  };
  equitySeries: Array<{
    observedAt: Date;
    equity: number;
    cumulativeNetPnl: number;
    drawdownPercent: number;
  }>;
  dailyPnl: Array<{ date: string; netPnl: number; trades: number }>;
  breakdowns: {
    strategies: PerformanceBreakdown[];
    symbols: PerformanceBreakdown[];
    exitReasons: PerformanceBreakdown[];
    regimes: PerformanceBreakdown[];
    sessions: PerformanceBreakdown[];
  };
  distributions: {
    pnl: PerformancePnlDistributionBucket[];
    holdingTime: PerformanceHoldingTimeBucket[];
  };
};

export function buildPerformanceAnalytics(
  sourceTrades: PerformanceTrade[],
  initialCapital: number,
  range?: { startsAt?: Date; endsAt: Date },
): PerformanceAnalytics {
  const trades = [...sourceTrades].sort(
    (left, right) =>
      left.closedAt.getTime() - right.closedAt.getTime() || left.id.localeCompare(right.id),
  );
  const winningTrades = trades.filter((trade) => trade.netPnl > 0);
  const losingTrades = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = sum(winningTrades.map((trade) => trade.netPnl));
  const grossLoss = Math.abs(sum(losingTrades.map((trade) => trade.netPnl)));

  let cumulativeNetPnl = 0;
  let peakEquity = initialCapital;
  let maxDrawdownPercent = 0;
  const initialObservedAt =
    range?.startsAt ?? (trades[0] ? new Date(trades[0].openedAt.getTime() - 1) : null);
  const equitySeries: PerformanceAnalytics["equitySeries"] = initialObservedAt
    ? [
        {
          observedAt: initialObservedAt,
          equity: round(initialCapital),
          cumulativeNetPnl: 0,
          drawdownPercent: 0,
        },
      ]
    : [];
  for (const trade of trades) {
    cumulativeNetPnl += trade.netPnl;
    const equity = initialCapital + cumulativeNetPnl;
    peakEquity = Math.max(peakEquity, equity);
    const drawdownPercent = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdownPercent);
    equitySeries.push({
      observedAt: trade.closedAt,
      equity: round(equity),
      cumulativeNetPnl: round(cumulativeNetPnl),
      drawdownPercent: round(drawdownPercent),
    });
  }
  if (
    range &&
    equitySeries.length > 0 &&
    equitySeries.at(-1)?.observedAt.getTime() !== range.endsAt.getTime()
  ) {
    equitySeries.push({
      observedAt: range.endsAt,
      equity: round(initialCapital + cumulativeNetPnl),
      cumulativeNetPnl: round(cumulativeNetPnl),
      drawdownPercent: equitySeries.at(-1)?.drawdownPercent ?? 0,
    });
  }

  const dailyGroups = groupBy(trades, (trade) => trade.closedAt.toISOString().slice(0, 10));

  return {
    summary: {
      trades: trades.length,
      wins: winningTrades.length,
      losses: losingTrades.length,
      breakeven: trades.length - winningTrades.length - losingTrades.length,
      winRatePercent: round(ratio(winningTrades.length, trades.length) * 100),
      grossPnl: round(sum(trades.map((trade) => trade.grossPnl))),
      netPnl: round(sum(trades.map((trade) => trade.netPnl))),
      totalFees: round(sum(trades.map((trade) => trade.fees))),
      totalFunding: round(sum(trades.map((trade) => trade.funding))),
      totalSlippage: round(sum(trades.map((trade) => trade.slippage))),
      profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
      expectancy:
        trades.length > 0 ? round(sum(trades.map((trade) => trade.netPnl)) / trades.length) : 0,
      maxDrawdownPercent: round(maxDrawdownPercent),
      averageWin: winningTrades.length > 0 ? round(grossProfit / winningTrades.length) : 0,
      averageLoss: losingTrades.length > 0 ? round(-grossLoss / losingTrades.length) : 0,
      payoffRatio:
        winningTrades.length > 0 && losingTrades.length > 0
          ? round(grossProfit / winningTrades.length / Math.abs(-grossLoss / losingTrades.length))
          : null,
      bestTrade: trades.length > 0 ? round(Math.max(...trades.map((trade) => trade.netPnl))) : 0,
      worstTrade: trades.length > 0 ? round(Math.min(...trades.map((trade) => trade.netPnl))) : 0,
    },
    equitySeries,
    dailyPnl: [...dailyGroups.entries()].map(([date, dayTrades]) => ({
      date,
      netPnl: round(sum(dayTrades.map((trade) => trade.netPnl))),
      trades: dayTrades.length,
    })),
    breakdowns: {
      strategies: createBreakdown(
        trades,
        (trade) => `${trade.strategy.id}:${trade.strategy.version}`,
        (trade) => `${trade.strategy.name} · v${trade.strategy.version}`,
      ),
      symbols: createBreakdown(
        trades,
        (trade) => trade.symbol,
        (trade) => trade.symbol,
      ),
      exitReasons: createBreakdown(
        trades,
        (trade) => trade.exitReason,
        (trade) => trade.exitReason,
      ),
      regimes: createBreakdown(
        trades,
        (trade) => trade.entryRegime,
        (trade) => trade.entryRegime,
      ),
      sessions: createBreakdown(
        trades,
        (trade) => trade.entrySession,
        (trade) => trade.entrySession,
      ),
    },
    distributions: {
      pnl: createPnlDistribution(trades),
      holdingTime: createHoldingTimeDistribution(trades),
    },
  };
}

function createPnlDistribution(trades: PerformanceTrade[]): PerformancePnlDistributionBucket[] {
  if (trades.length === 0) return [];
  const values = trades.map((trade) => trade.netPnl);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (minimum === maximum) {
    return [
      {
        from: round(minimum),
        to: round(maximum),
        trades: trades.length,
        netPnl: round(sum(values)),
      },
    ];
  }

  const bucketCount = Math.min(10, Math.max(1, Math.ceil(Math.sqrt(trades.length))));
  const width = (maximum - minimum) / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    from: round(minimum + width * index),
    to: round(index === bucketCount - 1 ? maximum : minimum + width * (index + 1)),
    trades: 0,
    netPnl: 0,
  }));

  for (const trade of trades) {
    const index = Math.min(bucketCount - 1, Math.floor((trade.netPnl - minimum) / width));
    const bucket = buckets[index]!;
    bucket.trades += 1;
    bucket.netPnl = round(bucket.netPnl + trade.netPnl);
  }
  return buckets;
}

function createHoldingTimeDistribution(trades: PerformanceTrade[]): PerformanceHoldingTimeBucket[] {
  const definitions = [
    { key: "under-15m", label: "< 15 мин", minMinutes: 0, maxMinutes: 15 },
    { key: "15m-1h", label: "15 мин – 1 ч", minMinutes: 15, maxMinutes: 60 },
    { key: "1h-4h", label: "1–4 ч", minMinutes: 60, maxMinutes: 240 },
    { key: "4h-24h", label: "4–24 ч", minMinutes: 240, maxMinutes: 1_440 },
    { key: "1d-3d", label: "1–3 дня", minMinutes: 1_440, maxMinutes: 4_320 },
    { key: "over-3d", label: "> 3 дней", minMinutes: 4_320, maxMinutes: null },
  ] as const;

  return definitions.map((definition) => {
    const groupedTrades = trades.filter((trade) => {
      const minutes = Math.max(0, trade.closedAt.getTime() - trade.openedAt.getTime()) / 60_000;
      return (
        minutes >= definition.minMinutes &&
        (definition.maxMinutes === null || minutes < definition.maxMinutes)
      );
    });
    const wins = groupedTrades.filter((trade) => trade.netPnl > 0).length;
    return {
      ...definition,
      trades: groupedTrades.length,
      winRatePercent: round(ratio(wins, groupedTrades.length) * 100),
      netPnl: round(sum(groupedTrades.map((trade) => trade.netPnl))),
    };
  });
}

function createBreakdown(
  trades: PerformanceTrade[],
  getKey: (trade: PerformanceTrade) => string,
  getLabel: (trade: PerformanceTrade) => string,
): PerformanceBreakdown[] {
  return [...groupBy(trades, getKey).entries()]
    .map(([key, groupedTrades]) => {
      const wins = groupedTrades.filter((trade) => trade.netPnl > 0).length;
      return {
        key,
        label: getLabel(groupedTrades[0]!),
        trades: groupedTrades.length,
        wins,
        winRatePercent: round(ratio(wins, groupedTrades.length) * 100),
        grossPnl: round(sum(groupedTrades.map((trade) => trade.grossPnl))),
        netPnl: round(sum(groupedTrades.map((trade) => trade.netPnl))),
        costs: round(
          sum(groupedTrades.map((trade) => trade.fees + trade.funding + trade.slippage)),
        ),
      };
    })
    .sort((left, right) => right.netPnl - left.netPnl || left.label.localeCompare(right.label));
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}
