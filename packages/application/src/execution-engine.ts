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
  exit: {
    stopLossPercent: number;
    takeProfitPercent: number;
    trailingStopPercent: number;
    breakEvenActivationR: number;
    trailingActivationR: number;
    exitOnSignalReversal: boolean;
  };
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
  volume24h: number | null;
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
export type ExecutionExitReason =
  | AutomaticExitReason
  | "end-of-data"
  | "manual"
  | "recovery-exit"
  | "kill-switch"
  | "daily-loss-limit";

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

type EmaCheckpoint = { count: number; sum: number; value: number | null };
type RsiCheckpoint = { count: number; gain: number; loss: number; value: number | null };
type StoredIndicatorCandle = Omit<ExecutionCandle, "openTime"> & { openTime: string };

export type ExecutionIndicatorAnchor = {
  mode: "validation-dataset";
  datasetSnapshotId: string;
  contentHash: string;
  startsAt: string;
  seededThroughAt: string;
  validationRunId: string | null;
  validationEngineVersion: string | null;
};

export type ExecutionIndicatorCheckpoint = {
  anchor?: ExecutionIndicatorAnchor;
  version: string;
  configKey: string;
  symbol: string;
  lastCandleAt: string;
  fast: EmaCheckpoint;
  slow: EmaCheckpoint;
  rsi: RsiCheckpoint;
  previousClose: number;
  tail: StoredIndicatorCandle[];
  availableAt: string | null;
};

function indicatorConfigKey(config: ExecutionStrategyConfig): string {
  return JSON.stringify([
    config.universe.timeframe,
    config.signal.emaFastPeriod,
    config.signal.emaSlowPeriod,
    config.signal.rsiPeriod,
    config.signal.breakoutLookbackPeriod,
    config.signal.meanReversionLookbackPeriod,
    config.signal.momentumLookbackPeriod,
  ]);
}

export function readExecutionIndicatorCheckpoint(
  value: unknown,
  config: ExecutionStrategyConfig,
  symbol: string,
): ExecutionIndicatorCheckpoint | null {
  if (value === null || value === undefined) return null;
  const fail = (): never => {
    throw new Error("Invalid or incompatible indicator checkpoint");
  };
  if (typeof value !== "object" || Array.isArray(value)) return fail();
  const state = value as ExecutionIndicatorCheckpoint;
  const finite = (number: unknown) => typeof number === "number" && Number.isFinite(number);
  const time = (date: unknown) => typeof date === "string" && Number.isFinite(Date.parse(date));
  const ema = (part: EmaCheckpoint | undefined, period: number) =>
    part &&
    Number.isInteger(part.count) &&
    part.count >= 0 &&
    part.count <= period &&
    finite(part.sum) &&
    (part.count < period ? part.value === null : finite(part.value));
  const rsi = state.rsi;
  if (
    state.version !== executionIndicatorVersion ||
    state.configKey !== indicatorConfigKey(config) ||
    state.symbol !== symbol ||
    !time(state.lastCandleAt) ||
    !finite(state.previousClose) ||
    !ema(state.fast, config.signal.emaFastPeriod) ||
    !ema(state.slow, config.signal.emaSlowPeriod) ||
    !rsi ||
    !Number.isInteger(rsi.count) ||
    rsi.count < 0 ||
    rsi.count > config.signal.rsiPeriod ||
    !finite(rsi.gain) ||
    !finite(rsi.loss) ||
    rsi.gain < 0 ||
    rsi.loss < 0 ||
    (rsi.count < config.signal.rsiPeriod ? rsi.value !== null : !finite(rsi.value)) ||
    !(state.availableAt === null || time(state.availableAt)) ||
    !Array.isArray(state.tail) ||
    state.tail.length === 0 ||
    state.tail.length > minimumExecutionCandleCount(config)
  )
    return fail();
  const source = state.anchor;
  if (
    source !== undefined &&
    (!source ||
      source.mode !== "validation-dataset" ||
      typeof source.datasetSnapshotId !== "string" ||
      !source.datasetSnapshotId ||
      typeof source.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(source.contentHash) ||
      !time(source.startsAt) ||
      !time(source.seededThroughAt) ||
      Date.parse(source.startsAt) > Date.parse(source.seededThroughAt) ||
      Date.parse(source.seededThroughAt) > Date.parse(state.lastCandleAt) ||
      !(source.validationRunId === null || typeof source.validationRunId === "string") ||
      !(
        source.validationEngineVersion === null ||
        typeof source.validationEngineVersion === "string"
      ))
  )
    return fail();
  const intervalMs = timeframeMinutes[config.universe.timeframe] * 60_000;
  for (let index = 0; index < state.tail.length; index += 1) {
    const candle = state.tail[index];
    if (
      !candle ||
      candle.symbol !== symbol ||
      !time(candle.openTime) ||
      ![candle.open, candle.high, candle.low, candle.close, candle.turnover].every(finite) ||
      (index > 0 &&
        Date.parse(candle.openTime) - Date.parse(state.tail[index - 1]!.openTime) !== intervalMs)
    )
      return fail();
  }
  if (
    state.fast.count !== Math.min(config.signal.emaFastPeriod, state.tail.length) ||
    state.slow.count !== Math.min(config.signal.emaSlowPeriod, state.tail.length) ||
    state.rsi.count !== Math.min(config.signal.rsiPeriod, state.tail.length - 1) ||
    (state.rsi.value !== null && state.rsi.value !== rsiValue(state.rsi.gain, state.rsi.loss)) ||
    state.tail.at(-1)!.openTime !== state.lastCandleAt ||
    state.tail.at(-1)!.close !== state.previousClose
  )
    return fail();
  return structuredClone(state);
}

