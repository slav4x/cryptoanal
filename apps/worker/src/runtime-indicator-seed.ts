import {
  advanceExecutionIndicators,
  minimumExecutionCandleCount,
  type ExecutionCandle,
  type EnrichedExecutionCandle,
  readExecutionIndicatorCheckpoint,
  type ExecutionIndicatorCheckpoint,
  type ExecutionStrategyConfig,
} from "@cryptoanal/application";

export type ValidationIndicatorSource = {
  datasetSnapshotId: string;
  contentHash: string | null;
  validationRunId: string | null;
  validationEngineVersion: string | null;
};

export function validationIndicatorSource(context: unknown): ValidationIndicatorSource | null {
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const validation = (context as Record<string, unknown>).validation;
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) return null;
  const value = validation as Record<string, unknown>;
  const datasetSnapshotId =
    typeof value.datasetSnapshotId === "string"
      ? value.datasetSnapshotId
      : typeof value.datasetId === "string" && value.datasetId.startsWith("dataset-snapshot:")
        ? value.datasetId.slice("dataset-snapshot:".length)
        : null;
  if (!datasetSnapshotId) return null;
  return {
    datasetSnapshotId,
    contentHash: typeof value.datasetContentHash === "string" ? value.datasetContentHash : null,
    validationRunId: typeof value.runId === "string" ? value.runId : null,
    validationEngineVersion: typeof value.engineVersion === "string" ? value.engineVersion : null,
  };
}

export async function loadValidationIndicatorSeed(input: {
  source: ValidationIndicatorSource;
  symbol: string;
  config: ExecutionStrategyConfig;
  availableAt: Date;
  loadSnapshot: (id: string) => Promise<{
    id: string;
    schemaVersion: number;
    contentHash: string;
    timeframe: string;
    source: string;
    exchange: string;
    instrumentType: string;
    candles: ExecutionCandle[];
  } | null>;
}): Promise<{ checkpoint: ExecutionIndicatorCheckpoint; candle: EnrichedExecutionCandle }> {
  const snapshot = await input.loadSnapshot(input.source.datasetSnapshotId);
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    snapshot.id !== input.source.datasetSnapshotId ||
    snapshot.source !== "bybit-public-linear-klines" ||
    snapshot.exchange !== "bybit" ||
    snapshot.instrumentType !== "linear-perpetual" ||
    snapshot.timeframe !== input.config.universe.timeframe ||
    (input.source.contentHash !== null && snapshot.contentHash !== input.source.contentHash)
  ) {
    throw new Error("Validation indicator seed snapshot is missing or incompatible");
  }
  const history = snapshot.candles
    .filter((candle) => candle.symbol === input.symbol)
    .sort((left, right) => +left.openTime - +right.openTime);
  const intervalMs =
    { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 }[input.config.universe.timeframe] *
    60_000;
  const last = history.at(-1);
  if (!last || +last.openTime + intervalMs > +input.availableAt) {
    throw new Error("Validation indicator seed contains no usable closed history");
  }
  const enriched = advanceExecutionIndicators(history, input.config);
  const checkpoint = enriched.checkpoint!;
  if (checkpoint.tail.length < minimumExecutionCandleCount(input.config)) {
    throw new Error("Validation indicator seed has insufficient continuous warmup");
  }
  checkpoint.availableAt = input.availableAt.toISOString();
  checkpoint.anchor = {
    mode: "validation-dataset",
    datasetSnapshotId: snapshot.id,
    contentHash: snapshot.contentHash,
    startsAt: history[0]!.openTime.toISOString(),
    seededThroughAt: checkpoint.lastCandleAt,
    validationRunId: input.source.validationRunId,
    validationEngineVersion: input.source.validationEngineVersion,
  };
  return {
    checkpoint: readExecutionIndicatorCheckpoint(checkpoint, input.config, input.symbol)!,
    candle: enriched.candles.at(-1)!,
  };
}
