export type PerformanceTrade = {
  id: string;
  symbol: string;
  environment: "dry-run" | "demo" | "live";
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
  };
};

export function buildPerformanceAnalytics(
  sourceTrades: PerformanceTrade[],
  initialCapital: number,
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
  const equitySeries: PerformanceAnalytics["equitySeries"] = trades[0]
    ? [
        {
          observedAt: new Date(trades[0].openedAt.getTime() - 1),
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
    },
  };
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