export function assertExecutionIndicatorHistory(
  candles: ExecutionCandle[],
  checkpoint: ExecutionIndicatorCheckpoint | null,
): void {
  if (!checkpoint) return;
  const tail = new Map(checkpoint.tail.map((candle) => [Date.parse(candle.openTime), candle]));
  for (const candle of candles) {
    const stored = tail.get(+candle.openTime);
    if (
      stored &&
      (stored.symbol !== candle.symbol ||
        stored.open !== candle.open ||
        stored.high !== candle.high ||
        stored.low !== candle.low ||
        stored.close !== candle.close ||
        stored.turnover !== candle.turnover)
    ) {
      throw new Error("Indicator checkpoint history was revised; explicit replay required");
    }
  }
}

export function enrichExecutionCandles(
  candles: ExecutionCandle[],
  config: ExecutionStrategyConfig,
): EnrichedExecutionCandle[] {
  const bySymbol = new Map<string, ExecutionCandle[]>();
  for (const candle of candles) {
    const history = bySymbol.get(candle.symbol) ?? [];
    history.push(candle);
    bySymbol.set(candle.symbol, history);
  }
  const result: EnrichedExecutionCandle[] = [];
  for (const history of bySymbol.values()) {
    for (const candle of advanceExecutionIndicators(history, config).candles) result.push(candle);
  }
  return result.sort((left, right) => +left.openTime - +right.openTime);
}

