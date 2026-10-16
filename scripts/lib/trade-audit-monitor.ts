import type { auditRetainedTrade } from "../../apps/worker/src/retained-trade-audit";
import { open, readFile, rename, mkdir, readdir, stat, statfs } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { hashTracePayload } from "../../packages/persistence/src/position-trace";

export type Closure = {
  id: string;
  positionId: string;
  createdAt: string;
  closedAt: string;
  retainUntil: string | null;
};
type ResultSummary = {
  status: string;
  identity: Record<string, unknown>;
  cohort: string;
  completePath: boolean;
  cases: Array<{ caseId: string; status: string }>;
  unknownReasons: string[];
  failures: string[];
  resultHash: string;
  evidenceHash: string;
  resultPath: string;
};
export type AttemptReceipt = {
  tradeId: string;
  number: number;
  startedAt: string;
  completedAt: string;
  result: ResultSummary | null;
  error: string | null;
  retryable: boolean;
};
export type AuditJob = Closure & {
  lastSeenScan?: string;
  sourceCreatedAtVerified?: true;
  createdAtCorrectedFrom?: string;
  discoveredAt: string;
  evidenceVerifiedAt?: string;
  attempts: number;
  active: null | { number: number; startedAt: string; directory: string };
  latest: AttemptReceipt | null;
  nextAt: string | null;
};
export type MonitorState = {
  version: 1;
  workspaceId: string;
  baselineHash: string;
  implementationHash: string;
  lastDiscoveryAt: string | null;
  lastCompletedScanAt: string | null;
  scanAsOf: string | null;
  cursor: null | { createdAt: string; id: string };
  sourceTotal: number | null;
  sourceError: string | null;
  seedErrors?: Record<string, string>;
  jobs: Record<string, AuditJob>;
};
export type DiscoveryPage = { asOf: string; total: number; rows: Closure[]; done: boolean };
export type MonitorOptions = {
  workspaceId: string;
  baselineHash: string;
  implementationHash: string;
  root: string;
  budgetRoot?: string;
  maxJobs?: number;
  maxBytes?: number;
  minimumFreeBytes?: number;
  now?: () => Date;
  assertLease?: () => void;
};
const ENOENT = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
export async function writeMonitorJson(path: string, payload: unknown, immutable = false) {
  const text = JSON.stringify({ payload, hash: hashTracePayload(payload) }) + "\n";
  if (Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new Error("MONITOR_STATE_BYTE_BUDGET_EXCEEDED");
  if (immutable) {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    return;
  }
  const tmp = `${path}.${randomUUID()}.tmp`,
    file = await open(tmp, "wx", 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
  const dir = await open(resolve(path, ".."), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export async function readMonitorJson<T>(path: string): Promise<T> {
  if ((await stat(path)).size > 32 * 1024 * 1024)
    throw new Error("Monitor JSON byte budget exceeded");
  const data = JSON.parse(await readFile(path, "utf8"));
  if (
    data.payload === undefined ||
    typeof data.hash !== "string" ||
    hashTracePayload(data.payload) !== data.hash
  )
    throw new Error("Monitor checksum mismatch");
  return data.payload as T;
}
export async function monitorDirectoryBytes(root: string): Promise<number> {
  let bytes = 0,
    files = 0;
  async function visit(dir: string) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (++files > 100000) throw new Error("MONITOR_FILE_BUDGET_EXCEEDED");
      const path = join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error("Monitor store cannot contain symlinks");
      if (item.isDirectory()) await visit(path);
      else bytes += (await stat(path)).size;
    }
  }
  await visit(root);
  return bytes;
}
export function summariseRetainedResult(
  saved: {
    hash: string;
    payload: {
      implementation: { hash: string };
      baselineHash: string;
      result: Awaited<ReturnType<typeof auditRetainedTrade>>;
      resultHash: string;
      evidence: { hash: string };
      coverageGroup?: Record<string, unknown>;
      cohort: string;
    };
  },
  root: string,
  job: Closure,
  implementationHash: string,
  baselineHash: string,
): ResultSummary {
  if (hashTracePayload(saved.payload) !== saved.hash)
    throw new Error("Retained result checksum mismatch");
  const p = saved.payload,
    r = p.result;
  if (
    p.implementation.hash !== implementationHash ||
    p.baselineHash !== baselineHash ||
    r.tradeId !== job.id ||
    r.positionId !== job.positionId ||
    hashTracePayload(r) !== p.resultHash
  )
    throw new Error("Retained result identity mismatch");
  const unknown = r.checks
    .filter((c) => c.outcome === "unknown")
    .map((c) =>
      typeof c.actual === "string" ? `${c.id}:${c.actual}` : `${c.id}:ORIGINAL_EVIDENCE_INCOMPLETE`,
    );
  return {
    status: r.status,
    identity: p.coverageGroup ?? r.identity,
    cohort: p.cohort,
    completePath: r.path.complete,
    cases: r.cases.map((c) => ({ caseId: c.caseId, status: c.status })),
    unknownReasons: unknown,
    failures: r.checks
      .filter((c) => c.outcome === "fail")
      .map(
        (c) =>
          `${c.id}:${String(typeof c.actual === "string" ? c.actual : JSON.stringify(c.actual)).slice(0, 300)}`,
      ),
    resultHash: p.resultHash,
    evidenceHash: p.evidence.hash,
    resultPath: join(root, "result.json"),
  };
}
export class TradeAuditMonitor {
  private constructor(
    public readonly options: MonitorOptions,
    public state: MonitorState,
  ) {}
  private now() {
    return (this.options.now ?? (() => new Date()))();
  }
  private async save() {
    this.options.assertLease?.();
    await writeMonitorJson(join(this.options.root, "state.json"), this.state);
  }
  static async open(options: MonitorOptions) {
    await mkdir(join(options.root, "attempts"), { recursive: true, mode: 0o700 });
    let state: MonitorState;
    try {
      state = await readMonitorJson(join(options.root, "state.json"));
    } catch (e) {
      if (!ENOENT(e)) throw e;
      state = {
        version: 1,
        workspaceId: options.workspaceId,
        baselineHash: options.baselineHash,
        implementationHash: options.implementationHash,
        lastDiscoveryAt: null,
        lastCompletedScanAt: null,
        scanAsOf: null,
        cursor: null,
        sourceTotal: null,
        sourceError: null,
        jobs: {},
      };
    }
    if (
      state.version !== 1 ||
      state.workspaceId !== options.workspaceId ||
      state.baselineHash !== options.baselineHash ||
      state.implementationHash !== options.implementationHash
    )
      throw new Error("Monitor generation identity mismatch");
    const monitor = new TradeAuditMonitor(options, state);
    await monitor.save();
    return monitor;
  }
  async capacity() {
    const free = await statfs(this.options.root);
    if (free.bavail * free.bsize < (this.options.minimumFreeBytes ?? 2 * 1024 ** 3))
      throw new Error("MONITOR_LOW_DISK_SPACE");
    const bytes = await monitorDirectoryBytes(this.options.budgetRoot ?? this.options.root);
    if (bytes > (this.options.maxBytes ?? 8 * 1024 ** 3))
      throw new Error("MONITOR_STORAGE_BUDGET_EXCEEDED");
    return bytes;
  }
  async addClosure(row: Closure, save = true) {
    const prior = this.state.jobs[row.id];
    if (prior) {
      if (prior.positionId !== row.positionId || prior.closedAt !== row.closedAt)
        throw new Error("Closed Trade identity changed after discovery");
      if (prior.createdAt !== row.createdAt) {
        if (prior.sourceCreatedAtVerified)
          throw new Error("Closed Trade creation timestamp changed after discovery");
        prior.createdAtCorrectedFrom = prior.createdAt;
        prior.createdAt = row.createdAt;
      }
      prior.sourceCreatedAtVerified = true;
      return prior;
    }
    if (Object.keys(this.state.jobs).length >= (this.options.maxJobs ?? 10000))
      throw new Error("MONITOR_JOB_BUDGET_EXCEEDED");
    const job: AuditJob = {
      ...row,
      sourceCreatedAtVerified: true,
      discoveredAt: this.now().toISOString(),
      attempts: 0,
      active: null,
      latest: null,
      nextAt: this.now().toISOString(),
    };
    this.state.jobs[row.id] = job;
    if (save) await this.save();
    return job;
  }
  async discover(
    load: (cursor: MonitorState["cursor"], asOf: string | null) => Promise<DiscoveryPage>,
  ) {
    try {
      const page = await load(this.state.cursor, this.state.scanAsOf);
      if (
        !Number.isFinite(Date.parse(page.asOf)) ||
        !Number.isSafeInteger(page.total) ||
        page.total < 0
      )
        throw new Error("Invalid closure inventory");
      if (this.state.scanAsOf && this.state.scanAsOf !== page.asOf)
        throw new Error("Discovery snapshot boundary changed");
      for (const row of page.rows) {
        if (
          !Number.isFinite(Date.parse(row.createdAt)) ||
          !Number.isFinite(Date.parse(row.closedAt)) ||
          !row.id ||
          !row.positionId
        )
          throw new Error("Invalid closure identity");
        const job = await this.addClosure(row, false);
        job.lastSeenScan = page.asOf;
      }
      this.state.sourceTotal = page.total;
      this.state.lastDiscoveryAt = this.now().toISOString();
      this.state.sourceError = null;
      const last = page.rows.at(-1);
      if (!page.done && !last) throw new Error("Discovery cursor cannot advance");
      this.state.cursor = page.done ? null : { createdAt: last!.createdAt, id: last!.id };
      this.state.scanAsOf = page.done ? null : page.asOf;
      if (page.done) {
        const missing = Object.values(this.state.jobs).filter(
          (j) =>
            j.createdAt <= page.asOf && j.closedAt <= page.asOf && j.lastSeenScan !== page.asOf,
        );
        if (missing.length)
          throw new Error(
            `DISCOVERED_TRADE_MISSING_FROM_SOURCE:${missing
              .map((j) => j.id)
              .slice(0, 10)
              .join(",")}`,
          );
        this.state.lastCompletedScanAt = this.now().toISOString();
      }
      await this.save();
    } catch (error) {
      this.state.sourceError = error instanceof Error ? error.message : String(error);
      await this.save();
      throw error;
    }
  }
  nextJob() {
    const now = +this.now();
    return (
      Object.values(this.state.jobs)
        .filter((j) => !j.active && j.nextAt !== null && Date.parse(j.nextAt) <= now)
        .sort(
          (a, b) =>
            Date.parse(a.retainUntil ?? "9999-01-01") - Date.parse(b.retainUntil ?? "9999-01-01") ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        )[0] ?? null
    );
  }
  async start(job: AuditJob) {
    if (job.active) throw new Error("Trade attempt already active");
    await this.capacity();
    const directory = join(
      this.options.root,
      "attempts",
      hashTracePayload(job.id),
      String(job.attempts + 1),
    );
    job.attempts++;
    job.active = {
      number: job.attempts,
      startedAt: this.now().toISOString(),
      directory: monitorRelativePath(this.options.root, directory),
    };
    await this.save();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }
  async complete(
    job: AuditJob,
    result: ResultSummary | null,
    error: string | null,
    retryable = false,
  ) {
    this.options.assertLease?.();
    if (!job.active) throw new Error("No active trade attempt");
    if (result)
      result = {
        ...result,
        resultPath: monitorRelativePath(
          this.options.root,
          resolve(this.options.root, result.resultPath),
        ),
      };
    const receipt: AttemptReceipt = {
      tradeId: job.id,
      number: job.active.number,
      startedAt: job.active.startedAt,
      completedAt: this.now().toISOString(),
      result,
      error,
      retryable,
    };
    await writeMonitorJson(
      join(this.options.root, job.active.directory, "receipt.json"),
      receipt,
      true,
    );
    job.latest = receipt;
    if (result) job.evidenceVerifiedAt = this.now().toISOString();
    job.active = null;
    job.nextAt = retryable
      ? new Date(
          +this.now() + Math.min(900000, 15000 * 2 ** Math.min(job.attempts - 1, 6)),
        ).toISOString()
      : null;
    await this.save();
    return receipt;
  }
  async recover() {
    for (const job of Object.values(this.state.jobs))
      if (job.active) {
        const expected = join("attempts", hashTracePayload(job.id), String(job.active.number));
        if (job.active.directory !== expected)
          throw new Error("Attempt directory identity mismatch");
        await mkdir(join(this.options.root, job.active.directory), {
          recursive: true,
          mode: 0o700,
        });
        let receipt: AttemptReceipt | null = null;
        try {
          receipt = await readMonitorJson(
            join(this.options.root, job.active.directory, "receipt.json"),
          );
        } catch (e) {
          if (!ENOENT(e)) {
            job.active = null;
            await this.save();
            await this.start(job);
            await this.complete(
              job,
              null,
              `ATTEMPT_RECEIPT_CORRUPT:${e instanceof Error ? e.message : String(e)}`,
              true,
            );
            continue;
          }
        }
        if (receipt) {
          if (receipt.tradeId !== job.id || receipt.number !== job.active.number)
            throw new Error("Attempt receipt identity mismatch");
          job.latest = receipt;
          job.active = null;
          job.nextAt = receipt.retryable ? this.now().toISOString() : null;
          await this.save();
          continue;
        }
        try {
          const path = join(this.options.root, job.active.directory, "result.json");
          if ((await stat(path)).size > 32 * 1024 * 1024)
            throw new Error("Result byte budget exceeded");
          const saved = JSON.parse(await readFile(path, "utf8"));
          const summary = summariseRetainedResult(
            saved,
            job.active.directory,
            job,
            this.state.implementationHash,
            this.state.baselineHash,
          );
          const { verifyRetainedEvidence } = await import("./retained-audit-source");
          await verifyRetainedEvidence(
            join(this.options.root, job.active.directory, "evidence"),
            summary.evidenceHash,
          );
          await this.complete(
            job,
            summary,
            null,
            summary.unknownReasons.some((s) =>
              /SOURCE_READ_UNAVAILABLE|FUNDING_SOURCE_READ_UNAVAILABLE/.test(s),
            ),
          );
        } catch (error) {
          await this.complete(
            job,
            null,
            `INTERRUPTED_ATTEMPT:${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
      }
  }
  async verifyLatest() {
    const { verifyRetainedEvidence } = await import("./retained-audit-source");
    for (const job of Object.values(this.state.jobs))
      if (job.latest?.result && !job.active) {
        const result = job.latest.result;
        try {
          const path = resolve(this.options.root, result.resultPath);
          monitorRelativePath(this.options.root, path);
          if ((await stat(path)).size > 32 * 1024 * 1024)
            throw new Error("Result byte budget exceeded");
          const saved = JSON.parse(await readFile(path, "utf8"));
          const verified = summariseRetainedResult(
            saved,
            resolve(path, ".."),
            job,
            this.state.implementationHash,
            this.state.baselineHash,
          );
          if (
            verified.resultHash !== result.resultHash ||
            verified.evidenceHash !== result.evidenceHash
          )
            throw new Error("Retained outcome changed after receipt commit");
          const receipt = await readMonitorJson<AttemptReceipt>(
            join(
              this.options.root,
              "attempts",
              hashTracePayload(job.id),
              String(job.latest!.number),
              "receipt.json",
            ),
          );
          if (hashTracePayload(receipt) !== hashTracePayload(job.latest))
            throw new Error("Retained receipt/index mismatch");
          await verifyRetainedEvidence(resolve(path, "..", "evidence"), result.evidenceHash);
          job.evidenceVerifiedAt = this.now().toISOString();
        } catch (error) {
          await this.start(job);
          await this.complete(
            job,
            null,
            `RETAINED_EVIDENCE_CORRUPT:${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
      }
    await this.save();
  }
  async runOne(run: (job: AuditJob, directory: string) => Promise<ResultSummary>) {
    const job = this.nextJob();
    if (!job) return false;
    const directory = await this.start(job);
    try {
      const result = await run(job, directory);
      await this.complete(
        job,
        result,
        null,
        result.unknownReasons.some((s) =>
          /SOURCE_READ_UNAVAILABLE|FUNDING_SOURCE_READ_UNAVAILABLE/.test(s),
        ),
      );
    } catch (error) {
      await this.complete(job, null, error instanceof Error ? error.message : String(error), true);
    }
    return true;
  }
  async markEvidenceVerified(job: AuditJob) {
    job.evidenceVerifiedAt = this.now().toISOString();
    await this.save();
  }
  async recordSeedFailure(tradeId: string, error: string) {
    this.state.seedErrors ??= {};
    this.state.seedErrors[tradeId] = error;
    await this.save();
  }
  report() {
    const now = this.now(),
      jobs = Object.values(this.state.jobs),
      groups = new Map<
        string,
        {
          identity: Record<string, unknown>;
          cohort: string;
          trades: number;
          cases: Record<string, Record<string, number>>;
        }
      >();
    const totals = {
      known: jobs.length,
      sourceTotal: this.state.sourceTotal,
      checked: 0,
      confirmed: 0,
      violations: 0,
      incomplete: 0,
      sourceErrors: 0,
      pending: 0,
      retrying: 0,
      active: 0,
      activeAttempts: 0,
      completePaths: 0,
      expiringUncaptured: 0,
      expiredUncaptured: 0,
    };
    const reasons: Record<string, number> = {},
      findings: Array<{
        tradeId: string;
        positionId: string;
        reasons: string[];
        resultPath: string | null;
        detailsPath: string;
      }> = [];
    for (const j of jobs) {
      const r = j.latest?.result;
      if (r) {
        totals.checked++;
        if (r.status === "confirmed") totals.confirmed++;
        else if (r.status === "violation") totals.violations++;
        else totals.incomplete++;
        if (r.completePath) totals.completePaths++;
        const id = hashTracePayload({ identity: r.identity, cohort: r.cohort });
        let group = groups.get(id);
        if (!group) {
          group = { identity: r.identity, cohort: r.cohort, trades: 0, cases: {} };
          groups.set(id, group);
        }
        group.trades++;
        for (const c of r.cases) {
          group.cases[c.caseId] ??= {};
          group.cases[c.caseId]![c.status] = (group.cases[c.caseId]![c.status] ?? 0) + 1;
        }
        for (const reason of r.unknownReasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
      } else if (j.latest?.error) totals.sourceErrors++;
      if (j.active) {
        totals.activeAttempts++;
        if (!r && !j.latest?.error) totals.active++;
      }
      if (!r && !j.latest?.error && !j.active) totals.pending++;
      if (j.nextAt !== null && j.latest) totals.retrying++;
      if (!r && j.retainUntil && Date.parse(j.retainUntil) <= +now + 24 * 3600000) {
        totals.expiringUncaptured++;
        if (Date.parse(j.retainUntil) <= +now) totals.expiredUncaptured++;
      }
      if (j.latest?.error || r?.failures.length)
        findings.push({
          tradeId: j.id,
          positionId: j.positionId,
          reasons: r?.failures ?? [j.latest!.error!],
          resultPath: r?.resultPath ?? null,
          detailsPath: join("attempts", hashTracePayload(j.id), String(j.latest!.number)),
        });
    }
    const waiting = jobs.filter((j) => j.nextAt !== null || j.active);
    return {
      version: "cryptoanal-audit-monitor-report@1",
      asOf: now.toISOString(),
      workspaceId: this.state.workspaceId,
      baselineHash: this.state.baselineHash,
      implementationHash: this.state.implementationHash,
      source: {
        lastDiscoveryAt: this.state.lastDiscoveryAt,
        lastCompletedScanAt: this.state.lastCompletedScanAt,
        error: this.state.sourceError,
        undiscovered:
          this.state.sourceTotal === null
            ? null
            : Math.max(0, this.state.sourceTotal - jobs.length),
      },
      totals,
      oldestPendingAgeMs: waiting.length
        ? Math.max(...waiting.map((j) => Math.max(0, +now - Date.parse(j.discoveredAt))))
        : 0,
      oldestSourceClosureAgeMs: waiting.length
        ? Math.max(...waiting.map((j) => Math.max(0, +now - Date.parse(j.createdAt))))
        : 0,
      oldestFillAgeMs: waiting.length
        ? Math.max(...waiting.map((j) => Math.max(0, +now - Date.parse(j.closedAt))))
        : 0,
      recentClosures: [...jobs]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 10)
        .map((j) => ({
          tradeId: j.id,
          priceFilledAt: j.closedAt,
          recordCreatedAt: j.createdAt,
          firstDiscoveredAt: j.discoveredAt,
        })),
      seedErrors: Object.entries(this.state.seedErrors ?? {}).map(([tradeId, error]) => ({
        tradeId,
        error,
        resolved: !!this.state.jobs[tradeId]?.latest?.result,
      })),
      unknownReasons: reasons,
      findings,
      groups: [...groups].map(([groupId, v]) => ({
        groupId,
        sourceGroupId: hashTracePayload(v.identity),
        ...v,
      })),
      notes: [
        "Missing evidence stays incomplete; successful accounting does not confirm a full path.",
        "Source inventory and heartbeat are distinct from absence of new closures.",
        "Old generations and attempts are retained; no automatic evidence deletion.",
      ],
    };
  }
  async writeReport() {
    const report = this.report();
    await writeMonitorJson(join(this.options.root, "report.json"), report);
    return report;
  }
}
export function monitorRelativePath(root: string, path: string) {
  const rel = relative(root, path);
  if (rel.startsWith("..") || resolve(root, rel) !== resolve(path))
    throw new Error("Attempt path escapes monitor store");
  return rel;
}
