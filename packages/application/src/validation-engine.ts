export type ValidationCandle = {
  symbol: string;
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover: number;
};

export const validationEngineVersion = "cryptoanal-validation@0.2.0";

export type ValidationStrategyConfig = {
  universe: { timeframe: "5m" | "15m" | "30m" | "1h" | "4h" };
  signal: {
    direction: "long" | "short" | "both";
    emaFastPeriod: number;
    emaSlowPeriod: number;
    rsiPeriod: number;
    rsiOversold: number;
    rsiOverbought: number;
  };
  filters: {
    minimumVolume24hUsdt: number;
    minimumAtrPercent: number;
    maximumAtrPercent: number;
  };
  risk: {
    riskPerTradePercent: number;
    maxOpenPositions: number;
    maxDailyLossPercent: number;
  };
  entry: { orderType: "market" | "limit"; limitOffsetBps: number };
  exit: { stopLossPercent: number; takeProfitPercent: number; trailingStopPercent: number };
  costs: { makerFeeBps: number; takerFeeBps: number; slippageBps: number };
  schedule: {
    timezone: string;
    activeDays: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
  };
};

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

type EnrichedCandle = ValidationCandle & {
  emaFast: number | null;
  emaSlow: number | null;
  previousEmaFast: number | null;
  previousEmaSlow: number | null;
  rsi: number | null;
  atrPercent: number | null;
  volume24h: number;
};

type OpenPosition = {
  symbol: string;
  side: "long" | "short";
  openedAt: Date;
  entryPrice: number;
  quantity: number;
  stopPrice: number;
  takePrice: number;
  trailingPrice: number | null;
  bestPrice: number;
  entryFee: number;
};

