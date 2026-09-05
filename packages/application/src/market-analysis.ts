export type MarketCandleValues = {
  open: number;
  high: number;
  low: number;
  close: number;
};

export type MarketAnalysis = {
  regime: "bull" | "bear" | "neutral" | "unknown";
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
  periodChangePercent: number | null;
};

export function calculateMarketAnalysis(candles: MarketCandleValues[]): MarketAnalysis {
  const closes = candles.map(({ close }) => close);
  const ema20 = calculateEma(closes, 20);
  const ema50 = calculateEma(closes, 50);
  const rsi14 = calculateRsi(closes, 14);
  const atr14 = calculateAtr(candles, 14);
  const firstClose = closes[0];
  const lastClose = closes.at(-1);
  const periodChangePercent =
    firstClose && lastClose ? ((lastClose - firstClose) / firstClose) * 100 : null;

  let regime: MarketAnalysis["regime"] = "unknown";
  if (ema20 !== null && ema50 !== null && rsi14 !== null) {
    if (ema20 > ema50 * 1.002 && rsi14 >= 52) regime = "bull";
    else if (ema20 < ema50 * 0.998 && rsi14 <= 48) regime = "bear";
    else regime = "neutral";
  }

  return { regime, ema20, ema50, rsi14, atr14, periodChangePercent };
}

function calculateEma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) {
    result = (value - result) * multiplier + result;
  }
  return result;
}

function calculateRsi(values: number[], period: number): number | null {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    if (change >= 0) gains += change;
    else losses -= change;
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function calculateAtr(candles: MarketCandleValues[], period: number): number | null {
  if (candles.length <= period) return null;
  const trueRanges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index]!.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  const recentRanges = trueRanges.slice(-period);
  return recentRanges.reduce((sum, value) => sum + value, 0) / recentRanges.length;
}
