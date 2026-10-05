export function signalAvailabilityTimes(
  history: Array<{ openTime: Date; finalizedAt: Date | null; revisedAt?: Date | null }>,
  intervalMs: number,
  unknownAvailableAt: Date,
) {
  let availableAfter = 0;
  return history.map((candle) => {
    // Indicators need every preceding input, including a late warmup/backfill candle.
    availableAfter = Math.max(
      availableAfter,
      +(candle.finalizedAt ?? unknownAvailableAt),
      +(candle.revisedAt ?? 0),
      +candle.openTime + intervalMs,
    );
    return new Date(availableAfter);
  });
}
