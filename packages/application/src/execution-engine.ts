export type ExecutionCandle = {
  symbol: string;
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover: number;
};

export type ExecutionStrategyConfig = {
  universe: { timeframe: "5m" | "15m" | "30m" | "1h" | "4h" };
  signal: {
    family: "ema-crossover" | "breakout" | "mean-reversion" | "momentum";
    direction: "long" | "short" | "both";
    emaFastPeriod: number;
    emaSlowPeriod: number;
    rsiPeriod: number;
    rsiOversold: number;
    rsiOverbought: number;
    breakoutLookbackPeriod: number;
    meanReversionLookbackPeriod: number;
    meanReversionEntryZScore: number;
    momentumLookbackPeriod: number;
    momentumThresholdPercent: number;
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

export type EnrichedExecutionCandle = ExecutionCandle & {
  emaFast: number | null;
  emaSlow: number | null;
  previousEmaFast: number | null;
  previousEmaSlow: number | null;
  rsi: number | null;
  previousRsi: number | null;
  atrPercent: number | null;
  volume24h: number;
  breakoutHigh: number | null;
  breakoutLow: number | null;
  meanReversionZScore: number | null;
  previousMeanReversionZScore: number | null;
  momentumPercent: number | null;
  previousMomentumPercent: number | null;
};

export type ExecutionPosition = {
  symbol: string;
  side: "long" | "short";
  entryRegime: ExecutionMarketRegime;
  entrySession: ExecutionTradingSession;
  openedAt: Date;
  entryPrice: number;
  quantity: number;
  stopPrice: number;
  takePrice: number;
  trailingPrice: number | null;
  bestPrice: number;
  entryFee: number;
  entrySlippage: number;
};

export type PendingExecutionSignal = {
  side: "long" | "short";
  signalPrice: number;
};

export type ExecutionQuote = {
  symbol: string;
  price: number;
  observedAt: Date;
};

export type ExecutionMarketRegime = "bull" | "bear" | "neutral" | "unknown";
export type ExecutionTradingSession = "asia" | "europe" | "us" | "off-hours" | "unknown";

export type AutomaticExitReason = "stop-loss" | "take-profit" | "trailing-stop" | "signal-exit";
export type ExecutionExitReason = AutomaticExitReason | "end-of-data" | "manual";

export type ExecutionSettlement<Reason extends ExecutionExitReason = ExecutionExitReason> = {
  symbol: string;
  side: "long" | "short";
  entryRegime: ExecutionMarketRegime;
  entrySession: ExecutionTradingSession;
  openedAt: string;
  closedAt: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  netPnl: number;
  fees: number;
  slippage: number;
  exitReason: Reason;
};

export function enrichExecutionCandles(
  candles: ExecutionCandle[],
  config: ExecutionStrategyConfig,
): EnrichedExecutionCandle[] {
  const ordered = [...candles].sort(
    (left, right) => left.openTime.getTime() - right.openTime.getTime(),
  );
  const closes = ordered.map((candle) => candle.close);
  const fast = emaSeries(closes, config.signal.emaFastPeriod);
  const slow = emaSeries(closes, config.signal.emaSlowPeriod);
  const rsi = rsiSeries(closes, config.signal.rsiPeriod);
  const atr = atrSeries(ordered, 14);
  const breakoutHigh = rollingExtremeSeries(
    ordered,
    config.signal.breakoutLookbackPeriod,
    (candle) => candle.high,
    (candidate, current) => candidate >= current,
  );
  const breakoutLow = rollingExtremeSeries(
    ordered,
    config.signal.breakoutLookbackPeriod,
    (candle) => candle.low,
    (candidate, current) => candidate <= current,
  );
  const meanReversionZScore = rollingZScoreSeries(
    closes,
    config.signal.meanReversionLookbackPeriod,
  );
  const momentumPercent = momentumSeries(closes, config.signal.momentumLookbackPeriod);
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
      previousRsi: index > 0 ? (rsi[index - 1] ?? null) : null,
      atrPercent:
        atr[index] === null || candle.close === 0 ? null : (atr[index]! / candle.close) * 100,
      volume24h: rollingVolume,
      breakoutHigh: breakoutHigh[index] ?? null,
      breakoutLow: breakoutLow[index] ?? null,
      meanReversionZScore: meanReversionZScore[index] ?? null,
      previousMeanReversionZScore: index > 0 ? (meanReversionZScore[index - 1] ?? null) : null,
      momentumPercent: momentumPercent[index] ?? null,
      previousMomentumPercent: index > 0 ? (momentumPercent[index - 1] ?? null) : null,
    };
  });
}

