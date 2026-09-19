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

export const metricProvenanceSchemaVersion = 1 as const;
export const runtimeReplayEngineVersion = "cryptoanal-runtime-replay@1.0.0";
export const fundingPolicy = {
  version: "cryptoanal-funding@disabled-v1",
  status: "disabled",
  reason: "Funding исключён до воспроизводимой валидации exchange timestamps и cash flows",
} as const;

export type RuntimeReplayDecision = {
  sequence: number;
  symbol: string;
  candleAt: string;
  action: "open" | "close";
  reasonCode: string;
  price: number;
};

export type RuntimeReplayTrade = {
  symbol: string;
  side: "long" | "short";
  openedAt: string;
  closedAt: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  netPnl: number;
  fees: number;
  exitReason: "stop-loss" | "take-profit" | "trailing-stop" | "signal-exit" | "end-of-data";
};

export function runRuntimeReplay(input: {
  config: ExecutionStrategyConfig;
  candles: ExecutionCandle[];
  initialCapital: number;
}) {
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
      const timestamp = candle.openTime.getTime();
      groups.set(timestamp, [...(groups.get(timestamp) ?? []), candle]);
    }
  }

  const positions = new Map<string, ExecutionPosition>();
  const pendingSignals = new Map<string, PendingExecutionSignal>();
  const trades: RuntimeReplayTrade[] = [];
  const decisions: RuntimeReplayDecision[] = [];
  const dailyPnl = new Map<string, number>();
  let equity = input.initialCapital;
  let sequence = 0;

  for (const [, candles] of [...groups.entries()].sort(([left], [right]) => left - right)) {
    for (const candle of candles) {
      const position = positions.get(candle.symbol);
      if (!position) continue;
      const settlement = evaluateExecutionExit(position, candle, input.config);
      if (settlement) {
        positions.delete(candle.symbol);
        trades.push(settlement);
        equity += settlement.netPnl;
        const day = getTradingDateKey(
          new Date(settlement.closedAt),
          input.config.schedule.timezone,
        );
        dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + settlement.netPnl);
        decisions.push({
          sequence: sequence++,
          symbol: candle.symbol,
          candleAt: candle.openTime.toISOString(),
          action: "close",
          reasonCode: settlement.exitReason,
          price: settlement.exitPrice,
        });
      } else {
        positions.set(candle.symbol, updateExecutionTrailing(position, candle, input.config));
      }
    }

    for (const candle of [...candles].sort((left, right) =>
      left.symbol.localeCompare(right.symbol),
    )) {
      const signal = pendingSignals.get(candle.symbol);
      pendingSignals.delete(candle.symbol);
      if (!signal || positions.has(candle.symbol)) continue;
      if (positions.size >= input.config.risk.maxOpenPositions) continue;
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
      decisions.push({
        sequence: sequence++,
        symbol: candle.symbol,
        candleAt: candle.openTime.toISOString(),
        action: "open",
        reasonCode: "pending-signal-filled",
        price: position.entryPrice,
      });
      const settlement = evaluateExecutionExit(position, candle, input.config);
      if (settlement) {
        trades.push(settlement);
        equity += settlement.netPnl;
        dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + settlement.netPnl);
        decisions.push({
          sequence: sequence++,
          symbol: candle.symbol,
          candleAt: candle.openTime.toISOString(),
          action: "close",
          reasonCode: settlement.exitReason,
          price: settlement.exitPrice,
        });
      } else {
        positions.set(candle.symbol, updateExecutionTrailing(position, candle, input.config));
      }
    }

    for (const candle of candles) {
      if (positions.has(candle.symbol)) continue;
      const signal = getExecutionSignal(candle, input.config);
      if (signal) pendingSignals.set(candle.symbol, signal);
    }
  }

  for (const [symbol, position] of positions) {
    const candle = bySymbol.get(symbol)?.at(-1);
    if (!candle) continue;
    const settlement = settleExecutionPosition(
      position,
      candle.close,
      candle.openTime,
      "end-of-data",
      input.config,
    );
    trades.push(settlement);
    equity += settlement.netPnl;
    decisions.push({
      sequence: sequence++,
      symbol,
      candleAt: candle.openTime.toISOString(),
      action: "close",
      reasonCode: settlement.exitReason,
      price: settlement.exitPrice,
    });
  }

  return {
    engineVersion: runtimeReplayEngineVersion,
    fundingPolicy,
    decisions,
    trades,
    metrics: {
      trades: trades.length,
      netPnl: round(trades.reduce((sum, trade) => sum + trade.netPnl, 0)),
      totalFees: round(trades.reduce((sum, trade) => sum + trade.fees, 0)),
      endingEquity: round(equity),
    },
  };
}

function round(value: number) {
  return Math.round(value * 1e8) / 1e8;
}
