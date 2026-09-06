import {
  enrichExecutionCandles,
  evaluateExecutionExit,
  getExecutionSignal,
  getTradingDateKey,
  openExecutionPosition,
  settleExecutionPosition,
  updateExecutionTrailing,
  type EnrichedExecutionCandle,
  type ExecutionCandle,
  type ExecutionPosition,
  type ExecutionStrategyConfig,
  type PendingExecutionSignal,
} from "./execution-engine";

export type ValidationCandle = ExecutionCandle;

export const validationEngineVersion = "cryptoanal-validation@0.2.0";

export type ValidationStrategyConfig = ExecutionStrategyConfig;

export type ValidationEngineInput = {
  config: ValidationStrategyConfig;
  candles: ValidationCandle[];
  initialCapital: number;
  kind: "backtest" | "walk-forward";
  walkForward: { trainingDays: number; testDays: number } | null;
};

export type ValidationTrade = {
  symbol: string;
  side: "long" | "short";
  openedAt: string;
  closedAt: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  netPnl: number;
  fees: number;
  exitReason: "stop-loss" | "take-profit" | "trailing-stop" | "end-of-data";
};

export type ValidationMetrics = {
  trades: number;
  wins: number;
  losses: number;
  winRatePercent: number;
  netPnl: number;
  returnPercent: number;
  maxDrawdownPercent: number;
  profitFactor: number | null;
  expectancy: number;
  totalFees: number;
  candleCount: number;
  windows: number;
  perSymbol: Record<string, { trades: number; netPnl: number }>;
  equitySeries: Array<{ observedAt: string; equity: number }>;
};

export type ValidationEngineResult = {
  verdict: "passed" | "failed" | "warning";
  metrics: ValidationMetrics;
  trades: ValidationTrade[];
  gateReasons: string[];
};

export function runValidationEngine(input: ValidationEngineInput): ValidationEngineResult {
  if (input.candles.length === 0) {
    return {
      verdict: "failed",
      metrics: emptyMetrics(0),
      trades: [],
      gateReasons: ["В наборе данных нет свечей"],
    };
  }
  if (input.kind === "walk-forward" && input.walkForward) {
    return runWalkForward(input, input.walkForward);
  }
  return buildResult(runBacktest(input, null, null), input.initialCapital, input.candles.length, 1);
}

function runWalkForward(
  input: ValidationEngineInput,
  windows: { trainingDays: number; testDays: number },
): ValidationEngineResult {
  const times = input.candles.map((candle) => candle.openTime.getTime());
  const datasetStart = Math.min(...times);
  const datasetEnd = Math.max(...times);
  const dayMs = 86_400_000;
  const trades: ValidationTrade[] = [];
  const equitySeries: Array<{ observedAt: string; equity: number }> = [];
  let windowStart = datasetStart;
  let windowCount = 0;
  let windowCapital = input.initialCapital;

  while (windowStart + (windows.trainingDays + windows.testDays) * dayMs <= datasetEnd + dayMs) {
    const testStart = windowStart + windows.trainingDays * dayMs;
    const testEnd = testStart + windows.testDays * dayMs - 1;
    const windowCandles = input.candles.filter(
      (candle) => candle.openTime.getTime() >= windowStart && candle.openTime.getTime() <= testEnd,
    );
    const result = runBacktest(
      { ...input, candles: windowCandles, initialCapital: windowCapital },
      testStart,
      testEnd,
    );
    trades.push(...result.trades);
    equitySeries.push(...result.equitySeries);
    windowCapital += result.trades.reduce((sum, trade) => sum + trade.netPnl, 0);
    windowCount += 1;
    windowStart += windows.testDays * dayMs;
  }

  if (windowCount === 0) {
    return {
      verdict: "failed",
      metrics: emptyMetrics(input.candles.length),
      trades: [],
      gateReasons: ["Период данных короче одного walk-forward окна"],
    };
  }

  return buildResult(
    { trades, equitySeries: deduplicateEquity(equitySeries) },
    input.initialCapital,
    input.candles.length,
    windowCount,
  );
}

