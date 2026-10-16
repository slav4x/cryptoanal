import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  TradeAuditMonitor,
  writeMonitorJson,
  summariseRetainedResult,
  type Closure,
} from "../scripts/lib/trade-audit-monitor";
import { hashTracePayload } from "../packages/persistence/src/position-trace";
import type { auditRetainedTrade } from "../apps/worker/src/retained-trade-audit";

const at = new Date("2026-10-17T01:00:00Z");
function closure(id: string, age = 0): Closure {
  return {
    id,
    positionId: `position-${id}`,
    createdAt: new Date(+at - age).toISOString(),
    closedAt: new Date(+at - age).toISOString(),
    retainUntil: new Date(+at + 86400000).toISOString(),
  };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cryptoanal-monitor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = at;
  const options = {
    root,
    workspaceId: "w",
    baselineHash: "baseline",
    implementationHash: "implementation",
    minimumFreeBytes: 0,
    now: () => now,
  };
  return {
    options,
    monitor: await TradeAuditMonitor.open(options),
    advance: (ms: number) => {
      now = new Date(+now + ms);
    },
  };
}
async function savedResult(root: string, job: Closure, cohort = "baseline-closed") {
  await mkdir(join(root, "evidence"), { recursive: true });
  const source = { position: { id: job.positionId }, trade: { id: job.id } };
  const manifest = { version: 1, sourceHash: hashTracePayload(source), pages: [], funding: [] };
  await writeFile(join(root, "evidence", "source.json"), JSON.stringify(source));
  await writeFile(join(root, "evidence", "manifest.json"), JSON.stringify(manifest));
  const result = {
    version: "cryptoanal-retained-trade-audit@1",
    tradeId: job.id,
    positionId: job.positionId,
    status: "insufficient-data",
    identity: { symbol: "BTCUSDT", side: "BUY" },
    checks: [
      {
        id: "admission",
        outcome: "unknown",
        actual: "NO_ORIGINAL_ACCOUNT_PROOF",
        evidenceIds: [],
        expected: "original",
      },
    ],
    cases: [{ caseId: "settlement", status: "insufficient-data" }],
    path: { complete: false },
  } as unknown as Awaited<ReturnType<typeof auditRetainedTrade>>;
  const payload = {
    result,
    resultHash: hashTracePayload(result),
    evidence: { hash: hashTracePayload(manifest) },
    implementation: { hash: "implementation" },
    baselineHash: "baseline",
    cohort,
  };
  const saved = { payload, hash: hashTracePayload(payload) };
  await writeFile(join(root, "result.json"), JSON.stringify(saved));
  return summariseRetainedResult(saved, root, job, "implementation", "baseline");
}
test("repeated discovery and restart keep one outcome per Trade and checker generation", async (t) => {
  const x = await fixture(t),
    row = closure("one");
  await x.monitor.discover(async () => ({
    asOf: at.toISOString(),
    total: 1,
    rows: [row],
    done: true,
  }));
  assert.equal(await x.monitor.runOne((job, dir) => savedResult(dir, job)), true);
  const resumed = await TradeAuditMonitor.open(x.options);
  await resumed.recover();
  await resumed.verifyLatest();
  await resumed.discover(async () => ({
    asOf: at.toISOString(),
    total: 1,
    rows: [row],
    done: true,
  }));
  assert.equal(
    await resumed.runOne(() => {
      throw Error("already checked");
    }),
    false,
  );
  assert.equal(resumed.state.jobs.one!.attempts, 1);
  assert.equal(resumed.report().totals.incomplete, 1);
  assert.equal(resumed.report().totals.known, 1);
});
test("a crash before the result retries the closure and does not skip the next Trade", async (t) => {
  const x = await fixture(t);
  const a = await x.monitor.addClosure(closure("a", 20)),
    b = await x.monitor.addClosure(closure("b"));
  await x.monitor.start(a);
  const restarted = await TradeAuditMonitor.open(x.options);
  await restarted.recover();
  assert.match(restarted.state.jobs.a!.latest!.error!, /INTERRUPTED_ATTEMPT/);
  const seen: string[] = [];
  await restarted.runOne(async (job, dir) => {
    seen.push(job.id);
    return savedResult(dir, job);
  });
  assert.deepEqual(seen, [b.id]);
  x.advance(16000);
  await restarted.runOne(async (job, dir) => {
    seen.push(job.id);
    return savedResult(dir, job);
  });
  assert.deepEqual(seen, [b.id, a.id]);
  assert.equal(restarted.state.jobs.a!.attempts, 2);
});
test("a result persisted before its receipt is adopted after restart without replay", async (t) => {
  const x = await fixture(t),
    job = await x.monitor.addClosure(closure("a"));
  const dir = await x.monitor.start(job);
  await savedResult(dir, job);
  const restarted = await TradeAuditMonitor.open(x.options);
  await restarted.recover();
  await restarted.verifyLatest();
  assert.equal(restarted.state.jobs.a!.attempts, 1);
  assert.equal(restarted.state.jobs.a!.latest!.result!.status, "insufficient-data");
  assert.equal(
    await restarted.runOne(() => {
      throw Error("must not repeat");
    }),
    false,
  );
});
test("a committed receipt survives a crash before the mutable index pointer", async (t) => {
  const x = await fixture(t),
    job = await x.monitor.addClosure(closure("a")),
    dir = await x.monitor.start(job),
    result = await savedResult(dir, job);
  result.resultPath = relative(x.options.root, result.resultPath);
  await writeMonitorJson(
    join(dir, "receipt.json"),
    {
      tradeId: job.id,
      number: 1,
      startedAt: at.toISOString(),
      completedAt: at.toISOString(),
      result,
      error: null,
      retryable: false,
    },
    true,
  );
  const restarted = await TradeAuditMonitor.open(x.options);
  await restarted.recover();
  await restarted.verifyLatest();
  assert.equal(restarted.state.jobs.a!.attempts, 1);
  assert.equal(restarted.report().totals.checked, 1);
});
test("a failed database read is visible and does not block healthy closures", async (t) => {
  const x = await fixture(t);
  await x.monitor.addClosure(closure("a", 10));
  await x.monitor.addClosure(closure("b"));
  await x.monitor.runOne(async () => {
    throw new Error("SOURCE_READ_UNAVAILABLE");
  });
  await x.monitor.runOne((job, dir) => savedResult(dir, job));
  assert.equal(x.monitor.report().totals.sourceErrors, 1);
  assert.equal(x.monitor.report().totals.checked, 1);
  assert.equal(x.monitor.report().totals.retrying, 1);
  await assert.rejects(
    x.monitor.discover(async () => {
      throw new Error("database unavailable");
    }),
    /database unavailable/,
  );
  assert.match(x.monitor.report().source.error!, /database unavailable/);
  assert.equal(x.monitor.report().totals.known, 2);
});
test("cyclic inventory catches backdated rows behind a persisted cursor", async (t) => {
  const x = await fixture(t),
    a = closure("a", 20),
    b = closure("b", 10),
    late = closure("late", 100);
  let rows = [a, b];
  const load = async (cursor: { createdAt: string; id: string } | null, asOf: string | null) => {
    const page = rows
      .filter(
        (r) =>
          !cursor ||
          r.createdAt > cursor.createdAt ||
          (r.createdAt === cursor.createdAt && r.id > cursor.id),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, 1);
    return {
      asOf: asOf ?? at.toISOString(),
      total: rows.length,
      rows: page,
      done: page.length === 0,
    };
  };
  await x.monitor.discover(load);
  const restarted = await TradeAuditMonitor.open(x.options);
  await restarted.discover(load);
  await restarted.discover(load);
  rows = [late, a, b];
  await restarted.discover(load);
  await restarted.discover(load);
  await restarted.discover(load);
  await restarted.discover(load);
  assert.equal(restarted.report().totals.known, 3);
  assert.equal(restarted.report().source.undiscovered, 0);
});
test("zero closures differs from an unavailable inventory and a missing known Trade", async (t) => {
  const x = await fixture(t);
  await x.monitor.discover(async () => ({
    asOf: at.toISOString(),
    total: 0,
    rows: [],
    done: true,
  }));
  assert.equal(x.monitor.report().source.error, null);
  assert.equal(x.monitor.report().totals.sourceTotal, 0);
  await x.monitor.addClosure(closure("a"));
  await assert.rejects(
    x.monitor.discover(async () => ({ asOf: at.toISOString(), total: 0, rows: [], done: true })),
    /MISSING_FROM_SOURCE/,
  );
  assert.equal(x.monitor.report().totals.known, 1);
  assert.match(x.monitor.report().source.error!, /MISSING_FROM_SOURCE/);
});
test("lost or corrupted retained source gets a new failure attempt and cannot remain accepted", async (t) => {
  const x = await fixture(t),
    job = await x.monitor.addClosure(closure("a"));
  await x.monitor.runOne((job, dir) => savedResult(dir, job));
  const original = join(x.options.root, job.latest!.result!.resultPath);
  const text = await readFile(original, "utf8");
  await writeFile(join(original, "..", "evidence", "source.json"), "{}");
  const restarted = await TradeAuditMonitor.open(x.options);
  await restarted.verifyLatest();
  assert.equal(restarted.report().totals.checked, 0);
  assert.equal(restarted.report().totals.sourceErrors, 1);
  assert.equal(restarted.state.jobs.a!.attempts, 2);
  assert.equal(await readFile(original, "utf8"), text);
  assert.match(restarted.state.jobs.a!.latest!.error!, /RETAINED_EVIDENCE_CORRUPT/);
});
test("state corruption and a changed baseline never silently reset the index", async (t) => {
  const x = await fixture(t);
  await x.monitor.addClosure(closure("a"));
  await assert.rejects(
    TradeAuditMonitor.open({ ...x.options, baselineHash: "different" }),
    /identity mismatch/,
  );
  await writeFile(join(x.options.root, "state.json"), "{}");
  await assert.rejects(TradeAuditMonitor.open(x.options), /checksum mismatch/);
});
test("storage and queue limits stop before claiming an attempt or advancing past an unsaved row", async (t) => {
  const x = await fixture(t),
    row = closure("a"),
    job = await x.monitor.addClosure(row);
  const lowDisk = await TradeAuditMonitor.open({
    ...x.options,
    minimumFreeBytes: Number.MAX_SAFE_INTEGER,
  });
  await assert.rejects(lowDisk.start(lowDisk.state.jobs.a!), /LOW_DISK/);
  assert.equal(lowDisk.state.jobs.a!.attempts, 0);
  assert.equal(job.active, null);
  const limited = await TradeAuditMonitor.open({ ...x.options, maxJobs: 1 });
  await assert.rejects(
    limited.discover(async () => ({
      asOf: at.toISOString(),
      total: 2,
      rows: [row, closure("b")],
      done: true,
    })),
    /JOB_BUDGET/,
  );
  assert.equal(limited.state.cursor, null);
  assert.equal(limited.state.jobs.a!.id, "a");
  assert.equal(limited.state.jobs.b, undefined);
});
test("a lost lease cannot commit a result or mark the closure complete", async (t) => {
  const x = await fixture(t);
  let owns = true;
  const monitor = await TradeAuditMonitor.open({
      ...x.options,
      assertLease: () => {
        if (!owns) throw Error("lease lost");
      },
    }),
    job = await monitor.addClosure(closure("a")),
    dir = await monitor.start(job),
    result = await savedResult(dir, job);
  owns = false;
  await assert.rejects(monitor.complete(job, result, null), /lease lost/);
  assert.equal(job.latest, null);
  const restarted = await TradeAuditMonitor.open(x.options);
  await restarted.recover();
  assert.equal(restarted.state.jobs.a!.attempts, 1);
  assert.equal(restarted.report().totals.checked, 1);
});

