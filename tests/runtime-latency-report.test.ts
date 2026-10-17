import assert from "node:assert/strict";
import { test } from "node:test";
import { assessRuntimeLatency } from "../scripts/lib/runtime-latency-report";
const metric = "market.deliveryMs";
const sample = (count: number, p99Ms: number) => ({
  metrics: { [metric]: { count, p99Ms, maxMs: p99Ms } },
  counters: {} as Record<string, number>,
});

test("negative cross-clock samples cannot disappear behind a successful latency result", () => {
  const source = sample(255, 500);
  source.counters[`clock.negative.${metric}`] = 5571;
  const result = assessRuntimeLatency(source, true, 2).find((x) => x.metric === metric)!;
  assert.equal(result.status, "clock-uncertain");
  assert.equal(result.negativeSamples, 5571);
  assert.equal(result.samples, 255);
});

test("sparse observations keep their maximum and cannot confirm tail latency", () => {
  const result = assessRuntimeLatency(sample(2, 900), true, 2).find((x) => x.metric === metric)!;
  assert.equal(result.status, "insufficient-samples");
  assert.equal(result.maxMs, 900);
  assert.equal(assessRuntimeLatency(sample(2, 1200), true, 2)[0]!.status, "exceeded");
  assert.equal(assessRuntimeLatency(sample(100, 500), true, 2)[0]!.status, "passed");
});

test("legacy unattributed clock failures, stale workers and unobserved stages stay explicit", () => {
  const legacy = sample(1000, 500);
  legacy.counters["clock.negativeDuration"] = 10000;
  assert.equal(assessRuntimeLatency(legacy, true, 1)[0]!.status, "clock-uncertain");
  assert.equal(assessRuntimeLatency(legacy, false, 1)[0]!.status, "stale");
  const current = assessRuntimeLatency(sample(1000, 500), true, 2);
  assert.equal(current[0]!.status, "passed");
  assert.equal(current.find((x) => x.metric === "entry.quoteToFillMs")!.status, "unobserved");
});