export function getExecutionSignal(
  candle: EnrichedExecutionCandle,
  config: ExecutionStrategyConfig,
): PendingExecutionSignal | null {
  if (!canSignal(candle, config)) return null;
  if (config.signal.family === "breakout") return getBreakoutSignal(candle, config);
  if (config.signal.family === "mean-reversion") return getMeanReversionSignal(candle, config);
  if (config.signal.family === "momentum") return getMomentumSignal(candle, config);

  const crossedUp =
    candle.previousEmaFast! <= candle.previousEmaSlow! && candle.emaFast! > candle.emaSlow!;
  const crossedDown =
    candle.previousEmaFast! >= candle.previousEmaSlow! && candle.emaFast! < candle.emaSlow!;
  if (
    crossedUp &&
    candle.rsi! < config.signal.rsiOverbought &&
    (config.signal.direction === "long" || config.signal.direction === "both")
  ) {
    return { side: "long", signalPrice: candle.close };
  }
  if (
    crossedDown &&
    candle.rsi! > config.signal.rsiOversold &&
    (config.signal.direction === "short" || config.signal.direction === "both")
  ) {
    return { side: "short", signalPrice: candle.close };
  }
  return null;
}

function getBreakoutSignal(
  candle: EnrichedExecutionCandle,
  config: ExecutionStrategyConfig,
): PendingExecutionSignal | null {
  if (
    candle.breakoutHigh !== null &&
    candle.close > candle.breakoutHigh &&
    allowsDirection(config, "long")
  ) {
    return { side: "long", signalPrice: candle.close };
  }
  if (
    candle.breakoutLow !== null &&
    candle.close < candle.breakoutLow &&
    allowsDirection(config, "short")
  ) {
    return { side: "short", signalPrice: candle.close };
  }
  return null;
}

function getMeanReversionSignal(
  candle: EnrichedExecutionCandle,
  config: ExecutionStrategyConfig,
): PendingExecutionSignal | null {
  const current = candle.meanReversionZScore!;
  const previous = candle.previousMeanReversionZScore!;
  const threshold = config.signal.meanReversionEntryZScore;
  if (
    previous <= -threshold &&
    current > -threshold &&
    candle.previousRsi! <= config.signal.rsiOversold &&
    allowsDirection(config, "long")
  ) {
    return { side: "long", signalPrice: candle.close };
  }
  if (
    previous >= threshold &&
    current < threshold &&
    candle.previousRsi! >= config.signal.rsiOverbought &&
    allowsDirection(config, "short")
  ) {
    return { side: "short", signalPrice: candle.close };
  }
  return null;
}

function getMomentumSignal(
  candle: EnrichedExecutionCandle,
  config: ExecutionStrategyConfig,
): PendingExecutionSignal | null {
  const current = candle.momentumPercent!;
  const previous = candle.previousMomentumPercent!;
  const threshold = config.signal.momentumThresholdPercent;
  if (previous < threshold && current >= threshold && allowsDirection(config, "long")) {
    return { side: "long", signalPrice: candle.close };
  }
  if (previous > -threshold && current <= -threshold && allowsDirection(config, "short")) {
    return { side: "short", signalPrice: candle.close };
  }
  return null;
}

function allowsDirection(config: ExecutionStrategyConfig, side: "long" | "short"): boolean {
  return config.signal.direction === "both" || config.signal.direction === side;
}