function runBacktest(
  input: ValidationEngineInput,
  entryFrom: number | null,
  entryTo: number | null,
): { trades: ValidationTrade[]; equitySeries: Array<{ observedAt: string; equity: number }> } {
  const bySymbol = new Map<string, EnrichedExecutionCandle[]>();
  for (const candle of input.candles) {
    const candles = bySymbol.get(candle.symbol) ?? [];
    candles.push(candle as EnrichedExecutionCandle);
    bySymbol.set(candle.symbol, candles);
  }
  for (const [symbol, candles] of bySymbol) {
    bySymbol.set(symbol, enrichExecutionCandles(candles, input.config));
  }

  const groups = new Map<number, EnrichedExecutionCandle[]>();
  for (const candles of bySymbol.values()) {
    for (const candle of candles) {
      const time = candle.openTime.getTime();
      groups.set(time, [...(groups.get(time) ?? []), candle]);
    }
  }

  const positions = new Map<string, ExecutionPosition>();
  const pendingSignals = new Map<string, PendingExecutionSignal>();
  const trades: ValidationTrade[] = [];
  const equitySeries: Array<{ observedAt: string; equity: number }> = [];
  const dailyPnl = new Map<string, number>();
  let equity = input.initialCapital;
  let sampleIndex = 0;
  const equitySampleStep = Math.max(
    1,
    Math.round(1_440 / timeframeMinutes[input.config.universe.timeframe]),
  );

  for (const [time, candles] of [...groups.entries()].sort(([left], [right]) => left - right)) {
    for (const candle of candles) {
      const position = positions.get(candle.symbol);
      if (!position) continue;
      const closed = evaluateExecutionExit(position, candle, input.config);
      if (closed) {
        positions.delete(candle.symbol);
        trades.push(closed);
        equity += closed.netPnl;
        const day = getTradingDateKey(new Date(closed.closedAt), input.config.schedule.timezone);
        dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + closed.netPnl);
      } else {
        positions.set(candle.symbol, updateExecutionTrailing(position, candle, input.config));
      }
    }

    for (const candle of candles.sort((left, right) => left.symbol.localeCompare(right.symbol))) {
      const signal = pendingSignals.get(candle.symbol);
      pendingSignals.delete(candle.symbol);
      if (!signal || positions.has(candle.symbol)) continue;
      if (positions.size >= input.config.risk.maxOpenPositions) continue;
      if (entryFrom !== null && time < entryFrom) continue;
      if (entryTo !== null && time > entryTo) continue;
      const day = getTradingDateKey(candle.openTime, input.config.schedule.timezone);
      const lossLimit = input.initialCapital * (input.config.risk.maxDailyLossPercent / 100);
      if ((dailyPnl.get(day) ?? 0) <= -lossLimit) continue;
      const position = openExecutionPosition(
        signal,
        candle,
        equity,
        Math.max(0, equity) / input.config.risk.maxOpenPositions,
        input.config,
      );
      if (!position) continue;
      const closed = evaluateExecutionExit(position, candle, input.config);
      if (closed) {
        trades.push(closed);
        equity += closed.netPnl;
        dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + closed.netPnl);
      } else {
        positions.set(candle.symbol, updateExecutionTrailing(position, candle, input.config));
      }
    }

    for (const candle of candles) {
      if (!positions.has(candle.symbol)) {
        const signal = getExecutionSignal(candle, input.config);
        if (signal) pendingSignals.set(candle.symbol, signal);
      }
    }

    if (
      (entryFrom === null || time >= entryFrom) &&
      (entryTo === null || time <= entryTo) &&
      (sampleIndex % equitySampleStep === 0 || sampleIndex === groups.size - 1)
    ) {
      const unrealized = candles.reduce((sum, candle) => {
        const position = positions.get(candle.symbol);
        if (!position) return sum;
        const direction = position.side === "long" ? 1 : -1;
        return sum + (candle.close - position.entryPrice) * position.quantity * direction;
      }, 0);
      equitySeries.push({
        observedAt: new Date(time).toISOString(),
        equity: round(equity + unrealized),
      });
    }
    sampleIndex += 1;
  }

  for (const [symbol, position] of positions) {
    const lastCandle = bySymbol.get(symbol)?.at(-1);
    if (!lastCandle) continue;
    const closed = settleExecutionPosition(
      position,
      lastCandle.close,
      lastCandle.openTime,
      "end-of-data",
      input.config,
    );
    trades.push(closed);
    equity += closed.netPnl;
  }
  const lastTime = Math.max(...input.candles.map((candle) => candle.openTime.getTime()));
  if (Number.isFinite(lastTime)) {
    equitySeries.push({ observedAt: new Date(lastTime).toISOString(), equity: round(equity) });
  }

  return { trades, equitySeries: deduplicateEquity(equitySeries) };
}

