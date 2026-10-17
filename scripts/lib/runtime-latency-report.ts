export const runtimeLatencyLimits = {
  "market.deliveryMs": 1000,
  "journal.eventToCommitMs": 500,
  "position.realtime.eventToCheckpointMs": 2000,
  "position.recovery.eventToCheckpointMs": 5000,
  "protection.eventToCheckpointMs": 1000,
  "entry.quoteToFillMs": 1000,
};
export const latencyTailSampleFloor = 100;
type Samples = {
  metrics: Record<string, { count: number; p99Ms: number; maxMs: number }>;
  counters: Record<string, number>;
};
export function assessRuntimeLatency(samples: Samples, fresh: boolean, version: number) {
  return Object.entries(runtimeLatencyLimits).map(([metric, p99LimitMs]) => {
    const sample = samples.metrics[metric],
      negativeSamples = samples.counters[`clock.negative.${metric}`] ?? 0,
      unattributedClockSamples =
        metric === "market.deliveryMs" && version !== 2
          ? (samples.counters["clock.negativeDuration"] ?? 0)
          : 0;
    return {
      metric,
      p99LimitMs,
      samples: sample?.count ?? 0,
      negativeSamples,
      unattributedClockSamples,
      sampleSufficiency: !sample
        ? "unobserved"
        : sample.count < latencyTailSampleFloor
          ? "sparse"
          : "observed",
      maxMs: sample?.maxMs ?? null,
      status: !fresh
        ? "stale"
        : negativeSamples || unattributedClockSamples
          ? "clock-uncertain"
          : !sample
            ? "unobserved"
            : sample.p99Ms > p99LimitMs
              ? "exceeded"
              : sample.count < latencyTailSampleFloor
                ? "insufficient-samples"
                : "passed",
    };
  });
}