export function openExecutionPosition(
  signal: PendingExecutionSignal,
  candle: EnrichedExecutionCandle,
  equity: number,
  maximumNotional: number,
  config: ExecutionStrategyConfig,
): ExecutionPosition | null {
  const side = signal.side;
  const slippageRate = config.costs.slippageBps / 10_000;
  const limitOffset = config.entry.limitOffsetBps / 10_000;
  const limitPrice = signal.signalPrice * (side === "long" ? 1 - limitOffset : 1 + limitOffset);
  if (
    config.entry.orderType === "limit" &&
    ((side === "long" && candle.low > limitPrice) || (side === "short" && candle.high < limitPrice))
  ) {
    return null;
  }
  const referencePrice = config.entry.orderType === "limit" ? limitPrice : candle.open;
  const entryPrice =
    config.entry.orderType === "limit"
      ? limitPrice
      : referencePrice * (side === "long" ? 1 + slippageRate : 1 - slippageRate);
  return createExecutionPosition({
    signal,
    symbol: candle.symbol,
    referencePrice,
    entryPrice,
    openedAt: candle.openTime,
    entryRegime: getExecutionMarketRegime(candle),
    entrySession: getExecutionTradingSession(candle.openTime),
    equity,
    maximumNotional,
    feeBps:
      config.entry.orderType === "limit" ? config.costs.makerFeeBps : config.costs.takerFeeBps,
    config,
  });
}

export function openExecutionPositionAtQuote(
  signal: PendingExecutionSignal,
  quote: ExecutionQuote,
  entryRegime: ExecutionMarketRegime,
  equity: number,
  maximumNotional: number,
  config: ExecutionStrategyConfig,
): ExecutionPosition | null {
  const limitOffset = config.entry.limitOffsetBps / 10_000;
  const limitPrice =
    signal.signalPrice * (signal.side === "long" ? 1 - limitOffset : 1 + limitOffset);
  if (
    config.entry.orderType === "limit" &&
    ((signal.side === "long" && quote.price > limitPrice) ||
      (signal.side === "short" && quote.price < limitPrice))
  ) {
    return null;
  }
  const referencePrice = config.entry.orderType === "limit" ? limitPrice : quote.price;
  const slippageRate = config.costs.slippageBps / 10_000;
  const entryPrice =
    config.entry.orderType === "limit"
      ? limitPrice
      : referencePrice * (signal.side === "long" ? 1 + slippageRate : 1 - slippageRate);
  return createExecutionPosition({
    signal,
    symbol: quote.symbol,
    referencePrice,
    entryPrice,
    openedAt: quote.observedAt,
    entryRegime,
    entrySession: getExecutionTradingSession(quote.observedAt),
    equity,
    maximumNotional,
    feeBps:
      config.entry.orderType === "limit" ? config.costs.makerFeeBps : config.costs.takerFeeBps,
    config,
  });
}

function createExecutionPosition({
  signal,
  symbol,
  referencePrice,
  entryPrice,
  openedAt,
  entryRegime,
  entrySession,
  equity,
  maximumNotional,
  feeBps,
  config,
}: {
  signal: PendingExecutionSignal;
  symbol: string;
  referencePrice: number;
  entryPrice: number;
  openedAt: Date;
  entryRegime: ExecutionMarketRegime;
  entrySession: ExecutionTradingSession;
  equity: number;
  maximumNotional: number;
  feeBps: number;
  config: ExecutionStrategyConfig;
}): ExecutionPosition | null {
  const side = signal.side;
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
  return {
    symbol,
    side,
    entryRegime,
    entrySession,
    openedAt,
    entryPrice,
    quantity,
    stopPrice,
    takePrice,
    trailingPrice: null,
    bestPrice: entryPrice,
    entryFee: entryPrice * quantity * (feeBps / 10_000),
    entrySlippage: Math.abs(entryPrice - referencePrice) * quantity,
  };
}

