import {
  advanceExecutionQuoteProtection,
  compareExecutionDecimals,
  evaluateExecutionPriceExit,
  evaluateExecutionExit,
  settleExecutionPosition,
  type ExecutionPosition,
  type ExecutionQuote,
  type ExecutionCandle,
  type ExecutionStrategyConfig,
  type ExecutionProfitProtectionPolicy,
  type ExecutionProfitProtectionState,
} from "@cryptoanal/application";
import {
  recoverRuntimeGap,
  RuntimeRecoveryIncompleteError,
  type RuntimeRecoveryEvidence,
} from "./runtime-recovery";

export type RecoveryTrade = { tradeId: string; symbol: string; price: string; observedAt: string };
export type RecoveryTradeSnapshot = { sampledAt: string; trades: RecoveryTrade[] };
export type CausalRecoveryInput = {
  position: ExecutionPosition;
  since: Date;
  quote: ExecutionQuote;
  config: ExecutionStrategyConfig;
  minutes: ExecutionCandle[];
  recent?: RecoveryTradeSnapshot;
  anchorTradeId?: string;
  anchorPrice?: string;
  quoteTradeId?: string;
  strictMinutes: boolean;
  protection: {
    policy: ExecutionProfitProtectionPolicy | null;
    state: ExecutionProfitProtectionState | null;
  };
};

export function selectRecoveryTrades(input: CausalRecoveryInput): RecoveryTrade[] | null {
  const { recent, anchorTradeId, quoteTradeId, since, quote } = input;
  if (!recent || !anchorTradeId || !quoteTradeId || !Number.isFinite(Date.parse(recent.sampledAt)))
    return null;
  const anchor = recent.trades.find((t) => t.tradeId === anchorTradeId),
    end = recent.trades.find((t) => t.tradeId === quoteTradeId);
  if (
    !anchor ||
    !end ||
    Date.parse(anchor.observedAt) !== +since ||
    Date.parse(end.observedAt) !== +quote.observedAt ||
    Number(end.price) !== quote.price ||
    recent.trades.some(
      (t) =>
        t.symbol !== quote.symbol ||
        !Number.isFinite(Date.parse(t.observedAt)) ||
        !Number.isFinite(Number(t.price)) ||
        Number(t.price) <= 0,
    )
  )
    return null;
  if (input.anchorPrice && compareExecutionDecimals(anchor.price, input.anchorPrice) !== 0)
    return null;
  if (new Set(recent.trades.map((t) => t.tradeId)).size !== recent.trades.length) return null;
  // Without a total order, boundary trades at the same millisecond can be outside the interval.
  if (
    recent.trades.some(
      (t) =>
        (+new Date(t.observedAt) === +since &&
          compareExecutionDecimals(t.price, anchor.price) !== 0) ||
        (+new Date(t.observedAt) === +quote.observedAt && Number(t.price) !== quote.price),
    )
  )
    return null;
  return recent.trades
    .filter(
      (t) => Date.parse(t.observedAt) > +since && Date.parse(t.observedAt) < +quote.observedAt,
    )
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}

