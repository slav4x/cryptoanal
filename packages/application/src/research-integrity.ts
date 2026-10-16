import { runExecutionPolicySimulation } from "./execution-policy-simulation";
import {
  readExecutionPolicy,
  canonicalExecutionValue,
  type ExecutionPolicySnapshot,
} from "./execution-policy";
import {
  advanceFundedCandle,
  validateFundingDataset,
  type ExecutionFundingDataset,
} from "./execution-funding";
import {
  executionEntryCandleRange,
  enrichExecutionCandles,
  minimumExecutionCandleCount,
  getExecutionSignal,
  getTradingDateKey,
  openExecutionPosition,
  settleExecutionPosition,
  type EnrichedExecutionCandle,
  type ExecutionCandle,
  type ExecutionPosition,
  type ExecutionStrategyConfig,
  type PendingExecutionSignal,
} from "./execution-engine";
import {
  readExecutionInstrumentRules,
  type ExecutionInstrumentRules,
} from "./execution-instrument";

export const metricProvenanceSchemaVersion = 1 as const;
export const runtimeReplayEngineVersion = "cryptoanal-runtime-replay@1.10.0";
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
  funding?: number;
  exitReason:
    | "stop-loss"
    | "take-profit"
    | "trailing-stop"
    | "signal-exit"
    | "holding-timeout"
    | "end-of-data";
};

export function runRuntimeReplay(input: {
  executionPolicy?: ExecutionPolicySnapshot;
  funding?: ExecutionFundingDataset;
  instrumentRules?: Record<string, ExecutionInstrumentRules>;
  config: ExecutionStrategyConfig;
  candles: ExecutionCandle[];
  initialCapital: number;
}) {
  if (input.executionPolicy) {
    const policy = readExecutionPolicy(input.executionPolicy);
    if (canonicalExecutionValue(policy.strategy) !== canonicalExecutionValue(input.config))
      throw new Error("Replay policy/config mismatch");
    const interval =
      { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 }[input.config.universe.timeframe] *
      60000;
    const entryFrom =
      input.candles.reduce((m, c) => Math.min(m, +c.openTime), Infinity) +
      minimumExecutionCandleCount(input.config) * interval;
    const result = runExecutionPolicySimulation({ ...input, executionPolicy: policy, entryFrom });
    const sum = (field: "netPnl" | "fees" | "funding") =>
      round(result.trades.reduce((n, t) => n + (t[field] ?? 0), 0));
    return {
      ...result,
      engineVersion: runtimeReplayEngineVersion,
      fundingPolicy: input.funding?.policy ?? fundingPolicy,
      metrics: {
        trades: result.trades.length,
        netPnl: sum("netPnl"),
        totalFees: sum("fees"),
        totalFunding: sum("funding"),
        endingEquity: round(input.initialCapital + sum("netPnl")),
      },
    };
  }
  if (input.funding && input.candles.length) {
    const interval =
      { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440 }[
        input.config.universe.timeframe
      ] * 60000;
    const times = input.candles.map((c) => +c.openTime);
    validateFundingDataset(
      input.funding,
      [...new Set(input.candles.map((c) => c.symbol))],
      new Date(times.reduce((a, b) => Math.min(a, b), Infinity)),
      new Date(times.reduce((a, b) => Math.max(a, b), -Infinity) + interval),
    );
  }
  if (input.instrumentRules)
    for (const symbol of new Set(input.candles.map((candle) => candle.symbol))) {
      const rules = readExecutionInstrumentRules(input.instrumentRules[symbol]);
      if (!rules || rules.symbol !== symbol)
        throw new Error(`Missing pinned instrument rules: ${symbol}`);
    }
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
  const applyCharges = (charges: Array<{ settledAt: string; amount: string }>) => {
    for (const charge of charges) {
      equity -= Number(charge.amount);
      const day = getTradingDateKey(new Date(charge.settledAt), input.config.schedule.timezone);
      dailyPnl.set(day, (dailyPnl.get(day) ?? 0) - Number(charge.amount));
    }
  };
  let sequence = 0;

  for (const [, candles] of [...groups.entries()].sort(([left], [right]) => left - right)) {
    for (const candle of candles) {
      const position = positions.get(candle.symbol);
      if (!position) continue;
      const step = advanceFundedCandle(position, candle, input.config, input.funding);
      applyCharges(step.charges);
      const settlement = step.settlement;
      if (settlement) {
        positions.delete(candle.symbol);
        trades.push(settlement);
        equity += settlement.netPnl + (settlement.funding ?? 0);
        const day = getTradingDateKey(
          new Date(settlement.closedAt),
          input.config.schedule.timezone,
        );
        dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + settlement.netPnl + (settlement.funding ?? 0));
        decisions.push({
          sequence: sequence++,
          symbol: candle.symbol,
          candleAt: candle.openTime.toISOString(),
          action: "close",
          reasonCode: settlement.exitReason,
          price: settlement.exitPrice,
        });
      } else {
        positions.set(candle.symbol, step.position);
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
        input.instrumentRules?.[candle.symbol],
      );
      if (!position) continue;
      const entryRange = executionEntryCandleRange(position, candle, input.config);
      decisions.push({
        sequence: sequence++,
        symbol: candle.symbol,
        candleAt: candle.openTime.toISOString(),
        action: "open",
        reasonCode:
          entryRange.mode === "intrabar-uncertain"
            ? "pending-limit-filled-intrabar-uncertain"
            : "pending-signal-filled",
        price: position.entryPrice,
      });
      const step = advanceFundedCandle(position, entryRange.candle, input.config, input.funding);
      applyCharges(step.charges);
      const settlement = step.settlement;
      if (settlement) {
        trades.push(settlement);
        equity += settlement.netPnl + (settlement.funding ?? 0);
        const closeDay = getTradingDateKey(
          new Date(settlement.closedAt),
          input.config.schedule.timezone,
        );
        dailyPnl.set(
          closeDay,
          (dailyPnl.get(closeDay) ?? 0) + settlement.netPnl + (settlement.funding ?? 0),
        );
        decisions.push({
          sequence: sequence++,
          symbol: candle.symbol,
          candleAt: candle.openTime.toISOString(),
          action: "close",
          reasonCode: settlement.exitReason,
          price: settlement.exitPrice,
        });
      } else {
        positions.set(candle.symbol, step.position);
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
      input.funding
        ? new Date(
            +candle.openTime + replayFundingTimeframes[input.config.universe.timeframe] * 60000,
          )
        : candle.openTime,
      "end-of-data",
      input.config,
    );
    trades.push(settlement);
    equity += settlement.netPnl + (settlement.funding ?? 0);
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
    fundingPolicy: input.funding?.policy ?? fundingPolicy,
    decisions,
    trades,
    metrics: {
      trades: trades.length,
      netPnl: round(trades.reduce((sum, trade) => sum + trade.netPnl, 0)),
      totalFees: round(trades.reduce((sum, trade) => sum + trade.fees, 0)),
      ...(input.funding
        ? { totalFunding: round(trades.reduce((sum, t) => sum + (t.funding ?? 0), 0)) }
        : {}),
      endingEquity: round(equity),
    },
  };
}

function round(value: number) {
  return Math.round(value * 1e8) / 1e8;
}

const replayFundingTimeframes = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};