export function evaluateExecutionExit(
  position: ExecutionPosition,
  candle: EnrichedExecutionCandle,
  config: ExecutionStrategyConfig,
): ExecutionSettlement<AutomaticExitReason> | null {
  if (position.side === "long") {
    if (candle.low <= position.stopPrice) {
      const exitPrice = candle.open <= position.stopPrice ? candle.open : position.stopPrice;
      return settleExecutionPosition(position, exitPrice, candle.openTime, "stop-loss", config);
    }
    if (position.trailingPrice !== null && candle.low <= position.trailingPrice) {
      const exitPrice =
        candle.open <= position.trailingPrice ? candle.open : position.trailingPrice;
      return settleExecutionPosition(position, exitPrice, candle.openTime, "trailing-stop", config);
    }
    if (candle.high >= position.takePrice) {
      return settleExecutionPosition(
        position,
        position.takePrice,
        candle.openTime,
        "take-profit",
        config,
      );
    }
  } else {
    if (candle.high >= position.stopPrice) {
      const exitPrice = candle.open >= position.stopPrice ? candle.open : position.stopPrice;
      return settleExecutionPosition(position, exitPrice, candle.openTime, "stop-loss", config);
    }
    if (position.trailingPrice !== null && candle.high >= position.trailingPrice) {
      const exitPrice =
        candle.open >= position.trailingPrice ? candle.open : position.trailingPrice;
      return settleExecutionPosition(position, exitPrice, candle.openTime, "trailing-stop", config);
    }
    if (candle.low <= position.takePrice) {
      return settleExecutionPosition(
        position,
        position.takePrice,
        candle.openTime,
        "take-profit",
        config,
      );
    }
  }
  return evaluateExecutionSignalExit(position, candle, config);
}

export function evaluateExecutionPriceExit(
  position: ExecutionPosition,
  quote: ExecutionQuote,
  config: ExecutionStrategyConfig,
): ExecutionSettlement<Exclude<AutomaticExitReason, "signal-exit">> | null {
  if (position.side === "long") {
    if (quote.price <= position.stopPrice) {
      return settleExecutionPosition(position, quote.price, quote.observedAt, "stop-loss", config);
    }
    if (position.trailingPrice !== null && quote.price <= position.trailingPrice) {
      return settleExecutionPosition(
        position,
        quote.price,
        quote.observedAt,
        "trailing-stop",
        config,
      );
    }
    if (quote.price >= position.takePrice) {
      return settleExecutionPosition(
        position,
        position.takePrice,
        quote.observedAt,
        "take-profit",
        config,
      );
    }
  } else {
    if (quote.price >= position.stopPrice) {
      return settleExecutionPosition(position, quote.price, quote.observedAt, "stop-loss", config);
    }
    if (position.trailingPrice !== null && quote.price >= position.trailingPrice) {
      return settleExecutionPosition(
        position,
        quote.price,
        quote.observedAt,
        "trailing-stop",
        config,
      );
    }
    if (quote.price <= position.takePrice) {
      return settleExecutionPosition(
        position,
        position.takePrice,
        quote.observedAt,
        "take-profit",
        config,
      );
    }
  }
  return null;
}

export function evaluateExecutionSignalExit(
  position: ExecutionPosition,
  candle: EnrichedExecutionCandle,
  config: ExecutionStrategyConfig,
  closedAt = candle.openTime,
): ExecutionSettlement<"signal-exit"> | null {
  if (
    config.signal.family !== "mean-reversion" ||
    candle.meanReversionZScore === null ||
    !(
      (position.side === "long" && candle.meanReversionZScore >= 0) ||
      (position.side === "short" && candle.meanReversionZScore <= 0)
    )
  ) {
    return null;
  }
  return settleExecutionPosition(position, candle.close, closedAt, "signal-exit", config);
}

export function updateExecutionTrailing(
  position: ExecutionPosition,
  candle: EnrichedExecutionCandle,
  config: ExecutionStrategyConfig,
): ExecutionPosition {
  if (config.exit.trailingStopPercent <= 0) return { ...position };
  if (position.side === "long") {
    const bestPrice = Math.max(position.bestPrice, candle.high);
    return {
      ...position,
      bestPrice,
      trailingPrice: bestPrice * (1 - config.exit.trailingStopPercent / 100),
    };
  }
  const bestPrice = Math.min(position.bestPrice, candle.low);
  return {
    ...position,
    bestPrice,
    trailingPrice: bestPrice * (1 + config.exit.trailingStopPercent / 100),
  };
}