export function advanceExecutionIndicators(
  candles: ExecutionCandle[],
  config: ExecutionStrategyConfig,
  checkpoint: ExecutionIndicatorCheckpoint | null = null,
): { candles: EnrichedExecutionCandle[]; checkpoint: ExecutionIndicatorCheckpoint | null } {
  const ordered = [...candles].sort((left, right) => +left.openTime - +right.openTime);
  if (!ordered.length)
    return {
      candles: [],
      checkpoint: checkpoint
        ? readExecutionIndicatorCheckpoint(checkpoint, config, checkpoint.symbol)
        : null,
    };
  const symbol = ordered[0]!.symbol;
  let state = readExecutionIndicatorCheckpoint(checkpoint, config, symbol);
  if (ordered.some((candle) => candle.symbol !== symbol))
    throw new Error("Indicator checkpoint requires one symbol");
  if (state && +ordered[0]!.openTime <= Date.parse(state.lastCandleAt))
    throw new Error("Indicator replay must advance past checkpoint");
  const prefix =
    state?.tail.map((candle) => ({ ...candle, openTime: new Date(candle.openTime) })) ?? [];
  const enriched = enrichWindowCandles([...prefix, ...ordered], config).slice(prefix.length);
  const intervalMs = timeframeMinutes[config.universe.timeframe] * 60_000;
  const tailLimit = minimumExecutionCandleCount(config);
  let tail = state?.tail ?? [];
  for (let index = 0; index < ordered.length; index += 1) {
    const candle = ordered[index]!;
    if (!state || +candle.openTime - Date.parse(state.lastCandleAt) !== intervalMs) {
      state = {
        version: executionIndicatorVersion,
        configKey: indicatorConfigKey(config),
        symbol,
        lastCandleAt: candle.openTime.toISOString(),
        previousClose: candle.close,
        fast: { count: 0, sum: 0, value: null },
        slow: { count: 0, sum: 0, value: null },
        rsi: { count: 0, gain: 0, loss: 0, value: null },
        tail: [],
        availableAt: null,
      };
      tail = [];
    } else {
      const change = candle.close - state.previousClose;
      const rsi = state.rsi;
      const period = config.signal.rsiPeriod;
      if (rsi.count < period) {
        rsi.gain += Math.max(change, 0);
        rsi.loss += Math.max(-change, 0);
        rsi.count += 1;
        if (rsi.count === period) {
          rsi.gain /= period;
          rsi.loss /= period;
        }
      } else {
        rsi.gain = (rsi.gain * (period - 1) + Math.max(change, 0)) / period;
        rsi.loss = (rsi.loss * (period - 1) + Math.max(-change, 0)) / period;
      }
    }
    const result = enriched[index]!;
    result.previousEmaFast = state.fast.value;
    result.previousEmaSlow = state.slow.value;
    result.previousRsi = state.rsi.value;
    for (const [part, period] of [
      [state.fast, config.signal.emaFastPeriod],
      [state.slow, config.signal.emaSlowPeriod],
    ] as const) {
      if (part.count < period) {
        part.sum += candle.close;
        part.count += 1;
        if (part.count === period) part.value = part.sum / period;
      } else {
        part.value = (candle.close - part.value!) * (2 / (period + 1)) + part.value!;
      }
    }
    if (state.rsi.count === config.signal.rsiPeriod)
      state.rsi.value = rsiValue(state.rsi.gain, state.rsi.loss);
    result.emaFast = state.fast.value;
    result.emaSlow = state.slow.value;
    result.rsi = state.rsi.value;
    state.previousClose = candle.close;
    state.lastCandleAt = candle.openTime.toISOString();
    tail.push({
      symbol: candle.symbol,
      openTime: state.lastCandleAt,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      turnover: candle.turnover,
    });
    if (tail.length > tailLimit) tail = tail.slice(-tailLimit);
  }
  state!.tail = tail;
  return { candles: enriched, checkpoint: state };
}

function enrichWindowCandles(
  candles: ExecutionCandle[],
  config: ExecutionStrategyConfig,
): EnrichedExecutionCandle[] {
  const ordered = [...candles].sort(
    (left, right) => left.openTime.getTime() - right.openTime.getTime(),
  );
  const bySymbol = new Map<string, ExecutionCandle[]>();
  for (const candle of ordered) {
    const history = bySymbol.get(candle.symbol) ?? [];
    history.push(candle);
    bySymbol.set(candle.symbol, history);
  }
  const result: EnrichedExecutionCandle[] = [];
  const intervalMs = timeframeMinutes[config.universe.timeframe] * 60_000;
  for (const history of bySymbol.values()) {
    let start = 0;
    for (let index = 1; index <= history.length; index += 1) {
      if (index < history.length) {
        const distance =
          history[index]!.openTime.getTime() - history[index - 1]!.openTime.getTime();
        if (distance === 0) throw new Error("Duplicate execution candle");
        if (distance === intervalMs) continue;
      }
      for (const candle of enrichContinuousCandles(history.slice(start, index), config)) {
        result.push(candle);
      }
      start = index;
    }
  }
  return result.sort((left, right) => left.openTime.getTime() - right.openTime.getTime());
}

export const executionIndicatorVersion = "cryptoanal-indicators@2.0.0";