export function recoverCausalRuntimeGap(input: CausalRecoveryInput) {
  if (typeof input.strictMinutes !== "boolean")
    throw new RuntimeRecoveryIncompleteError("Unknown recovery recipe");
  if (+input.quote.observedAt < +input.since)
    throw new RuntimeRecoveryIncompleteError("Recovery clock precedes checkpoint");
  let position = input.position,
    state = input.protection.state;
  const evidence: RuntimeRecoveryEvidence = {
    fromAt: input.since.toISOString(),
    toAt: input.quote.observedAt.toISOString(),
    source: "minute-ohlc",
    quality: "complete-minutes",
    ambiguity: null,
  };
  const result = (
    settlement: ReturnType<typeof settleExecutionPosition> | null,
    extra: Partial<RuntimeRecoveryEvidence> = {},
  ) => ({
    position,
    settlement,
    profitProtectionState: state,
    evidence: { ...evidence, ...extra },
  });
  const uncertain = (ambiguity: RuntimeRecoveryEvidence["ambiguity"], source = evidence.source) =>
    result(
      settleExecutionPosition(
        position,
        input.quote.price,
        input.quote.observedAt,
        "recovery-exit",
        input.config,
      ),
      { quality: "ambiguous", ambiguity, source },
    );
  const selected = selectRecoveryTrades(input);
  if (selected) {
    evidence.source = "recent-public-trades";
    evidence.quality = "bounded-public-trades";
    for (let i = 0; i < selected.length;) {
      const group: RecoveryTrade[] = [],
        at = selected[i]!.observedAt;
      while (i < selected.length && selected[i]!.observedAt === at) group.push(selected[i++]!);
      for (const t of group) {
        const exit = evaluateExecutionPriceExit(
          position,
          {
            source: "LastPrice",
            symbol: t.symbol,
            price: Number(t.price),
            observedAt: new Date(at),
          },
          input.config,
        );
        if (exit)
          return uncertain(
            group.length > 1 ? "same-timestamp-order" : "historical-trigger-without-fill",
          );
      }
      const best = group.reduce((a, b) =>
        (
          position.side === "long"
            ? Number(a.price) > Number(b.price)
            : Number(a.price) < Number(b.price)
        )
          ? a
          : b,
      );
      const updated = advanceExecutionQuoteProtection(
        position,
        {
          source: "LastPrice",
          symbol: best.symbol,
          price: Number(best.price),
          observedAt: new Date(at),
        },
        input.config,
        input.protection.policy,
        state,
      );
      if (
        group.some((t) =>
          evaluateExecutionPriceExit(
            updated.position,
            {
              source: "LastPrice",
              symbol: t.symbol,
              price: Number(t.price),
              observedAt: new Date(at),
            },
            input.config,
          ),
        )
      )
        return uncertain("same-timestamp-order");
      position = updated.position;
      state = updated.state;
    }
    return result(null);
  }
  if (+input.quote.observedAt === +input.since)
    return input.strictMinutes ? uncertain("same-timestamp-order") : result(null);
  if (!input.strictMinutes) return { ...recoverRuntimeGap(input), profitProtectionState: state };
  const byTime = new Map(input.minutes.map((c) => [+c.openTime, c]));
  // Only fully closed minutes can provide bounds without any data after the recovery quote.
  for (
    let time = Math.floor(+input.since / 60000) * 60000;
    time < +input.quote.observedAt;
    time += 60000
  ) {
    if (time + 60000 > +input.quote.observedAt) return uncertain("unobserved-partial-minute");
    const c = byTime.get(time);
    if (
      !c ||
      c.symbol !== position.symbol ||
      ![c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0) ||
      c.low > Math.min(c.open, c.close) ||
      c.high < Math.max(c.open, c.close)
    )
      throw new RuntimeRecoveryIncompleteError("Missing or invalid closed recovery minute");
    const partial = time < +input.since;
    const candle = {
      ...c,
      emaFast: null,
      emaSlow: null,
      previousEmaFast: null,
      previousEmaSlow: null,
      rsi: null,
      previousRsi: null,
      atrPercent: null,
      volume24h: null,
      breakoutHigh: null,
      breakoutLow: null,
      meanReversionZScore: null,
      previousMeanReversionZScore: null,
      momentumPercent: null,
      previousMomentumPercent: null,
    };
    const ohlcPosition = { ...position };
    delete ohlcPosition.exitPolicy;
    if (evaluateExecutionExit(ohlcPosition, candle, input.config))
      return uncertain(partial ? "partial-protection-touch" : "historical-trigger-without-fill");
    const best = position.side === "long" ? c.high : c.low,
      at = new Date(time + 60000);
    const policy = input.protection.policy;
    const updated = advanceExecutionQuoteProtection(
      position,
      { source: "LastPrice", symbol: c.symbol, price: best, observedAt: at },
      input.config,
      policy && Date.parse(policy.enabledAt) <= time ? policy : null,
      state,
    );
    const changed =
      updated.position.stopPrice !== position.stopPrice ||
      updated.position.trailingPrice !== position.trailingPrice;
    if (partial) {
      evidence.quality = "bounded-partial-minutes";
      if (changed) return uncertain("partial-protection-change");
      continue;
    }
    if (
      evaluateExecutionPriceExit(
        updated.position,
        {
          source: "LastPrice",
          symbol: c.symbol,
          price: position.side === "long" ? c.low : c.high,
          observedAt: at,
        },
        input.config,
      )
    )
      return uncertain("intrabar-order");
    position = updated.position;
    state = updated.state;
    const close = advanceExecutionQuoteProtection(
      position,
      { source: "LastPrice", symbol: c.symbol, price: c.close, observedAt: at },
      input.config,
      policy && Date.parse(policy.enabledAt) <= time ? policy : null,
      state,
    );
    position = close.position;
    state = close.state;
  }
  return result(null);
}