export function updateExecutionTrailingAtPrice(
  position: ExecutionPosition,
  price: number,
  config: ExecutionStrategyConfig,
): ExecutionPosition {
  if (config.exit.trailingStopPercent <= 0) return { ...position };
  if (position.side === "long") {
    const bestPrice = Math.max(position.bestPrice, price);
    return {
      ...position,
      bestPrice,
      trailingPrice: bestPrice * (1 - config.exit.trailingStopPercent / 100),
    };
  }
  const bestPrice = Math.min(position.bestPrice, price);
  return {
    ...position,
    bestPrice,
    trailingPrice: bestPrice * (1 + config.exit.trailingStopPercent / 100),
  };
}

export function settleExecutionPosition<Reason extends ExecutionExitReason>(
  position: ExecutionPosition,
  rawExitPrice: number,
  closedAt: Date,
  exitReason: Reason,
  config: ExecutionStrategyConfig,
): ExecutionSettlement<Reason> {
  const slippageRate = config.costs.slippageBps / 10_000;
  const exitPrice = rawExitPrice * (position.side === "long" ? 1 - slippageRate : 1 + slippageRate);
  const direction = position.side === "long" ? 1 : -1;
  const grossPnl = (exitPrice - position.entryPrice) * position.quantity * direction;
  const exitFee = exitPrice * position.quantity * (config.costs.takerFeeBps / 10_000);
  const fees = position.entryFee + exitFee;
  const exitSlippage = Math.abs(exitPrice - rawExitPrice) * position.quantity;
  return {
    symbol: position.symbol,
    side: position.side,
    entryRegime: position.entryRegime,
    entrySession: position.entrySession,
    openedAt: position.openedAt.toISOString(),
    closedAt: closedAt.toISOString(),
    entryPrice: roundExecutionValue(position.entryPrice),
    exitPrice: roundExecutionValue(exitPrice),
    quantity: roundExecutionValue(position.quantity),
    grossPnl: roundExecutionValue(grossPnl),
    netPnl: roundExecutionValue(grossPnl - fees),
    fees: roundExecutionValue(fees),
    slippage: roundExecutionValue(position.entrySlippage + exitSlippage),
    exitReason,
  };
}

export function executionUnrealizedPnl(position: ExecutionPosition, markPrice: number): number {
  const direction = position.side === "long" ? 1 : -1;
  return roundExecutionValue((markPrice - position.entryPrice) * position.quantity * direction);
}

export function getExecutionMarketRegime(
  candle: Pick<EnrichedExecutionCandle, "emaFast" | "emaSlow">,
): ExecutionMarketRegime {
  if (candle.emaFast === null || candle.emaSlow === null) return "unknown";
  if (candle.emaFast > candle.emaSlow) return "bull";
  if (candle.emaFast < candle.emaSlow) return "bear";
  return "neutral";
}

export function getExecutionTradingSession(date: Date): ExecutionTradingSession {
  const hour = date.getUTCHours();
  if (hour < 8) return "asia";
  if (hour < 13) return "europe";
  if (hour < 21) return "us";
  return "off-hours";
}

export function minimumExecutionCandleCount(config: ExecutionStrategyConfig): number {
  const volumeBars = Math.round(1_440 / timeframeMinutes[config.universe.timeframe]);
  const familyLookback =
    config.signal.family === "breakout"
      ? config.signal.breakoutLookbackPeriod
      : config.signal.family === "mean-reversion"
        ? config.signal.meanReversionLookbackPeriod
        : config.signal.family === "momentum"
          ? config.signal.momentumLookbackPeriod
          : config.signal.emaSlowPeriod;
  return Math.max(
    config.signal.emaSlowPeriod + 2,
    config.signal.rsiPeriod + 2,
    familyLookback + 2,
    volumeBars + 2,
    16,
  );
}

