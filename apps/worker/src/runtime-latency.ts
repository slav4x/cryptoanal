const bounds = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
type Histogram = { counts: number[]; count: number; sum: number; max: number };
type Samples = { metrics: Map<string, Histogram>; counters: Map<string, number> };
type Phase = "startup" | "steady";
type Bucket = { all: Samples; phases: Map<Phase, Samples> };
const empty = (): Samples => ({ metrics: new Map(), counters: new Map() });
const histogram = (): Histogram => ({
  counts: new Array(bounds.length + 1).fill(0),
  count: 0,
  sum: 0,
  max: 0,
});
function summarise(samples: Samples[]) {
  const metrics = new Map<string, Histogram>(),
    counters: Record<string, number> = {};
  for (const sample of samples) {
    for (const [name, amount] of sample.counters) counters[name] = (counters[name] ?? 0) + amount;
    for (const [name, h] of sample.metrics) {
      const total = metrics.get(name) ?? histogram();
      total.count += h.count;
      total.sum += h.sum;
      total.max = Math.max(total.max, h.max);
      h.counts.forEach((count, index) => {
        total.counts[index]! += count;
      });
      metrics.set(name, total);
    }
  }
  return {
    metrics: Object.fromEntries(
      [...metrics].map(([name, h]) => {
        const percentile = (p: number) => {
          let count = 0;
          for (let i = 0; i < h.counts.length; i++) {
            count += h.counts[i]!;
            if (count >= Math.ceil(h.count * p)) return bounds[i] ?? h.max;
          }
          return h.max;
        };
        return [
          name,
          {
            count: h.count,
            meanMs: h.sum / h.count,
            p50Ms: percentile(0.5),
            p95Ms: percentile(0.95),
            p99Ms: percentile(0.99),
            maxMs: h.max,
          },
        ];
      }),
    ),
    counters,
  };
}
export class RuntimeLatency {
  private readonly buckets = new Map<number, Bucket>();
  private readonly startedAt: number;
  public constructor(private readonly clock = Date.now) {
    this.startedAt = clock();
  }
  private bucket() {
    const now = this.clock(),
      time = Math.floor(now / 10000) * 10000;
    for (const key of this.buckets.keys()) if (key <= time - 300000) this.buckets.delete(key);
    let value = this.buckets.get(time);
    if (!value) this.buckets.set(time, (value = { all: empty(), phases: new Map() }));
    const phase: Phase = now - this.startedAt < 300000 ? "startup" : "steady";
    let phased = value.phases.get(phase);
    if (!phased) value.phases.set(phase, (phased = empty()));
    return [value.all, phased];
  }
  public observe(name: string, milliseconds: number) {
    if (!Number.isFinite(milliseconds)) return;
    if (milliseconds < 0) {
      this.increment("clock.negativeDuration");
      this.increment(`clock.negative.${name}`);
      return;
    }
    for (const bucket of this.bucket()) {
      let h = bucket.metrics.get(name);
      if (!h) bucket.metrics.set(name, (h = histogram()));
      const index = bounds.findIndex((bound) => milliseconds <= bound);
      h.counts[index < 0 ? bounds.length : index]!++;
      h.count++;
      h.sum += milliseconds;
      h.max = Math.max(h.max, milliseconds);
    }
  }
  public increment(name: string, amount = 1) {
    for (const bucket of this.bucket())
      bucket.counters.set(name, (bucket.counters.get(name) ?? 0) + amount);
  }
  public snapshot() {
    this.bucket();
    const now = this.clock(),
      buckets = [...this.buckets.values()];
    return {
      version: 2,
      startedAt: new Date(this.startedAt).toISOString(),
      windowStartedAt: new Date(
        Math.max(this.startedAt, Math.floor(now / 10000) * 10000 - 290000),
      ).toISOString(),
      sampledAt: new Date(now).toISOString(),
      windowMs: 300000,
      startupMs: 300000,
      percentileMethod: "histogram-upper-bound",
      bucketMs: 10000,
      ...summarise(buckets.map((b) => b.all)),
      phases: Object.fromEntries(
        (["startup", "steady"] as const).map((phase) => [
          phase,
          summarise(
            buckets.flatMap((b) => {
              const sample = b.phases.get(phase);
              return sample ? [sample] : [];
            }),
          ),
        ]),
      ),
    };
  }
}