function enrichContinuousCandles(
  ordered: ExecutionCandle[],
  config: ExecutionStrategyConfig,
): EnrichedExecutionCandle[] {
  const closes = ordered.map((candle) => candle.close);
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
  return ordered.map((candle, index) => {
    const rollingVolume = ordered
      .slice(Math.max(0, index - volumeBars + 1), index + 1)
      .reduce((sum, value) => sum + value.turnover, 0);
    return {
      ...candle,
      emaFast: null,
      emaSlow: null,
      previousEmaFast: null,
      previousEmaSlow: null,
      rsi: null,
      previousRsi: null,
      atrPercent:
        atr[index] === null || candle.close === 0 ? null : (atr[index]! / candle.close) * 100,
      volume24h: index + 1 >= volumeBars ? rollingVolume : null,
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
  if (config.signal.family === "mean-reversion" && candle.meanReversionZScore !== null) {
    const returnedToMean =
      (position.side === "long" && candle.meanReversionZScore >= 0) ||
      (position.side === "short" && candle.meanReversionZScore <= 0);
    if (returnedToMean) {
      return settleExecutionPosition(position, candle.close, closedAt, "signal-exit", config);
    }
  }

  if (
    config.signal.family !== "ema-crossover" ||
    !config.exit.exitOnSignalReversal ||
    candle.emaFast === null ||
    candle.emaSlow === null ||
    candle.previousEmaFast === null ||
    candle.previousEmaSlow === null
  ) {
    return null;
  }
  const crossedUp =
    candle.previousEmaFast <= candle.previousEmaSlow && candle.emaFast > candle.emaSlow;
  const crossedDown =
    candle.previousEmaFast >= candle.previousEmaSlow && candle.emaFast < candle.emaSlow;
  const reversed =
    (position.side === "long" && crossedDown) || (position.side === "short" && crossedUp);
  return reversed
    ? settleExecutionPosition(position, candle.close, closedAt, "signal-exit", config)
    : null;
}

export function updateExecutionTrailing(
  position: ExecutionPosition,
  candle: EnrichedExecutionCandle,
  config: ExecutionStrategyConfig,
): ExecutionPosition {
  return updateExecutionProtection(
    position,
    position.side === "long" ? candle.high : candle.low,
    config,
  );
}

export function updateExecutionTrailingAtPrice(
  position: ExecutionPosition,
  price: number,
  config: ExecutionStrategyConfig,
): ExecutionPosition {
  return updateExecutionProtection(position, price, config);
}

function updateExecutionProtection(
  position: ExecutionPosition,
  observedPrice: number,
  config: ExecutionStrategyConfig,
): ExecutionPosition {
  const bestPrice =
    position.side === "long"
      ? Math.max(position.bestPrice, observedPrice)
      : Math.min(position.bestPrice, observedPrice);
  const initialRisk = position.entryPrice * (config.exit.stopLossPercent / 100);
  const favorableMove = (bestPrice - position.entryPrice) * (position.side === "long" ? 1 : -1);
  const reachedR = initialRisk > 0 ? favorableMove / initialRisk : 0;
  let stopPrice = position.stopPrice;
  let trailingPrice = position.trailingPrice;

  if (config.exit.breakEvenActivationR > 0 && reachedR >= config.exit.breakEvenActivationR) {
    const breakEvenPrice = executionBreakEvenPrice(position, config);
    stopPrice =
      position.side === "long"
        ? Math.max(stopPrice, breakEvenPrice)
        : Math.min(stopPrice, breakEvenPrice);
  }

  const trailingActive =
    config.exit.trailingStopPercent > 0 &&
    (config.exit.trailingActivationR <= 0 || reachedR >= config.exit.trailingActivationR);
  if (trailingActive) {
    const candidate =
      bestPrice *
      (position.side === "long"
        ? 1 - config.exit.trailingStopPercent / 100
        : 1 + config.exit.trailingStopPercent / 100);
    trailingPrice =
      trailingPrice === null
        ? candidate
        : position.side === "long"
          ? Math.max(trailingPrice, candidate)
          : Math.min(trailingPrice, candidate);
  }

  return { ...position, bestPrice, stopPrice, trailingPrice };
}

function executionBreakEvenPrice(
  position: ExecutionPosition,
  config: ExecutionStrategyConfig,
): number {
  const entryCostsPerUnit = position.entryFee / position.quantity;
  const takerRate = config.costs.takerFeeBps / 10_000;
  const slippageRate = config.costs.slippageBps / 10_000;
  if (position.side === "long") {
    const settledPrice = (position.entryPrice + entryCostsPerUnit) / (1 - takerRate);
    return settledPrice / (1 - slippageRate);
  }
  const settledPrice = (position.entryPrice - entryCostsPerUnit) / (1 + takerRate);
  return settledPrice / (1 + slippageRate);
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
  if (candle.volume24h === null || candle.volume24h < config.filters.minimumVolume24hUsdt) {
    return false;
  }
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
  return values.map((value, index) => {
    if (index < period - 1) return null;
    const window = values.slice(index - period + 1, index + 1);
    const mean = window.reduce((sum, current) => sum + current, 0) / period;
    const variance = window.reduce((sum, current) => sum + (current - mean) ** 2, 0) / period;
    const deviation = Math.sqrt(variance);
    return deviation === 0 ? 0 : (value - mean) / deviation;
  });
}

function momentumSeries(values: number[], period: number): Array<number | null> {
  return values.map((value, index) => {
    if (index < period) return null;
    const previous = values[index - period]!;
    return previous === 0 ? null : (value / previous - 1) * 100;
  });
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