export function getTradingDateKey(date: Date, timezone: string): string {
  const parts = getDateKeyFormatter(timezone).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function canSignal(candle: EnrichedExecutionCandle, config: ExecutionStrategyConfig): boolean {
  if (candle.atrPercent === null) return false;
  if (candle.volume24h < config.filters.minimumVolume24hUsdt) return false;
  if (
    candle.atrPercent < config.filters.minimumAtrPercent ||
    candle.atrPercent > config.filters.maximumAtrPercent
  ) {
    return false;
  }
  if (
    config.schedule.activeDays.length < 7 &&
    !config.schedule.activeDays.includes(getWeekday(candle.openTime, config.schedule.timezone))
  ) {
    return false;
  }
  if (config.signal.family === "breakout") {
    return candle.breakoutHigh !== null && candle.breakoutLow !== null;
  }
  if (config.signal.family === "mean-reversion") {
    return (
      candle.meanReversionZScore !== null &&
      candle.previousMeanReversionZScore !== null &&
      candle.rsi !== null &&
      candle.previousRsi !== null
    );
  }
  if (config.signal.family === "momentum") {
    return candle.momentumPercent !== null && candle.previousMomentumPercent !== null;
  }
  return (
    candle.emaFast !== null &&
    candle.emaSlow !== null &&
    candle.previousEmaFast !== null &&
    candle.previousEmaSlow !== null &&
    candle.rsi !== null
  );
}

function rollingExtremeSeries(
  candles: ExecutionCandle[],
  period: number,
  select: (candle: ExecutionCandle) => number,
  shouldReplace: (candidate: number, current: number) => boolean,
): Array<number | null> {
  const result = Array<number | null>(candles.length).fill(null);
  const indices: number[] = [];
  let head = 0;
  for (let index = 0; index < candles.length; index += 1) {
    while (head < indices.length && indices[head]! < index - period) head += 1;
    if (index >= period && head < indices.length) {
      result[index] = select(candles[indices[head]!]!);
    }
    const current = select(candles[index]!);
    while (indices.length > head && shouldReplace(current, select(candles[indices.at(-1)!]!))) {
      indices.pop();
    }
    indices.push(index);
    if (head > 1_024 && head * 2 > indices.length) {
      indices.splice(0, head);
      head = 0;
    }
  }
  return result;
}

function rollingZScoreSeries(values: number[], period: number): Array<number | null> {
  const result = Array<number | null>(values.length).fill(null);
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    sum += value;
    sumSquares += value * value;
    if (index >= period) {
      const removed = values[index - period]!;
      sum -= removed;
      sumSquares -= removed * removed;
    }
    if (index < period - 1) continue;
    const mean = sum / period;
    const variance = Math.max(0, sumSquares / period - mean * mean);
    const deviation = Math.sqrt(variance);
    result[index] = deviation === 0 ? 0 : (value - mean) / deviation;
  }
  return result;
}

function momentumSeries(values: number[], period: number): Array<number | null> {
  return values.map((value, index) => {
    if (index < period) return null;
    const previous = values[index - period]!;
    return previous === 0 ? null : (value / previous - 1) * 100;
  });
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

function atrSeries(candles: ExecutionCandle[], period: number): Array<number | null> {
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
): ExecutionStrategyConfig["schedule"]["activeDays"][number] {
  const weekday = getWeekdayFormatter(timezone).format(date).toLowerCase();
  return weekday.slice(0, 3) as ExecutionStrategyConfig["schedule"]["activeDays"][number];
}

function getDateKeyFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = dateKeyFormatters.get(timezone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  });
  dateKeyFormatters.set(timezone, formatter);
  return formatter;
}

function getWeekdayFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = weekdayFormatters.get(timezone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone });
  weekdayFormatters.set(timezone, formatter);
  return formatter;
}

function roundExecutionValue(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

const timeframeMinutes = { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 } as const;
const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();
