export type ExcursionObservation = { price: number; observedAt: Date };

export function createTradeExcursions(input: {
  side: "long" | "short";
  entryPrice: number;
  initialRiskDistance: number;
  openedAt: Date;
  throughAt: Date;
}) {
  if (
    ![input.entryPrice, input.initialRiskDistance].every((v) => Number.isFinite(v) && v > 0) ||
    !Number.isFinite(+input.openedAt) ||
    !Number.isFinite(+input.throughAt) ||
    input.throughAt < input.openedAt
  )
    throw new Error("Invalid excursion basis");
  const direction = input.side === "long" ? 1 : -1;
  let count = 0,
    mfe = 0,
    mae = 0,
    drawdown = 0;
  let peakAt: Date | null = null,
    adverseAt: Date | null = null;
  let firstAt: Date | null = null,
    lastAt: Date | null = null,
    outOfOrder = false;
  return {
    observe(quote: ExcursionObservation) {
      if (!Number.isFinite(quote.price) || quote.price <= 0 || !Number.isFinite(+quote.observedAt))
        throw new Error("Invalid excursion observation");
      if (quote.observedAt < input.openedAt || quote.observedAt > input.throughAt) return;
      if (lastAt && quote.observedAt < lastAt) outOfOrder = true;
      firstAt ??= quote.observedAt;
      lastAt = quote.observedAt;
      count++;
      const move = (direction * (quote.price - input.entryPrice)) / input.initialRiskDistance;
      if (move > mfe) {
        mfe = move;
        peakAt = quote.observedAt;
      }
      if (-move > mae) {
        mae = -move;
        adverseAt = quote.observedAt;
      }
      drawdown = Math.max(drawdown, mfe - move);
    },
    finish(exitPrice: number, complete: boolean, issues: string[]) {
      if (!Number.isFinite(exitPrice) || exitPrice <= 0) throw new Error("Invalid excursion exit");
      const available = count > 0;
      const quality = available && complete && !outOfOrder && issues.length === 0;
      return {
        source: "observed-public-trade-lastprice@1",
        quality: quality
          ? "complete-observed-path"
          : available
            ? "observed-lower-bound"
            : "unavailable",
        issues: [
          ...new Set([
            ...issues,
            ...(outOfOrder ? ["SOURCE_TIME_OUT_OF_ORDER"] : []),
            ...(!available ? ["NO_PRICE_OBSERVATIONS"] : []),
          ]),
        ],
        observations: count,
        observedFrom: firstAt?.toISOString() ?? null,
        observedThrough: lastAt?.toISOString() ?? null,
        mfeR: available ? mfe : null,
        maeR: available ? mae : null,
        peakAt: peakAt?.toISOString() ?? null,
        adverseAt: adverseAt?.toISOString() ?? null,
        maxDrawdownFromPeakR: available ? drawdown : null,
        givebackAtExitR: available
          ? Math.max(
              0,
              mfe - (direction * (exitPrice - input.entryPrice)) / input.initialRiskDistance,
            )
          : null,
        holdingMs: +input.throughAt - +input.openedAt,
        initialRiskDistance: input.initialRiskDistance,
      };
    },
  };
}
