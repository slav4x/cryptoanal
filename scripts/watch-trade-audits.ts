import "dotenv/config";
import { Client } from "pg";
import { spawn } from "node:child_process";
import { cp, copyFile, mkdir, readFile, open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { hashTracePayload } from "../packages/persistence/src/position-trace";
import { auditJson, auditObject } from "../apps/worker/src/closed-trade-audit";
import { extendAccountAudit } from "../apps/worker/src/retained-trade-audit";
import { researchReadOnlyUrl } from "./lib/research-readonly";
import {
  retainedAuditImplementation,
  readAcceptanceBaseline,
  verifyRetainedEvidence,
} from "./lib/retained-audit-source";
import {
  TradeAuditMonitor,
  writeMonitorJson,
  summariseRetainedResult,
  type Closure,
  type AuditJob,
} from "./lib/trade-audit-monitor";

const args = process.argv.slice(2).filter((s) => s !== "--"),
  once = args.includes("--once");
const onceIndex = args.indexOf("--once");
if (onceIndex >= 0) args.splice(onceIndex, 1);
const seedIndex = args.indexOf("--seed"),
  seed = seedIndex < 0 ? null : args.splice(seedIndex, 2)[1];
const [workspaceId, baselinePath, storePath, ...extra] = args;
if (
  !workspaceId ||
  !baselinePath ||
  !storePath ||
  extra.length ||
  !process.env.DATABASE_URL ||
  (seedIndex >= 0 && !seed)
)
  throw new Error(
    "Usage: runtime:watch-trades <workspace> <N01.json> <store-dir> [--once] [--seed N02.json]",
  );
const store = resolve(storePath),
  baseline = await readAcceptanceBaseline(resolve(baselinePath), workspaceId),
  implementation = await retainedAuditImplementation();
const generation = hashTracePayload({
  baselineHash: baseline.hash,
  implementationHash: implementation.hash,
  monitorVersion: 1,
});
const root = join(store, "generations", generation),
  pinnedBaseline = join(root, "baseline.json"),
  controller = new AbortController(),
  ownerToken = randomUUID();
const client = new Client({
  connectionString: researchReadOnlyUrl(process.env.DATABASE_URL),
  application_name: "trade-audit-monitor",
  statement_timeout: 10000,
  connectionTimeoutMillis: 2000,
});
let ownsLease = false,
  heartbeatBusy = false,
  phase = "starting",
  fatalError: string | null = null,
  child: ReturnType<typeof spawn> | null = null;
let monitor: TradeAuditMonitor | undefined;
const killChild = () => {
  child?.kill("SIGTERM");
};
const stop = () => {
  controller.abort();
  killChild();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
client.on("error", (error) => {
  fatalError = `MONITOR_DB_CONNECTION_LOST:${error.message}`;
  stop();
});
const assertLease = () => {
  controller.signal.throwIfAborted();
  if (!ownsLease) throw new Error("Monitor lease lost");
};
async function heartbeat(error: string | null = null) {
  assertLease();
  await writeMonitorJson(join(store, "heartbeat.json"), {
    version: 1,
    generation,
    root: relative(store, root),
    workspaceId,
    phase,
    error,
    observedAt: new Date().toISOString(),
    pid: process.pid,
    ownerToken,
    sourceLastSuccessAt: monitor?.state.lastDiscoveryAt ?? null,
    activeTradeId: Object.values(monitor?.state.jobs ?? {}).find((j) => j.active)?.id ?? null,
  });
}
async function loadSummary(job: Closure, directory: string) {
  if ((await stat(join(directory, "result.json"))).size > 32 * 1024 * 1024)
    throw new Error("Result byte budget exceeded");
  const saved = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
  const summary = summariseRetainedResult(
    saved,
    directory,
    job,
    implementation.hash,
    baseline.hash,
  );
  await verifyRetainedEvidence(join(directory, "evidence"), summary.evidenceHash);
  return summary;
}
async function processJob(job: AuditJob, directory: string) {
  assertLease();
  phase = "checking";
  await heartbeat();
  const log = await open(join(directory, "process.log"), "wx", 0o600);
  try {
    await new Promise<void>((done, reject) => {
      child = spawn(
        process.execPath,
        [
          "--max-old-space-size=512",
          "--import=tsx",
          resolve("scripts/process-trade-audit.ts"),
          workspaceId!,
          pinnedBaseline,
          directory,
          job.positionId,
        ],
        { stdio: ["ignore", log.fd, log.fd], env: process.env },
      );
      const active = child,
        timer = setTimeout(() => active.kill("SIGTERM"), 300000),
        force = setTimeout(() => active.kill("SIGKILL"), 305000);
      const aborted = () => active.kill("SIGTERM");
      controller.signal.addEventListener("abort", aborted, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(force);
        controller.signal.removeEventListener("abort", aborted);
        child = null;
      };
      active.once("error", (e) => {
        cleanup();
        reject(e);
      });
      active.once("exit", (code, signal) => {
        cleanup();
        if (code === 0) done();
        else reject(new Error(`AUDIT_PROCESS_FAILED:${code ?? signal}`));
      });
    });
  } finally {
    await log.close();
  }
  assertLease();
  return loadSummary(job, directory);
}
async function importSeed(reportPath: string) {
  const path = resolve(reportPath);
  if ((await stat(path)).size > 32 * 1024 * 1024)
    throw new Error("Seed report byte budget exceeded");
  const saved = JSON.parse(await readFile(path, "utf8"));
  if (
    hashTracePayload(saved.payload) !== saved.hash ||
    saved.payload.baselineHash !== baseline.hash ||
    !saved.payload.readOnly ||
    saved.payload.selectedPositionId !== null ||
    Object.values(saved.payload.immutable as Record<string, { unchanged: boolean }>).some(
      (v) => !v.unchanged,
    )
  )
    throw new Error("Seed report identity or integrity mismatch");
  for (const [file, hash] of Object.entries(saved.payload.implementation))
    if (
      createHash("sha256")
        .update(await readFile(resolve(file)))
        .digest("hex") !== hash
    )
      throw new Error("Seed requires its original audit implementation");
  for (const error of saved.payload.errors ?? []) {
    const trade = saved.payload.cohort.find(
      (t: { positionId: string }) => t.positionId === error.positionId,
    );
    await monitor!.recordSeedFailure(trade?.id ?? `position:${error.positionId}`, error.error);
  }
  for (const item of saved.payload.trades) {
    assertLease();
    try {
      const { cohort, resultHash, evidence, ...base } = item;
      if (hashTracePayload(base) !== resultHash) throw new Error("Seed result checksum mismatch");
      const oldRoot = join(`${path}.evidence`, hashTracePayload(item.positionId));
      const original = await verifyRetainedEvidence(oldRoot, evidence.hash);
      const source = original.source;
      if (
        source.trade.id !== item.tradeId ||
        source.position.id !== item.positionId ||
        hashTracePayload(source) !== base.sourceHash
      )
        throw new Error("Seed source binding mismatch");
      const createdAt = auditObject(source.trade).createdAt;
      if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)))
        throw new Error("Original Trade creation timestamp missing");
      const job = await monitor!.addClosure({
        id: item.tradeId,
        positionId: item.positionId,
        createdAt,
        closedAt: source.trade.closedAt,
        retainUntil: source.trace?.retainUntil ?? null,
      });
      if (job.latest?.result) continue;
      const directory = await monitor!.start(job);
      try {
        await cp(oldRoot, join(directory, "evidence"), {
          recursive: true,
          force: false,
          errorOnExist: true,
          mode: constants.COPYFILE_FICLONE,
        });
        const result = extendAccountAudit(base, source);
        const payload = {
          version: "cryptoanal-retained-result@1",
          baselineHash: baseline.hash,
          implementation,
          cohort,
          coverageGroup: baseline.groupsByPosition[item.positionId] ?? result.identity,
          result,
          resultHash: hashTracePayload(auditJson(result)),
          evidence,
          completedAt: new Date().toISOString(),
          seed: { reportHash: saved.hash, resultHash },
        };
        await writeMonitorJson(join(directory, "result.json"), payload, true);
        await monitor!.complete(job, await loadSummary(job, directory), null);
        if (Object.keys(monitor!.state.jobs).length % 20 === 0) await monitor!.writeReport();
      } catch (error) {
        await monitor!.complete(
          job,
          null,
          `SEED_SOURCE_ERROR:${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await monitor!.recordSeedFailure(item.tradeId, message);
      console.error(
        JSON.stringify({ tradeId: item.tradeId, error: message, phase: "seed-source-error" }),
      );
    }
  }
}
let timer: ReturnType<typeof setInterval> | undefined;
try {
  await client.connect();
  const readOnly = await client.query<{ default_transaction_read_only: string }>(
    "SHOW default_transaction_read_only",
  );
  if (readOnly.rows[0]?.default_transaction_read_only !== "on")
    throw new Error("Read-only monitor connection required");
  const lease = await client.query<{ owned: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS owned",
    [`trade-audit-monitor:${workspaceId}`],
  );
  if (!lease.rows[0]?.owned) throw new Error("Another trade audit monitor owns this workspace");
  ownsLease = true;
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await copyFile(resolve(baselinePath), pinnedBaseline, constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  if ((await readAcceptanceBaseline(pinnedBaseline, workspaceId)).hash !== baseline.hash)
    throw new Error("Pinned N01 boundary changed");
  monitor = await TradeAuditMonitor.open({
    workspaceId,
    baselineHash: baseline.hash,
    implementationHash: implementation.hash,
    root,
    budgetRoot: store,
    assertLease,
  });
  await heartbeat();
  await monitor.recover();
  await monitor.verifyLatest();
  await monitor.writeReport();
  timer = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void client
      .query("SELECT 1")
      .then(() => heartbeat())
      .catch((error) => {
        fatalError = `MONITOR_DB_CONNECTION_LOST:${error.message}`;
        stop();
      })
      .finally(() => {
        heartbeatBusy = false;
      });
  }, 10000);
  if (seed) {
    phase = "importing";
    await importSeed(seed);
  }
  do {
    assertLease();
    if (
      !monitor.state.lastDiscoveryAt ||
      Date.now() - Date.parse(monitor.state.lastDiscoveryAt) >= 60000 ||
      monitor.state.cursor
    ) {
      phase = "discovering";
      await heartbeat();
      try {
        await monitor.discover(async (cursor, asOf) => {
          const boundary =
            asOf ??
            (
              await client.query<{ asOf: Date }>('SELECT clock_timestamp() AS "asOf"')
            ).rows[0]!.asOf.toISOString();
          const rows = await client.query<Closure>(
            `SELECT t.id,t."positionId",t."createdAt",t."closedAt",tr."retainUntil" FROM "Trade" t LEFT JOIN "PositionExecutionTrace" tr ON tr."positionId"=t."positionId" WHERE t."workspaceId"=$1 AND t.environment='DRY_RUN' AND t."createdAt"<=$2 AND t."closedAt"<=$2 AND ($3::timestamptz IS NULL OR (t."createdAt",t.id)>($3::timestamptz,$4::text)) ORDER BY t."createdAt",t.id LIMIT 500`,
            [workspaceId, boundary, cursor?.createdAt ?? null, cursor?.id ?? ""],
          );
          const count = await client.query<{ total: number }>(
            `SELECT count(*)::int AS total FROM "Trade" WHERE "workspaceId"=$1 AND environment='DRY_RUN' AND "createdAt"<=$2 AND "closedAt"<=$2`,
            [workspaceId, boundary],
          );
          const normalised = JSON.parse(JSON.stringify(rows.rows)) as Closure[];
          return {
            asOf: boundary,
            total: count.rows[0]!.total,
            rows: normalised,
            done: rows.rows.length < 500,
          };
        });
      } catch (error) {
        await heartbeat(error instanceof Error ? error.message : String(error));
      }
    }
    phase = "checking";
    let processed = false;
    processed = await monitor.runOne(processJob);
    if (!processed) {
      const due = Object.values(monitor.state.jobs)
        .filter(
          (j) =>
            j.latest?.result &&
            !j.active &&
            (!j.evidenceVerifiedAt || Date.now() - Date.parse(j.evidenceVerifiedAt) > 24 * 3600000),
        )
        .sort((a, b) => (a.evidenceVerifiedAt ?? "").localeCompare(b.evidenceVerifiedAt ?? ""))[0];
      if (due) {
        phase = "verifying-storage";
        try {
          const verified = await loadSummary(
            due,
            resolve(root, due.latest!.result!.resultPath, ".."),
          );
          if (
            verified.resultHash !== due.latest!.result!.resultHash ||
            verified.evidenceHash !== due.latest!.result!.evidenceHash
          )
            throw new Error("Retained outcome changed after receipt commit");
          await monitor.markEvidenceVerified(due);
        } catch (e) {
          await monitor.start(due);
          await monitor.complete(
            due,
            null,
            `RETAINED_EVIDENCE_CORRUPT:${e instanceof Error ? e.message : String(e)}`,
            true,
          );
        }
      }
    }
    const report = await monitor.writeReport();
    phase = monitor.state.sourceError ? "source-unavailable" : processed ? "running" : "idle";
    await heartbeat(monitor.state.sourceError);
    console.log(
      JSON.stringify({
        asOf: report.asOf,
        phase,
        totals: report.totals,
        oldestPendingAgeMs: report.oldestPendingAgeMs,
      }),
    );
    if (once) break;
    await delay(processed || monitor.state.cursor ? 10 : 15000, undefined, {
      signal: controller.signal,
    });
  } while (!controller.signal.aborted);
} catch (error) {
  if (!controller.signal.aborted) {
    process.exitCode = 1;
    phase = "failed";
    fatalError = error instanceof Error ? error.message : String(error);
    if (ownsLease)
      await heartbeat(error instanceof Error ? error.message : String(error)).catch(() => {});
    console.error(error);
  }
} finally {
  if (timer) clearInterval(timer);
  killChild();
  if (ownsLease && !controller.signal.aborted) {
    if (phase !== "failed") phase = "stopped";
    await heartbeat(fatalError).catch(() => {});
  } else if (ownsLease) {
    const previous = await readFile(join(store, "heartbeat.json"), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    if (previous?.payload?.ownerToken === ownerToken)
      await writeMonitorJson(join(store, "heartbeat.json"), {
        version: 1,
        generation,
        root: relative(store, root),
        workspaceId,
        phase: fatalError ? "failed" : "stopped",
        error: fatalError,
        observedAt: new Date().toISOString(),
        pid: process.pid,
        ownerToken,
      }).catch(() => {});
  }

  ownsLease = false;
  await client.end().catch(() => {});
}
