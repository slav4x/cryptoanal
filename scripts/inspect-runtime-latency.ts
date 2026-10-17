import "dotenv/config";
import { Client } from "pg";
import { writeFile } from "node:fs/promises";
import {
  assessRuntimeLatency,
  runtimeLatencyLimits,
  latencyTailSampleFloor,
} from "./lib/runtime-latency-report";
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
  const limits = runtimeLatencyLimits;
  const fresh = !!heartbeat && Date.now() - +heartbeat.lastSeenAt <= 45000;
  const criteria = (
    samples: Pick<ReturnType<RuntimeLatency["snapshot"]>, "metrics" | "counters">,
  ) => assessRuntimeLatency(samples, fresh, latency?.version ?? 1);
  const data = {
    asOf: new Date().toISOString(),
    worker: heartbeat?.lastSeenAt ?? null,
    fresh,
    latency: latency ?? null,
    queues: heartbeat?.metadata?.queues ?? null,
    taskProgress: heartbeat?.metadata?.taskProgress ?? null,
    tailSampleFloor: latencyTailSampleFloor,
    criteria: latency
      ? criteria(latency)
      : Object.entries(limits).map(([metric, p99LimitMs]) => ({
          metric,
          p99LimitMs,
          samples: 0,
          status: fresh ? "unobserved" : "stale",
        })),
    phases: latency?.phases
      ? Object.fromEntries(
          Object.entries(latency.phases).map(([phase, samples]) => [
            phase,
            { ...samples, criteria: criteria(samples) },
          ]),
        )
      : null,
    rawSourceTimes: await rows(
      `SELECT id::text,"eventKey","observedAt","receivedAt",extract(epoch FROM ("receivedAt"-"observedAt"))*1000 AS "sourceToReceiveMs" FROM (SELECT id,"eventKey","observedAt","receivedAt" FROM "MarketPriceEvent" ORDER BY id DESC LIMIT 256) recent ORDER BY id DESC LIMIT 8`,
    ),
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
      "Five-minute rolling histogram upper bounds; a worker restart clears observations. Missing samples stay unobserved; sparse samples do not establish stable tail latency.",
      "phaseMaxima retain contextual checkpoint maxima until process exit, independently of the rolling window. Stage timings accumulate per work attempt; lane load/queue and receive-to-read overlap and must not be added together.",
      "Counters measure processing attempts except committed fills/terminal decisions; an expired limit signal alone does not prove a missed profitable entry.",
      "Finality-to-fill includes intentional limit waiting; families and order types are separated. Replay and realtime checkpoints are separate.",
      "Negative cross-clock durations remain counted by metric; affected criteria are clock-uncertain. Raw source times are eight records from the latest 256 journal events, not the entire rolling window.",
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
