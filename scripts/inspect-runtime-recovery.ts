import "dotenv/config";
import { Client } from "pg";
import { writeFile } from "node:fs/promises";
const output = process.argv.slice(2).filter((a) => a !== "--")[0];
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = new Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '60s'");
  const rows = async (sql: string) => (await client.query(sql)).rows;
  const data = {
    asOf: new Date().toISOString(),
    exits: await rows(
      `SELECT "exitReason",count(*)::int AS count,sum("netPnl")::text AS "netPnl" FROM "Trade" GROUP BY 1 ORDER BY 2 DESC`,
    ),
    recoveryClosures: await rows(
      `SELECT coalesce(d.factors->'recovery'->>'source','legacy-unknown') AS source,coalesce(d.factors->'recovery'->>'ambiguity','legacy-unknown') AS ambiguity,count(*)::int AS count FROM "Trade" t LEFT JOIN "Decision" d ON d."tradeId"=t.id AND d.action='CLOSE' WHERE t."exitReason"='recovery-exit' GROUP BY 1,2 ORDER BY 3 DESC`,
    ),
    recoveries: await rows(
      `SELECT coalesce(metadata->'recovery'->>'streamCause','legacy-unknown') AS cause,metadata->'recovery'->>'source' AS source,metadata->'recovery'->>'quality' AS quality,metadata->'recovery'->>'ambiguity' AS ambiguity,metadata->'recovery'->>'sourceFailure' AS "sourceFailure",count(*)::int AS count FROM "AuditEvent" WHERE action='position.recover' GROUP BY 1,2,3,4,5 ORDER BY 6 DESC`,
    ),
    streams24h: await rows(
      `SELECT cause,count(*)::int AS connections,count(*) FILTER(WHERE "firstEventId" IS NOT NULL)::int AS "withTrades",count(*) FILTER(WHERE "endedAt" IS NOT NULL)::int AS ended,max(greatest(0,extract(epoch FROM "startedAt"-"interruptedAt")))::float8 AS "maxReconnectSeconds" FROM "MarketStreamSegment" WHERE "startedAt">now()-interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`,
    ),
    segments: await rows(
      `SELECT id,"previousStreamId",cause,"startedAt","interruptedAt","endedAt","disconnectCode","disconnectReason","firstEventId"::text,"lastEventId"::text,"firstObservedAt","lastObservedAt" FROM "MarketStreamSegment" ORDER BY "startedAt" DESC LIMIT 100`,
    ),
    positions: await rows(
      `SELECT coalesce("recoveryModel",'legacy-ohlc-v1') AS model,count(*)::int AS positions FROM "Position" WHERE status='OPEN' GROUP BY 1`,
    ),
    cursors: await rows(
      `SELECT "lastFailureCode",count(*)::int AS count,max("consecutiveFailures") AS consecutive FROM "RuntimeCursor" GROUP BY 1`,
    ),
    notes: [
      "Recovery observations are counted per position and are not connection counts.",
      "Missing legacy causes stay unknown; elapsed time does not prove missed trades.",
      "Recent public trades prove bounded price observations only; missing boundaries and ambiguous timestamps are not exact history or L1 fills.",
      "PnL sums refer to independent virtual accounts, not a portfolio return.",
    ],
  };
  await client.query("COMMIT");
  const json = JSON.stringify(data, null, 2) + "\n";
  if (output) await writeFile(output, json, { mode: 0o600 });
  process.stdout.write(json);
} finally {
  await client.end();
}
