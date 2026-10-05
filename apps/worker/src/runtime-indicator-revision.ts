import {
  advanceExecutionIndicators,
  assertExecutionIndicatorHistory,
  ExecutionIndicatorHistoryRevisedError,
  type ExecutionCandle,
  type ExecutionIndicatorCheckpoint,
  type ExecutionStrategyConfig,
} from "@cryptoanal/application";

export async function restoreRevisedIndicators(input: {
  checkpoint: ExecutionIndicatorCheckpoint;
  history: ExecutionCandle[];
  revisionAt: Date | null;
  availableAt: Date;
  config: ExecutionStrategyConfig;
  loadSeed: () => Promise<ExecutionIndicatorCheckpoint>;
  loadHistory: (start: Date, end: Date) => Promise<ExecutionCandle[]>;
}) {
  const { checkpoint, config } = input;
  let revised =
    input.revisionAt !== null &&
    +input.revisionAt > Date.parse(checkpoint.sourceRevisionAt ?? "1970-01-01T00:00:00Z");
  try {
    const runtimeHistory = checkpoint.anchor
      ? input.history.filter(
          (candle) => +candle.openTime > Date.parse(checkpoint.anchor!.seededThroughAt),
        )
      : input.history;
    assertExecutionIndicatorHistory(runtimeHistory, checkpoint);
  } catch (error) {
    if (!(error instanceof ExecutionIndicatorHistoryRevisedError)) throw error;
    revised = true;
  }
  if (!revised) return { checkpoint, restored: false };
  if (!checkpoint.anchor)
    throw new Error("Revised indicators require an immutable validation anchor");
  const seed = await input.loadSeed();
  const anchorKeys = [
    "mode",
    "datasetSnapshotId",
    "contentHash",
    "startsAt",
    "seededThroughAt",
    "validationRunId",
    "validationEngineVersion",
  ] as const;
  if (!seed.anchor || anchorKeys.some((key) => seed.anchor![key] !== checkpoint.anchor![key]))
    throw new Error("Indicator revision seed does not match the pinned anchor");
  const intervalMs =
    { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 }[config.universe.timeframe] * 60_000;
  const start = new Date(Date.parse(seed.lastCandleAt) + intervalMs);
  const end = new Date(checkpoint.lastCandleAt);
  const count = Math.floor((+end - +start) / intervalMs) + 1;
  if (count < 0 || count > 50_000)
    throw new Error("Indicator revision replay exceeds its pinned range");
  const history = count ? await input.loadHistory(start, end) : [];
  const ordered = [...history].sort((left, right) => +left.openTime - +right.openTime);
  if (
    ordered.length !== count ||
    ordered.some(
      (candle, index) =>
        candle.symbol !== checkpoint.symbol || +candle.openTime !== +start + index * intervalMs,
    )
  )
    throw new Error("Indicator revision history is incomplete; checkpoint unchanged");
  const restored = advanceExecutionIndicators(ordered, config, seed).checkpoint!;
  restored.sourceRevisionAt =
    input.revisionAt?.toISOString() ?? checkpoint.sourceRevisionAt ?? null;
  restored.availableAt = new Date(
    Math.max(
      +input.availableAt,
      +(input.revisionAt ?? 0),
      Date.parse(checkpoint.availableAt ?? "1970-01-01T00:00:00Z"),
    ),
  ).toISOString();
  return { checkpoint: restored, restored: true };
}
