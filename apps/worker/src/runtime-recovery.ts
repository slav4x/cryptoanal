import {
  assertExecutionExitQuote,
  evaluateExecutionExit,
  evaluateExecutionPriceExit,
  settleExecutionPosition,
  updateExecutionTrailing,
  type ExecutionPosition,
  type ExecutionQuote,
  type ExecutionStrategyConfig,
  type ExecutionCandle,
  type EnrichedExecutionCandle,
  type ExecutionSettlement,
} from "@cryptoanal/application";

export class RuntimeRecoveryIncompleteError extends Error {}

export type RuntimeRecoveryEvidence = {
  streamCause?: string;
  interruptedAt?: string;
  sourceFailure?: string;
  fromAt: string;
  toAt: string;
  source: "minute-ohlc" | "recent-public-trades" | "journal-protection";
  quality:
    | "complete-minutes"
    | "bounded-partial-minutes"
    | "ambiguous"
    | "bounded-public-trades"
    | "incomplete";
  ambiguity:
    | "partial-protection-touch"
    | "partial-protection-change"
    | "intrabar-order"
    | "unobserved-partial-minute"
    | "same-timestamp-order"
    | "historical-trigger-without-fill"
    | "unreconstructed-gap"
    | null;
};

export function runtimeRecoveryMinuteRange(since: Date, through: Date) {
  return {
    start: new Date(Math.floor(+since / 60_000) * 60_000),
    end: new Date(+through - 1),
  };
}

export function recoverRuntimeGap(input: {
  position: ExecutionPosition;
  since: Date;
  quote: ExecutionQuote;
  minutes: ExecutionCandle[];
  config: ExecutionStrategyConfig;
}): {
  position: ExecutionPosition;
  settlement: ExecutionSettlement | null;
  evidence: RuntimeRecoveryEvidence;
} {
  if (input.position.exitPolicy) {
    assertExecutionExitQuote(input.position, input.quote);
    const { exitPolicy, ...legacyPosition } = input.position;
    const recovered = recoverRuntimeGap({ ...input, position: legacyPosition });
    const position = { ...recovered.position, exitPolicy };
    return {
      ...recovered,
      position,
      ...(recovered.settlement
        ? {
            settlement: settleExecutionPosition(
              position,
              input.quote.price,
              input.quote.observedAt,
              "recovery-exit",
              input.config,
            ),
            evidence: {
              ...recovered.evidence,
              quality: "ambiguous" as const,
              ambiguity: "intrabar-order" as const,
            },
          }
        : {}),
    };
  }
  if (+input.quote.observedAt < +input.since)
    throw new RuntimeRecoveryIncompleteError("Recovery quote precedes the managed interval");
  const range = runtimeRecoveryMinuteRange(input.since, input.quote.observedAt);
  const from = +range.start;
  const to = Math.floor(+range.end / 60_000) * 60_000;
  const evidence: RuntimeRecoveryEvidence = {
    fromAt: input.since.toISOString(),
    toAt: input.quote.observedAt.toISOString(),
    source: "minute-ohlc",
    quality:
      +input.since % 60_000 === 0 && +input.quote.observedAt % 60_000 === 0
        ? "complete-minutes"
        : "bounded-partial-minutes",
    ambiguity: null,
  };
  if (+input.quote.observedAt === +input.since)
    return { position: input.position, settlement: null, evidence };
  const minutes = new Map(input.minutes.map((candle) => [candle.openTime.getTime(), candle]));
  for (let time = from; time <= to; time += 60_000) {
    const candle = minutes.get(time);
    if (
      !candle ||
      ![candle.open, candle.high, candle.low, candle.close].every(
        (value) => Number.isFinite(value) && value > 0,
      ) ||
      candle.low > Math.min(candle.open, candle.close) ||
      candle.high < Math.max(candle.open, candle.close)
    ) {
      throw new RuntimeRecoveryIncompleteError("Missing or invalid minute in recovery history");
    }
  }
  let position = input.position;
  for (let time = from; time <= to; time += 60_000) {
    const candle = asPriceCandle(minutes.get(time)!);
    const complete =
      time >= input.since.getTime() && time + 60_000 <= input.quote.observedAt.getTime();
    const exit = evaluateExecutionExit(position, candle, input.config);
    if (exit) {
      return {
        position,
        evidence: complete
          ? evidence
          : { ...evidence, quality: "ambiguous", ambiguity: "partial-protection-touch" },
        settlement: complete
          ? { ...exit, closedAt: new Date(time + 60_000).toISOString() }
          : settleExecutionPosition(
              position,
              input.quote.price,
              input.quote.observedAt,
              "recovery-exit",
              input.config,
            ),
      };
    }
    const updated = updateExecutionTrailing(position, candle, input.config);
    // Partial bars can contain prices before entry or after the recovery quote.
    // Do not adopt protection derived from a time range we cannot reconstruct.
    if (
      !complete &&
      (updated.stopPrice !== position.stopPrice || updated.trailingPrice !== position.trailingPrice)
    ) {
      return {
        position,
        evidence: { ...evidence, quality: "ambiguous", ambiguity: "partial-protection-change" },
        settlement: settleExecutionPosition(
          position,
          input.quote.price,
          input.quote.observedAt,
          "recovery-exit",
          input.config,
        ),
      };
    }
    // OHLC cannot establish whether protection activated before or after the adverse extreme.
    if (
      evaluateExecutionPriceExit(
        updated,
        {
          symbol: candle.symbol,
          price: position.side === "long" ? candle.low : candle.high,
          observedAt: input.quote.observedAt,
        },
        input.config,
      )
    ) {
      return {
        position: updated,
        evidence: { ...evidence, quality: "ambiguous", ambiguity: "intrabar-order" },
        settlement: settleExecutionPosition(
          updated,
          input.quote.price,
          input.quote.observedAt,
          "recovery-exit",
          input.config,
        ),
      };
    }
    // A harmless partial-bar best price is still outside the confirmed interval.
    // Keep the prior state; only complete minutes may update protection or best price.
    if (complete) position = updated;
  }
  return { position, settlement: null, evidence };
}

function asPriceCandle(candle: ExecutionCandle): EnrichedExecutionCandle {
  return {
    ...candle,
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
}