test("restart recovers an active claim even when its attempt directory was not created", async (t) => {
  const x = await fixture(t),
    job = await x.monitor.addClosure(closure("a")),
    dir = await x.monitor.start(job);
  await rm(dir, { recursive: true });
  const restarted = await TradeAuditMonitor.open(x.options);
  await restarted.recover();
  assert.equal(restarted.state.jobs.a!.attempts, 1);
  assert.match(restarted.state.jobs.a!.latest!.error!, /INTERRUPTED_ATTEMPT/);
});
test("a corrupted receipt remains preserved while a new failure attempt records the problem", async (t) => {
  const x = await fixture(t),
    job = await x.monitor.addClosure(closure("a")),
    dir = await x.monitor.start(job);
  await writeFile(join(dir, "receipt.json"), "{}");
  const restarted = await TradeAuditMonitor.open(x.options);
  await restarted.recover();
  assert.equal(restarted.state.jobs.a!.attempts, 2);
  assert.match(restarted.state.jobs.a!.latest!.error!, /RECEIPT_CORRUPT/);
  assert.equal(await readFile(join(dir, "receipt.json"), "utf8"), "{}");
});
test("retained outcomes survive relocating the local store to another mount path", async (t) => {
  const x = await fixture(t),
    job = await x.monitor.addClosure(closure("a"));
  await x.monitor.runOne((j, dir) => savedResult(dir, j));
  const next = await mkdtemp(join(tmpdir(), "cryptoanal-monitor-moved-"));
  t.after(() => rm(next, { recursive: true, force: true }));
  const { cp } = await import("node:fs/promises");
  await cp(x.options.root, next, { recursive: true });
  const moved = await TradeAuditMonitor.open({ ...x.options, root: next });
  await moved.recover();
  await moved.verifyLatest();
  assert.equal(moved.report().totals.checked, 1);
  assert.equal(moved.state.jobs[job.id]!.attempts, 1);
});

