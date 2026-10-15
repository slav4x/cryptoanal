import {
  enrichExecutionCandles,
  getExecutionSignal,
  openExecutionPosition,
  limitExecutionPositionRisk,
  executionEntryCandleRange,
  evaluateExecutionPriceExit,
  evaluateExecutionExit,
  evaluateExecutionSignalExit,
  settleExecutionPosition,
  getTradingDateKey,
  type EnrichedExecutionCandle,
  type ExecutionCandle,
  type ExecutionPosition,
  type ExecutionSettlement,
  type AutomaticExitReason,
  type PendingExecutionSignal,
} from "./execution-engine";
import {
  assessExecutionAccount,
  executionAccountEntryFailure,
  readExecutionRiskConfig,
  type ExecutionAccountPosition,
} from "./execution-account";
import {
  readExecutionPolicy,
  canonicalExecutionValue,
  type ExecutionPolicySnapshot,
} from "./execution-policy";
import {
  fundingAmount,
  validateFundingDataset,
  type ExecutionFundingDataset,
} from "./execution-funding";
import { advanceExecutionQuoteProtection } from "./execution-position-policy";
import type { ExecutionProfitProtectionState } from "./execution-profit-protection";
import {
  readExecutionInstrumentRules,
  type ExecutionInstrumentRules,
} from "./execution-instrument";
export type PolicySimulationInput = {
  executionPolicy: ExecutionPolicySnapshot;
  candles: ExecutionCandle[];
  initialCapital: number;
  funding?: ExecutionFundingDataset;
  instrumentRules?: Record<string, ExecutionInstrumentRules>;
  entryFrom?: number | null;
  entryTo?: number | null;
  indicatorHistory?: Map<string, EnrichedExecutionCandle[]>;
};
export function runExecutionPolicySimulation(input: PolicySimulationInput) {
  const policy = readExecutionPolicy(input.executionPolicy),
    config = policy.strategy;
  if (policy.dataModel !== "ohlc-adverse-first@1")
    throw new Error("Candle simulation requires an explicit OHLC policy");
  if (!Number.isFinite(input.initialCapital) || input.initialCapital <= 0)
    throw new Error("Invalid simulation capital");
  for (const symbol of new Set(input.candles.map((c) => c.symbol))) {
    const rules = readExecutionInstrumentRules(input.instrumentRules?.[symbol]);
    if (!rules || rules.symbol !== symbol)
      throw new Error(`Missing pinned instrument rules: ${symbol}`);
  }
  if (
    !!policy.settings.funding !== !!input.funding ||
    (input.funding &&
      canonicalExecutionValue(input.funding.policy) !==
        canonicalExecutionValue(policy.settings.funding))
  )
    throw new Error("Funding policy/data mismatch");
  const interval =
    { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 }[config.universe.timeframe] * 60000;
  const bySymbol = new Map<string, EnrichedExecutionCandle[]>();
  for (const c of input.candles) {
    const series = bySymbol.get(c.symbol) ?? [];
    series.push(c as EnrichedExecutionCandle);
    bySymbol.set(c.symbol, series);
  }
  const groups = new Map<number, EnrichedExecutionCandle[]>();
  for (const [symbol, series] of bySymbol) {
    const enriched = input.indicatorHistory?.get(symbol);
    const times = new Set(series.map((c) => +c.openTime));
    for (const c of enriched
      ? enriched.filter((c) => times.has(+c.openTime))
      : enrichExecutionCandles(series, config)) {
      if (input.entryTo != null && +c.openTime > input.entryTo) continue;
      groups.set(+c.openTime, [...(groups.get(+c.openTime) ?? []), c]);
    }
  }
  const ordered = [...groups].sort(([a], [b]) => a - b),
    positions = new Map<string, ExecutionPosition>(),
    marks = new Map<string, number>(),
    pending = new Map<string, PendingExecutionSignal & { expiresAt: number }>(),
    guards = new Map<string, ExecutionProfitProtectionState | null>();
  const cashUTC = new Map<string, number>(),
    cashLocal = new Map<string, number>(),
    latches = new Set<string>();
  const trades: ExecutionSettlement<
    AutomaticExitReason | "end-of-data" | "kill-switch" | "daily-loss-limit"
  >[] = [];
  const decisions: Array<{
    sequence: number;
    symbol: string;
    candleAt: string;
    action: "open" | "close";
    reasonCode: string;
    price: number;
  }> = [];
  const admissions: Array<{ at: string; symbol: string; reason: string; quantity: number | null }> =
    [];
  const equitySeries: Array<{ observedAt: string; equity: number }> = [];
  let realized = 0,
    eventCursor = 0,
    sequence = 0,
    samples = 0,
    peak = input.initialCapital,
    maxDrawdownPercent = 0;
  const sampleEvery = Math.max(1, Math.round(86400000 / interval));
  const events = [...(input.funding?.events ?? [])].sort(
    (a, b) => Date.parse(a.settledAt) - Date.parse(b.settledAt),
  );
  if (input.funding && ordered.length)
    validateFundingDataset(
      input.funding,
      [...bySymbol.keys()],
      new Date(ordered[0]![0]),
      new Date(ordered.at(-1)![0] + interval),
    );
  const cash = (at: Date, amount: number) => {
    for (const [map, tz] of [
      [cashUTC, "UTC"],
      [cashLocal, config.schedule.timezone],
    ] as const) {
      const key = getTradingDateKey(at, tz);
      map.set(key, (map.get(key) ?? 0) + amount);
    }
  };
  const accrue = (at: Date) => {
    while (eventCursor < events.length && Date.parse(events[eventCursor]!.settledAt) <= +at) {
      const event = events[eventCursor++]!,
        p = positions.get(event.symbol);
      if (!p || +p.openedAt >= Date.parse(event.settledAt)) continue;
      const amount = Number(fundingAmount(p.side, String(p.quantity), event));
      p.fundingPaid = (p.fundingPaid ?? 0) + amount;
      cash(new Date(event.settledAt), -amount);
    }
  };
  const normalized = (): ExecutionAccountPosition[] =>
    [...positions.values()].map((p) => ({
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      quantity: p.quantity,
      entryFee: p.entryFee,
      stopPrice: p.stopPrice,
      trailingPrice: p.trailingPrice,
      markPrice: marks.get(p.symbol) ?? p.entryPrice,
      realizedPnl: -(p.fundingPaid ?? 0),
      costs: readExecutionRiskConfig(config),
      ...(p.instrumentRules ? { tickSize: p.instrumentRules.tickSize } : {}),
    }));
  const assess = (at: Date) => {
    const day = getTradingDateKey(at, "UTC");
    const risk = assessExecutionAccount({
      policy: policy.settings.accountSafety,
      config,
      now: at,
      realizedNetPnl:
        input.initialCapital - policy.settings.accountSafety.initialBalance + realized,
      utcCashPnl: cashUTC.get(day) ?? 0,
      strategyCashPnl: cashLocal.get(getTradingDateKey(at, config.schedule.timezone)) ?? 0,
      positions: normalized(),
      utcHalted: latches.has(day),
    });
    if (risk.shouldLatch) latches.add(day);
    peak = Math.max(peak, risk.equity);
    if (peak > 0)
      maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - risk.equity) / peak) * 100);
    return risk;
  };
  const close = (p: ExecutionPosition, settlement: ExecutionSettlement, at: Date) => {
    if (settlement.exitReason === "manual" || settlement.exitReason === "recovery-exit")
      throw new Error("Unsupported candle exit");
    positions.delete(p.symbol);
    guards.delete(p.symbol);
    trades.push({ ...settlement, exitReason: settlement.exitReason });
    realized += settlement.netPnl;
    cash(new Date(settlement.closedAt), settlement.netPnl + (settlement.funding ?? 0));
    decisions.push({
      sequence: sequence++,
      symbol: p.symbol,
      candleAt: at.toISOString(),
      action: "close",
      reasonCode: settlement.exitReason,
      price: settlement.exitPrice,
    });
  };
  const force = (at: Date) => {
    const risk = assess(at);
    if (risk.forceCloseReason)
      for (const p of [...positions.values()])
        close(
          p,
          settleExecutionPosition(
            p,
            marks.get(p.symbol) ?? p.entryPrice,
            at,
            risk.forceCloseReason,
            config,
          ),
          at,
        );
    return risk;
  };
  const eligible = (time: number) =>
    (input.entryFrom == null || time >= input.entryFrom) &&
    (input.entryTo == null || time <= input.entryTo);
  for (const [time, bars] of ordered) {
    const openAt = new Date(time),
      adverseAt = new Date(time + Math.floor(interval / 3)),
      favorableAt = new Date(time + Math.floor((2 * interval) / 3)),
      closeAt = new Date(time + interval);
    const ranges = new Map<string, EnrichedExecutionCandle>();
    for (const c of bars) {
      marks.set(c.symbol, c.open);
      ranges.set(c.symbol, c);
    }
    accrue(openAt);
    for (const c of bars) {
      const p = positions.get(c.symbol);
      if (!p) continue;
      const exit = evaluateExecutionPriceExit(
        p,
        { symbol: c.symbol, price: c.open, observedAt: openAt },
        config,
      );
      if (exit) close(p, exit, openAt);
    }
    force(openAt);
    for (const c of [...bars].sort((a, b) => a.symbol.localeCompare(b.symbol))) {
      const signal = pending.get(c.symbol);
      pending.delete(c.symbol);
      if (!signal || positions.has(c.symbol) || !eligible(time)) continue;
      const risk = assess(openAt);
      let reason = risk.reason;
      if (!reason && time >= signal.expiresAt) reason = "ENTRY_SIGNAL_EXPIRED";
      if (
        !reason &&
        config.entry.orderType === "market" &&
        Math.abs(c.open - signal.signalPrice) * 10000 >
          signal.signalPrice * policy.settings.marketEntry.maxDeviationBps
      )
        reason = "ENTRY_PRICE_DEVIATION";
      let p = !reason
        ? openExecutionPosition(
            signal,
            c,
            risk.equity,
            Math.max(0, risk.equity) / config.risk.maxOpenPositions,
            config,
            input.instrumentRules?.[c.symbol],
          )
        : null;
      if (p)
        p = limitExecutionPositionRisk(
          p,
          risk.equity,
          Math.max(0, risk.maximumExposure - risk.exposure),
          config,
          risk.remainingStopRisk,
        );
      if (p)
        reason = executionAccountEntryFailure(
          risk,
          { ...p, ...(p.instrumentRules ? { tickSize: p.instrumentRules.tickSize } : {}) },
          normalized(),
        );
      if (!p && !reason) reason = "ENTRY_SIZE_OR_LIMIT_UNAVAILABLE";
      admissions.push({
        at: openAt.toISOString(),
        symbol: c.symbol,
        reason: reason ?? "ENTRY_ALLOWED",
        quantity: reason ? null : p!.quantity,
      });
      if (reason || !p) continue;
      if (input.funding) p.fundingPaid = 0;
      positions.set(c.symbol, p);
      marks.set(c.symbol, c.open);
      guards.set(c.symbol, null);
      const range = executionEntryCandleRange(p, c, config);
      ranges.set(c.symbol, range.candle);
      decisions.push({
        sequence: sequence++,
        symbol: c.symbol,
        candleAt: openAt.toISOString(),
        action: "open",
        reasonCode:
          range.mode === "intrabar-uncertain"
            ? "pending-limit-filled-intrabar-uncertain"
            : "pending-signal-filled",
        price: p.entryPrice,
      });
    }
    accrue(adverseAt);
    for (const [symbol, c] of ranges) {
      const p = positions.get(symbol);
      if (!p) continue;
      const initial = evaluateExecutionExit(p, c, config);
      if (initial && ["stop-loss", "trailing-stop"].includes(initial.exitReason)) {
        close(p, { ...initial, closedAt: adverseAt.toISOString() }, adverseAt);
        continue;
      }
      marks.set(symbol, p.side === "long" ? c.low : c.high);
    }
    force(adverseAt);
    accrue(favorableAt);
    for (const [symbol, c] of ranges) {
      const p = positions.get(symbol);
      if (!p) continue;
      const best = p.side === "long" ? c.high : c.low;
      marks.set(symbol, best);
      if (p.side === "long" ? best >= p.takePrice : best <= p.takePrice) {
        close(
          p,
          settleExecutionPosition(p, p.takePrice, favorableAt, "take-profit", config),
          favorableAt,
        );
        continue;
      }
      const protection = policy.settings.profitProtection;
      const step = advanceExecutionQuoteProtection(
        p,
        { symbol, price: best, observedAt: favorableAt },
        config,
        protection && Date.parse(protection.enabledAt) <= time ? protection : null,
        guards.get(symbol) ?? null,
      );
      positions.set(symbol, step.position);
      guards.set(symbol, step.state);
    }
    assess(favorableAt);
    accrue(closeAt);
    for (const [symbol, c] of ranges) {
      const p = positions.get(symbol);
      marks.set(symbol, c.close);
      if (!p) continue;
      const quote = { symbol, price: c.close, observedAt: closeAt };
      const exit =
        evaluateExecutionPriceExit(p, quote, config) ??
        (evaluateExecutionSignalExit(p, c, config, closeAt)
          ? settleExecutionPosition(p, c.close, closeAt, "signal-exit", config)
          : null);
      if (exit) {
        close(p, exit, closeAt);
        continue;
      }
      const step = advanceExecutionQuoteProtection(
        p,
        quote,
        config,
        policy.settings.profitProtection,
        guards.get(symbol) ?? null,
      );
      positions.set(symbol, step.position);
      guards.set(symbol, step.state);
    }
    force(closeAt);
    for (const c of bars)
      if (!positions.has(c.symbol)) {
        const signal = getExecutionSignal(c, config);
        if (signal)
          pending.set(c.symbol, {
            ...signal,
            expiresAt:
              +closeAt +
              (config.entry.orderType === "market"
                ? Math.min(interval, policy.settings.marketEntry.ttlMs)
                : interval),
          });
      }
    if (eligible(time) && samples++ % sampleEvery === 0)
      equitySeries.push({
        observedAt: closeAt.toISOString(),
        equity: round(assess(closeAt).equity),
      });
  }
  const last = ordered.at(-1);
  if (last) {
    const at = new Date(last[0] + interval);
    for (const p of [...positions.values()])
      close(
        p,
        settleExecutionPosition(p, marks.get(p.symbol) ?? p.entryPrice, at, "end-of-data", config),
        at,
      );
    if (eligible(last[0])) {
      const final = {
        observedAt: at.toISOString(),
        equity: round(input.initialCapital + realized),
      };
      if (equitySeries.at(-1)?.observedAt === final.observedAt)
        equitySeries[equitySeries.length - 1] = final;
      else equitySeries.push(final);
    }
  }
  return {
    trades,
    decisions,
    admissions,
    equitySeries,
    maxDrawdownPercent,
    utcHaltedDays: [...latches],
    limits: [
      "OHLC_ADVERSE_FIRST_SCENARIO",
      "INTRABAR_LIMIT_FILL_TIME_UNCERTAIN",
      "L1_LIQUIDITY_NOT_OBSERVED",
    ],
  };
}
const round = (n: number) => Math.round(n * 1e8) / 1e8;