function buildResult(
  simulation: {
    trades: ValidationTrade[];
    equitySeries: Array<{ observedAt: string; equity: number }>;
  },
  initialCapital: number,
  candleCount: number,
  windows: number,
): ValidationEngineResult {
  const wins = simulation.trades.filter((trade) => trade.netPnl > 0);
  const losses = simulation.trades.filter((trade) => trade.netPnl <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const netPnl = simulation.trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const totalFees = simulation.trades.reduce((sum, trade) => sum + trade.fees, 0);
  const perSymbol: ValidationMetrics["perSymbol"] = {};
  for (const trade of simulation.trades) {
    const aggregate = perSymbol[trade.symbol] ?? { trades: 0, netPnl: 0 };
    aggregate.trades += 1;
    aggregate.netPnl = round(aggregate.netPnl + trade.netPnl);
    perSymbol[trade.symbol] = aggregate;
  }
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? null : 0) : grossProfit / grossLoss;
  const maxDrawdownPercent = calculateMaxDrawdown(simulation.equitySeries, initialCapital);
  const metrics: ValidationMetrics = {
    trades: simulation.trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePercent: simulation.trades.length
      ? round((wins.length / simulation.trades.length) * 100)
      : 0,
    netPnl: round(netPnl),
    returnPercent: initialCapital > 0 ? round((netPnl / initialCapital) * 100) : 0,
    maxDrawdownPercent: round(maxDrawdownPercent),
    profitFactor: profitFactor === null ? null : round(profitFactor),
    expectancy: simulation.trades.length ? round(netPnl / simulation.trades.length) : 0,
    totalFees: round(totalFees),
    candleCount,
    windows,
    perSymbol,
    equitySeries: simulation.equitySeries,
  };
  const gateReasons: string[] = [];
  if (metrics.trades < 30) gateReasons.push("Недостаточно сделок: требуется минимум 30");
  if ((metrics.profitFactor ?? Number.POSITIVE_INFINITY) < 1.1)
    gateReasons.push("Profit factor ниже 1.10");
  if (metrics.expectancy <= 0) gateReasons.push("Отрицательное или нулевое матожидание");
  if (metrics.maxDrawdownPercent > 20) gateReasons.push("Максимальная просадка выше 20%");
  const hardFailure = metrics.trades === 0 || metrics.expectancy <= 0;
  return {
    verdict: gateReasons.length === 0 ? "passed" : hardFailure ? "failed" : "warning",
    metrics,
    trades: simulation.trades,
    gateReasons,
  };
}

function emptyMetrics(candleCount: number): ValidationMetrics {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    winRatePercent: 0,
    netPnl: 0,
    returnPercent: 0,
    maxDrawdownPercent: 0,
    profitFactor: 0,
    expectancy: 0,
    totalFees: 0,
    candleCount,
    windows: 0,
    perSymbol: {},
    equitySeries: [],
  };
}

function calculateMaxDrawdown(series: Array<{ equity: number }>, initialCapital: number): number {
  let peak = initialCapital;
  let maximum = 0;
  for (const point of series) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maximum = Math.max(maximum, ((peak - point.equity) / peak) * 100);
  }
  return maximum;
}

function deduplicateEquity(series: Array<{ observedAt: string; equity: number }>) {
  return [...new Map(series.map((point) => [point.observedAt, point])).values()].sort(
    (left, right) => left.observedAt.localeCompare(right.observedAt),
  );
}

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

const timeframeMinutes = { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 } as const;