test("coverage of the old cohort never supplies a new forward cohort's confirmation", async (t) => {
  const x = await fixture(t);
  await x.monitor.addClosure(closure("old", 10));
  await x.monitor.addClosure(closure("new"));
  await x.monitor.runOne((job, dir) => savedResult(dir, job, "baseline-closed"));
  await x.monitor.runOne((job, dir) => savedResult(dir, job, "new-entry-pinned"));
  const groups = x.monitor.report().groups;
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.sourceGroupId, groups[1]!.sourceGroupId);
  assert.notEqual(groups[0]!.cohort, groups[1]!.cohort);
});
test("processing and waiting counters do not count the same closure twice", async (t) => {
  const x = await fixture(t),
    job = await x.monitor.addClosure(closure("a"));
  await x.monitor.start(job);
  const total = x.monitor.report().totals;
  assert.equal(total.pending, 0);
  assert.equal(total.active, 1);
  assert.equal(total.checked + total.sourceErrors + total.pending + total.active, total.known);
});
test("the nearest retention deadline precedes older work and expires visibly", async (t) => {
  const x = await fixture(t);
  await x.monitor.addClosure({ ...closure("old", 1000), retainUntil: null });
  await x.monitor.addClosure({
    ...closure("near"),
    retainUntil: new Date(+at + 100).toISOString(),
  });
  assert.equal(x.monitor.nextJob()!.id, "near");
  assert.equal(x.monitor.report().totals.expiringUncaptured, 1);
  x.advance(101);
  assert.equal(x.monitor.report().totals.expiredUncaptured, 1);
});

test("a changed result cannot replace the outcome pinned by its immutable receipt", async (t) => {
  const x = await fixture(t),
    job = await x.monitor.addClosure(closure("a"));
  await x.monitor.runOne((j, dir) => savedResult(dir, j));
  const path = join(x.options.root, job.latest!.result!.resultPath),
    saved = JSON.parse(await readFile(path, "utf8"));
  saved.payload.result.status = "confirmed";
  saved.payload.resultHash = hashTracePayload(saved.payload.result);
  saved.hash = hashTracePayload(saved.payload);
  await writeFile(path, JSON.stringify(saved));
  await x.monitor.verifyLatest();
  assert.equal(x.monitor.report().totals.confirmed, 0);
  assert.equal(x.monitor.report().totals.sourceErrors, 1);
  assert.match(job.latest!.error!, /changed after receipt commit/);
});
