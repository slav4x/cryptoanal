import "dotenv/config";
import { Client } from "pg";
import { writeFile } from "node:fs/promises";
import type { RuntimeLatency } from "../apps/worker/src/runtime-latency";

const output = process.argv.slice(2).filter((a) => a !== "--")[0];
const client = new Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout='10s'");
  const rows = async (sql: string) => (await client.query(sql)).rows;
  const [heartbeat] = await rows(
    `SELECT "lastSeenAt",metadata FROM "WorkerHeartbeat" WHERE service='worker' ORDER BY "lastSeenAt" DESC LIMIT 1`,
  );
  const latency = heartbeat?.metadata?.latency as
    ReturnType<RuntimeLatency["snapshot"]> | undefined;
  const limits = {
    "market.deliveryMs": 1000,
    "journal.eventToCommitMs": 500,
    "position.realtime.eventToCheckpointMs": 2000,
    "position.recovery.eventToCheckpointMs": 5000,
    "protection.eventToCheckpointMs": 1000,
    "entry.quoteToFillMs": 1000,
  };
  const fresh = !!heartbeat && Date.now() - +heartbeat.lastSeenAt <= 45000;
  const data = {
    asOf: new Date().toISOString(),
    worker: heartbeat?.lastSeenAt ?? null,
    fresh,
    latency: latency ?? null,
    queues: heartbeat?.metadata?.queues ?? null,
    criteria: Object.entries(limits).map(([metric, p99LimitMs]) => {
      const sample = latency?.metrics[metric];
      return {
        metric,
        p99LimitMs,
        samples: sample?.count ?? 0,
        status: !fresh
          ? "stale"
          : !sample
            ? "unobserved"
            : sample.p99Ms <= p99LimitMs
              ? "passed"
              : "exceeded",
      };
    }),
    pending: await rows(
      `SELECT "executionRunId",symbol,"pendingSignal"->>'availableAt' AS "availableAt","pendingSignal"->>'expiresAt' AS "expiresAt" FROM "RuntimeCursor" WHERE "pendingSignal" IS NOT NULL`,
    ),
    decisions24h: await rows(
      `SELECT "reasonCode",count(*)::int FROM "Decision" WHERE "decidedAt">now()-interval '24 hours' AND ("reasonCode" LIKE '%EXPIRED%' OR "reasonCode" LIKE '%STALE%' OR "reasonCode" LIKE '%UNAVAILABLE%') GROUP BY 1 ORDER BY 2 DESC`,
    ),
    database: await rows(
      `SELECT application_name,state,wait_event_type,count(*)::int FROM pg_stat_activity WHERE application_name LIKE 'cryptoanal-%' GROUP BY 1,2,3 ORDER BY 1,2`,
    ),
    notes: [
      "Five-minute rolling histogram upper bounds; a worker restart clears observations. Missing samples stay unobserved.",
      "Counters measure processing attempts except committed fills/terminal decisions; an expired limit signal alone does not prove a missed profitable entry.",
      "Finality-to-fill includes intentional limit waiting; families and order types are separated. Replay and realtime checkpoints are separate.",
      "These operational targets are for this DRY_RUN worker and do not establish Demo/Live fill latency or exchange execution readiness.",
    ],
  };
  await client.query("COMMIT");
  const json = JSON.stringify(data, null, 2) + "\n";
  if (output) await writeFile(output, json, { mode: 0o600 });
  process.stdout.write(json);
} finally {
  await client.end();
}