type PendingSignal = {
  side: "long" | "short";
  signalPrice: number;
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
  const bySymbol = new Map<string, EnrichedCandle[]>();
  for (const candle of input.candles) {
    const candles = bySymbol.get(candle.symbol) ?? [];
    candles.push(candle as EnrichedCandle);
    bySymbol.set(candle.symbol, candles);
  }
  for (const [symbol, candles] of bySymbol) {
    bySymbol.set(symbol, enrichCandles(candles, input.config));
  }

  const groups = new Map<number, EnrichedCandle[]>();
  for (const candles of bySymbol.values()) {
    for (const candle of candles) {
      const time = candle.openTime.getTime();
      groups.set(time, [...(groups.get(time) ?? []), candle]);
    }
  }

  const positions = new Map<string, OpenPosition>();
  const pendingSignals = new Map<string, PendingSignal>();
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
      const closed = tryClosePosition(position, candle, input.config);
      if (closed) {
        positions.delete(candle.symbol);
        trades.push(closed);
        equity += closed.netPnl;
        const day = getDateKey(new Date(closed.closedAt), input.config.schedule.timezone);
        dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + closed.netPnl);
      } else {
        updateTrailingPosition(position, candle, input.config);
      }
    }

    for (const candle of candles.sort((left, right) => left.symbol.localeCompare(right.symbol))) {
      const signal = pendingSignals.get(candle.symbol);
      pendingSignals.delete(candle.symbol);
      if (!signal || positions.has(candle.symbol)) continue;
      if (positions.size >= input.config.risk.maxOpenPositions) continue;
      if (entryFrom !== null && time < entryFrom) continue;
      if (entryTo !== null && time > entryTo) continue;
      const day = getDateKey(candle.openTime, input.config.schedule.timezone);
      const lossLimit = input.initialCapital * (input.config.risk.maxDailyLossPercent / 100);
      if ((dailyPnl.get(day) ?? 0) <= -lossLimit) continue;
      const position = openPosition(
        signal,
        candle,
        equity,
        Math.max(0, equity) / input.config.risk.maxOpenPositions,
        input.config,
      );
      if (!position) continue;
      const closed = tryClosePosition(position, candle, input.config);
      if (closed) {
        trades.push(closed);
        equity += closed.netPnl;
        dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + closed.netPnl);
      } else {
        updateTrailingPosition(position, candle, input.config);
        positions.set(candle.symbol, position);
      }
    }

    for (const candle of candles) {
      if (!positions.has(candle.symbol) && canSignal(candle, input.config)) {
        const signal = getSignal(candle, input.config);
        if (signal) {
          pendingSignals.set(candle.symbol, { side: signal, signalPrice: candle.close });
        }
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
    const closed = closePosition(
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

function enrichCandles(
  candles: ValidationCandle[],
  config: ValidationStrategyConfig,
): EnrichedCandle[] {
  const ordered = [...candles].sort(
    (left, right) => left.openTime.getTime() - right.openTime.getTime(),
  );
  const closes = ordered.map((candle) => candle.close);
  const fast = emaSeries(closes, config.signal.emaFastPeriod);
  const slow = emaSeries(closes, config.signal.emaSlowPeriod);
  const rsi = rsiSeries(closes, config.signal.rsiPeriod);
  const atr = atrSeries(ordered, 14);
  const volumeBars = Math.max(1, Math.round(1_440 / timeframeMinutes[config.universe.timeframe]));
  let rollingVolume = 0;

  return ordered.map((candle, index) => {
    rollingVolume += candle.turnover;
    if (index >= volumeBars) rollingVolume -= ordered[index - volumeBars]!.turnover;
    return {
      ...candle,
      emaFast: fast[index] ?? null,
      emaSlow: slow[index] ?? null,
      previousEmaFast: index > 0 ? (fast[index - 1] ?? null) : null,
      previousEmaSlow: index > 0 ? (slow[index - 1] ?? null) : null,
      rsi: rsi[index] ?? null,
      atrPercent:
        atr[index] === null || candle.close === 0 ? null : (atr[index]! / candle.close) * 100,
      volume24h: rollingVolume,
    };
  });
}

function canSignal(candle: EnrichedCandle, config: ValidationStrategyConfig): boolean {
  if (
    candle.emaFast === null ||
    candle.previousEmaFast === null ||
    candle.previousEmaSlow === null ||
    candle.rsi === null ||
    candle.atrPercent === null
  ) {
    return false;
  }
  if (candle.volume24h < config.filters.minimumVolume24hUsdt) return false;
  if (
    candle.atrPercent < config.filters.minimumAtrPercent ||
    candle.atrPercent > config.filters.maximumAtrPercent
  ) {
    return false;
  }
  return config.schedule.activeDays.includes(getWeekday(candle.openTime, config.schedule.timezone));
}

function getSignal(
  candle: EnrichedCandle,
  config: ValidationStrategyConfig,
): "long" | "short" | null {
  const crossedUp =
    candle.previousEmaFast! <= candle.previousEmaSlow! && candle.emaFast! > candle.emaSlow!;
  const crossedDown =
    candle.previousEmaFast! >= candle.previousEmaSlow! && candle.emaFast! < candle.emaSlow!;
  if (
    crossedUp &&
    candle.rsi! < config.signal.rsiOverbought &&
    (config.signal.direction === "long" || config.signal.direction === "both")
  ) {
    return "long";
  }
  if (
    crossedDown &&
    candle.rsi! > config.signal.rsiOversold &&
    (config.signal.direction === "short" || config.signal.direction === "both")
  ) {
    return "short";
  }
  return null;
}

function openPosition(
  signal: PendingSignal,
  candle: EnrichedCandle,
  equity: number,
  maximumNotional: number,
  config: ValidationStrategyConfig,
): OpenPosition | null {
  const side = signal.side;
  const slippage = config.costs.slippageBps / 10_000;
  const limitOffset = config.entry.limitOffsetBps / 10_000;
  const limitPrice = signal.signalPrice * (side === "long" ? 1 - limitOffset : 1 + limitOffset);
  if (
    config.entry.orderType === "limit" &&
    ((side === "long" && candle.low > limitPrice) || (side === "short" && candle.high < limitPrice))
  ) {
    return null;
  }
  const entryPrice =
    config.entry.orderType === "limit"
      ? limitPrice
      : candle.open * (side === "long" ? 1 + slippage : 1 - slippage);
  const stopDistance = entryPrice * (config.exit.stopLossPercent / 100);
  const riskAmount = Math.max(0, equity) * (config.risk.riskPerTradePercent / 100);
  const riskSizedQuantity = stopDistance > 0 ? riskAmount / stopDistance : 0;
  const quantity = Math.min(riskSizedQuantity, maximumNotional / entryPrice);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const stopPrice =
    entryPrice *
    (side === "long"
      ? 1 - config.exit.stopLossPercent / 100
      : 1 + config.exit.stopLossPercent / 100);
  const takePrice =
    entryPrice *
    (side === "long"
      ? 1 + config.exit.takeProfitPercent / 100
      : 1 - config.exit.takeProfitPercent / 100);
  const feeBps =
    config.entry.orderType === "limit" ? config.costs.makerFeeBps : config.costs.takerFeeBps;
  return {
    symbol: candle.symbol,
    side,
    openedAt: candle.openTime,
    entryPrice,
    quantity,
    stopPrice,
    takePrice,
    trailingPrice: null,
    bestPrice: entryPrice,
    entryFee: entryPrice * quantity * (feeBps / 10_000),
  };
}

function tryClosePosition(
  position: OpenPosition,
  candle: EnrichedCandle,
  config: ValidationStrategyConfig,
): ValidationTrade | null {
  if (position.side === "long") {
    if (candle.low <= position.stopPrice) {
      const exitPrice = candle.open <= position.stopPrice ? candle.open : position.stopPrice;
      return closePosition(position, exitPrice, candle.openTime, "stop-loss", config);
    }
    if (position.trailingPrice !== null && candle.low <= position.trailingPrice) {
      const exitPrice =
        candle.open <= position.trailingPrice ? candle.open : position.trailingPrice;
      return closePosition(position, exitPrice, candle.openTime, "trailing-stop", config);
    }
    if (candle.high >= position.takePrice)
      return closePosition(position, position.takePrice, candle.openTime, "take-profit", config);
  } else {
    if (candle.high >= position.stopPrice) {
      const exitPrice = candle.open >= position.stopPrice ? candle.open : position.stopPrice;
      return closePosition(position, exitPrice, candle.openTime, "stop-loss", config);
    }
    if (position.trailingPrice !== null && candle.high >= position.trailingPrice) {
      const exitPrice =
        candle.open >= position.trailingPrice ? candle.open : position.trailingPrice;
      return closePosition(position, exitPrice, candle.openTime, "trailing-stop", config);
    }
    if (candle.low <= position.takePrice)
      return closePosition(position, position.takePrice, candle.openTime, "take-profit", config);
  }
  return null;
}

function updateTrailingPosition(
  position: OpenPosition,
  candle: EnrichedCandle,
  config: ValidationStrategyConfig,
) {
  if (config.exit.trailingStopPercent <= 0) return;
  if (position.side === "long") {
    position.bestPrice = Math.max(position.bestPrice, candle.high);
    position.trailingPrice = position.bestPrice * (1 - config.exit.trailingStopPercent / 100);
  } else {
    position.bestPrice = Math.min(position.bestPrice, candle.low);
    position.trailingPrice = position.bestPrice * (1 + config.exit.trailingStopPercent / 100);
  }
}

function closePosition(
  position: OpenPosition,
  rawExitPrice: number,
  closedAt: Date,
  exitReason: ValidationTrade["exitReason"],
  config: ValidationStrategyConfig,
): ValidationTrade {
  const slippage = config.costs.slippageBps / 10_000;
  const exitPrice = rawExitPrice * (position.side === "long" ? 1 - slippage : 1 + slippage);
  const direction = position.side === "long" ? 1 : -1;
  const grossPnl = (exitPrice - position.entryPrice) * position.quantity * direction;
  const exitFee = exitPrice * position.quantity * (config.costs.takerFeeBps / 10_000);
  const fees = position.entryFee + exitFee;
  return {
    symbol: position.symbol,
    side: position.side,
    openedAt: position.openedAt.toISOString(),
    closedAt: closedAt.toISOString(),
    entryPrice: round(position.entryPrice),
    exitPrice: round(exitPrice),
    quantity: round(position.quantity),
    netPnl: round(grossPnl - fees),
    fees: round(fees),
    exitReason,
  };
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

function emaSeries(values: number[], period: number): Array<number | null> {
  const result = Array<number | null>(values.length).fill(null);
  if (values.length < period) return result;
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = ema;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    ema = (values[index]! - ema) * multiplier + ema;
    result[index] = ema;
  }
  return result;
}

function rsiSeries(values: number[], period: number): Array<number | null> {
  const result = Array<number | null>(values.length).fill(null);
  if (values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = rsiValue(averageGain, averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = rsiValue(averageGain, averageLoss);
  }
  return result;
}

function rsiValue(gain: number, loss: number): number {
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function atrSeries(candles: ValidationCandle[], period: number): Array<number | null> {
  const result = Array<number | null>(candles.length).fill(null);
  const ranges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const previousClose = candles[index - 1]!.close;
    ranges.push(
      Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose),
      ),
    );
    if (ranges.length >= period) {
      result[index] = ranges.slice(-period).reduce((sum, value) => sum + value, 0) / period;
    }
  }
  return result;
}

function getWeekday(
  date: Date,
  timezone: string,
): ValidationStrategyConfig["schedule"]["activeDays"][number] {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone })
    .format(date)
    .toLowerCase();
  return weekday.slice(0, 3) as ValidationStrategyConfig["schedule"]["activeDays"][number];
}

function getDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
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
