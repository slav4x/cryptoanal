const bounds = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
type Histogram = { counts: number[]; count: number; sum: number; max: number };
type Bucket = { metrics: Map<string, Histogram>; counters: Map<string, number> };

export class RuntimeLatency {
  private readonly buckets = new Map<number, Bucket>();
  public constructor(private readonly clock = Date.now) {}
  private bucket() {
    const time = Math.floor(this.clock() / 10000) * 10000;
    for (const key of this.buckets.keys()) if (key <= time - 300000) this.buckets.delete(key);
    let value = this.buckets.get(time);
    if (!value) this.buckets.set(time, (value = { metrics: new Map(), counters: new Map() }));
    return value;
  }
  public observe(name: string, milliseconds: number) {
    if (!Number.isFinite(milliseconds)) return;
    if (milliseconds < 0) {
      this.increment("clock.negativeDuration");
      return;
    }
    const bucket = this.bucket();
    let h = bucket.metrics.get(name);
    if (!h)
      bucket.metrics.set(
        name,
        (h = { counts: new Array(bounds.length + 1).fill(0), count: 0, sum: 0, max: 0 }),
      );
    const index = bounds.findIndex((bound) => milliseconds <= bound);
    h.counts[index < 0 ? bounds.length : index]!++;
    h.count++;
    h.sum += milliseconds;
    h.max = Math.max(h.max, milliseconds);
  }
  public increment(name: string, amount = 1) {
    const bucket = this.bucket();
    bucket.counters.set(name, (bucket.counters.get(name) ?? 0) + amount);
  }
  public snapshot() {
    this.bucket();
    const metrics = new Map<string, Histogram>(),
      counters: Record<string, number> = {};
    for (const bucket of this.buckets.values()) {
      for (const [name, amount] of bucket.counters) counters[name] = (counters[name] ?? 0) + amount;
      for (const [name, h] of bucket.metrics) {
        const total = metrics.get(name) ?? {
          counts: new Array(bounds.length + 1).fill(0),
          count: 0,
          sum: 0,
          max: 0,
        };
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
      version: 1,
      sampledAt: new Date(this.clock()).toISOString(),
      windowMs: 300000,
      percentileMethod: "histogram-upper-bound",
      bucketMs: 10000,
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
}
