import "dotenv/config";
import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashTracePayload } from "../packages/persistence/src/position-trace";
import { compareExecutionDecimals } from "../packages/application/src/execution-instrument";
import {
  tradeAcceptanceCases,
  tradeAcceptanceContract,
  assessTradeAcceptance,
  classifyAcceptanceCohort,
  type AcceptanceBoundary,
  type TradeAcceptanceCase,
} from "../packages/application/src/trade-acceptance";
import { researchReadOnlyUrl } from "./lib/research-readonly";

type InventoryPosition = {
  id: string;
  executionRunId: string;
  strategyVersionId: string;
  configHash: string;
  symbol: string;
  side: "BUY" | "SELL";
  timeframe: string;
  openedAt: string;
  createdAt: string;
  status: string;
  tradeId: string | null;
  exitReason: string | null;
  policyFingerprint: string;
  modelFingerprint: string;
  entryOrderType: string | null;
  entryFilledQuantity: string | null;
  entryCancelledQuantity: string | null;
  exitFillCount: number;
  hasRecoveryRecords: boolean;
  hasTrailingPrice: boolean;
};
type SourceSnapshot = {
  asOf: string;
  workspaceId: string;
  visibility: string;
  readOnly: string;
  runs: Array<
    Record<string, unknown> & {
      id: string;
      strategyVersionId: string;
      configHash: string;
      policyFingerprint: string;
    }
  >;
  trades: Array<Record<string, unknown> & { id: string }>;
  positions: InventoryPosition[];
  [key: string]: unknown;
};
function inventoryCases(p: InventoryPosition) {
  const cases: TradeAcceptanceCase[] = [];
  if (p.entryOrderType === "MARKET") cases.push("market-entry");
  if (p.entryOrderType === "LIMIT") cases.push("limit-entry");
  if (p.entryFilledQuantity !== null && p.entryCancelledQuantity !== null) {
    try {
      if (compareExecutionDecimals(p.entryFilledQuantity, "0") > 0)
        cases.push(
          compareExecutionDecimals(p.entryCancelledQuantity, "0") > 0
            ? "partial-entry"
            : "full-entry",
        );
    } catch {
      /* Invalid source amounts stay unclassified; N02 verifies receipts. */
    }
  }
  if (p.tradeId) cases.push("settlement");
  if (p.exitReason === "stop-loss") cases.push("stop-loss");
  if (p.exitReason === "take-profit") cases.push("take-profit");
  if (p.exitReason === "trailing-stop" || p.hasTrailingPrice) cases.push("trailing");
  if (p.exitReason === "signal-exit") cases.push("signal-exit");
  if (p.exitReason === "holding-timeout") cases.push("holding-timeout");
  if (p.exitFillCount > 1) cases.push("partial-exit");
  if (p.exitReason === "recovery-exit" || p.hasRecoveryRecords) cases.push("recovery");
  return cases;
}
function derive(source: SourceSnapshot) {
  const boundary: AcceptanceBoundary = {
    asOf: source.asOf,
    knownTradeIds: source.trades.map((t) => t.id).sort(),
    knownPositionIds: source.positions.map((p) => p.id).sort(),
    runs: source.runs.map((r) => ({
      executionRunId: r.id,
      strategyVersionId: r.strategyVersionId,
      configHash: r.configHash,
      policyFingerprint: r.policyFingerprint,
    })),
  };
  const groups = new Map<
    string,
    {
      identity: Record<string, string>;
      positionIds: string[];
      closed: number;
      candidates: Record<string, number>;
    }
  >();
  const cohorts: Record<string, number> = {};
  for (const p of source.positions) {
    const cohort = classifyAcceptanceCohort(boundary, p);
    cohorts[cohort] = (cohorts[cohort] ?? 0) + 1;
    const identity = Object.fromEntries(
      tradeAcceptanceContract.coverageGroups.map((key) => [key, p[key]]),
    );
    const key = hashTracePayload(identity);
    const group = groups.get(key) ?? { identity, positionIds: [], closed: 0, candidates: {} };
    group.positionIds.push(p.id);
    if (p.tradeId) group.closed++;
    for (const id of inventoryCases(p)) group.candidates[id] = (group.candidates[id] ?? 0) + 1;
    groups.set(key, group);
  }
  return {
    boundary,
    cohorts,
    groups: [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([groupId, group]) => ({
        groupId,
        ...group,
        cases: tradeAcceptanceCases.map((c) => ({
          ...assessTradeAcceptance(c.id, {
            applicability: "unknown",
            applicabilityEvidence: [],
            checks: [],
            sources: [],
          }),
          candidatePositions: group.candidates[c.id] ?? 0,
          expectedMinimumIfApplicable:
            tradeAcceptanceContract.minimumConfirmedPerApplicableGroupAndSide,
          confirmed: 0,
        })),
      })),
    inventoryMatrix: tradeAcceptanceCases.flatMap((c) =>
      (["BUY", "SELL"] as const).map((side) => ({
        caseId: c.id,
        side,
        candidatePositions: source.positions.filter(
          (p) => p.side === side && inventoryCases(p).includes(c.id),
        ).length,
        confirmed: 0,
        status: "insufficient-data",
      })),
    ),
  };
}

const args = process.argv.slice(2).filter((a) => a !== "--");
if (args[0] === "--verify" && args.length === 2) {
  const report = JSON.parse(await readFile(resolve(args[1]!), "utf8")) as {
    payload: {
      contract: unknown;
      contractHash: string;
      source: SourceSnapshot;
      sourceHash: string;
      derived: ReturnType<typeof derive>;
    };
    hash: string;
  };
  const p = report.payload;
  if (
    hashTracePayload(p) !== report.hash ||
    hashTracePayload(p.contract) !== p.contractHash ||
    hashTracePayload(tradeAcceptanceContract) !== p.contractHash ||
    hashTracePayload(p.source) !== p.sourceHash ||
    hashTracePayload(derive(p.source)) !== hashTracePayload(p.derived)
  )
    throw new Error("Acceptance snapshot checksum, contract or classification mismatch");
  console.log(
    JSON.stringify({
      verified: true,
      hash: report.hash,
      sourceHash: p.sourceHash,
      groups: p.derived.groups.length,
    }),
  );
} else {
  const [workspaceId, destination] = args;
  if (args.length !== 2 || !workspaceId || !destination || !process.env.DATABASE_URL)
    throw new Error(
      "Usage: pnpm runtime:acceptance-snapshot <workspace-id> <new-report.json> | --verify <report.json>",
    );
  const output = resolve(destination);
  try {
    await stat(output);
    throw new Error("Acceptance output already exists; use a new path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = [
    "scripts/capture-trade-acceptance.ts",
    "scripts/lib/research-readonly.ts",
    "packages/application/src/trade-acceptance.ts",
    "packages/persistence/src/position-trace.ts",
  ];
  const implementation = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(root, file)))
          .digest("hex"),
      ]),
    ),
  );
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const client = new Client({
    connectionString: researchReadOnlyUrl(process.env.DATABASE_URL),
    application_name: "trade-acceptance-snapshot",
  });
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='20s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
    const readOnly = (await client.query("SHOW transaction_read_only")).rows[0]
      ?.transaction_read_only as string;
    if (readOnly !== "on") throw new Error("Read-only PostgreSQL transaction is required");
    const stamp = (
      await client.query(
        'SELECT transaction_timestamp() AS "asOf",pg_current_snapshot()::text AS visibility',
      )
    ).rows[0]!;
    const rows = async (sql: string) => (await client.query(sql, [workspaceId])).rows;
    if (!(await rows('SELECT id FROM "Workspace" WHERE id=$1')).length)
      throw new Error("Workspace not found");
    const source = {
      asOf: stamp.asOf,
      workspaceId,
      visibility: stamp.visibility,
      readOnly,
      scope: "DRY_RUN inventory; metadata coverage is not trade acceptance",
      deployments: await rows(
        'SELECT id,"strategyId","strategyVersionId",environment,status,"exchangeAccountId","createdAt","updatedAt" FROM "Deployment" WHERE "workspaceId"=$1 ORDER BY id',
      ),
      strategies: await rows(
        'SELECT s.id,s.name,s.status,s."activeVersionId",v.version,v.config,v."configHash",v."createdAt" FROM "Strategy" s LEFT JOIN "StrategyVersion" v ON v.id=s."activeVersionId" WHERE s."workspaceId"=$1 ORDER BY s.id',
      ),
      runs: await rows(`SELECT r.id,r."deploymentId",r."strategyVersionId",r."configHash",r."contextHash",r."engineVersion",r.status,r."startedAt",r."stoppedAt",r."executionPolicy",r.context->'profitProtectionPolicy' AS "legacyProfitProtectionPolicy",
        md5(r.context::text) AS "contextContentMd5",md5(coalesce(r."executionPolicy"::text,'null')) AS "policyFingerprint"
        FROM "ExecutionRun" r WHERE r."workspaceId"=$1 AND r.environment='DRY_RUN' ORDER BY r.id`),
      positions:
        await rows(`SELECT p.id,p."executionRunId",p."strategyVersionId",p.symbol,p.side,p.status,p."openedAt",p."createdAt",p."closedAt",p.quantity,p."remainingQuantity",p."entryPrice",p."stopPrice",p."takePrice",p."trailingPrice",p."managedThroughAt",p."priceEventId",p."priceStreamId",p."runtimeVersion",p."recoveryModel",p."positionExitPolicy",p."profitProtection",p."instrumentRules",p."exitPolicy",p."fundingPolicy",p."executionPolicy",p."entryExecution",p."exitState",
        v."configHash",v.config,v.config->'universe'->>'timeframe' AS timeframe,t.id AS "tradeId",t."exitReason",o.type AS "entryOrderType",o.id AS "entryOrderId",o.execution->'terminal'->>'filledQuantity' AS "entryFilledQuantity",o.execution->'terminal'->>'cancelledQuantity' AS "entryCancelledQuantity",
        p."trailingPrice" IS NOT NULL AS "hasTrailingPrice",md5(coalesce(p."executionPolicy"::text,'null')) AS "policyFingerprint",md5(to_jsonb(p)::text) AS "rowContentMd5",
        md5(jsonb_build_object('runEngine',er."engineVersion",'traceEngine',(SELECT tr.snapshot->>'executionEngineVersion' FROM "PositionExecutionTrace" tr WHERE tr."positionId"=p.id),'positionExit',p."positionExitPolicy",'recovery',p."recoveryModel",'exit',p."exitPolicy",'funding',p."fundingPolicy",'instrumentRules',p."instrumentRules"-'observedAt','profitProtectionPolicyKey',p."profitProtection"->'policyKey')::text) AS "modelFingerprint",
        (SELECT count(*)::int FROM "Fill" f JOIN "Order" x ON x.id=f."orderId" WHERE x."positionId"=p.id AND x.side<>p.side) AS "exitFillCount",
        EXISTS(SELECT 1 FROM "PositionTraceRecord" r WHERE r."positionId"=p.id AND r.payload->'inputs'->'recoveries' IS NOT NULL AND r.payload->'inputs'->'recoveries'<>'[]'::jsonb AND r.payload->'inputs'->'recoveries'<>'null'::jsonb) AS "hasRecoveryRecords"
        FROM "Position" p JOIN "StrategyVersion" v ON v.id=p."strategyVersionId" JOIN "ExecutionRun" er ON er.id=p."executionRunId" LEFT JOIN "Trade" t ON t."positionId"=p.id
        LEFT JOIN LATERAL (SELECT x.id,x.type,x.execution FROM "Order" x WHERE x."positionId"=p.id AND x.side=p.side ORDER BY x."createdAt",x.id LIMIT 1) o ON true
        WHERE p."workspaceId"=$1 AND p.environment='DRY_RUN' ORDER BY p.id`),
      trades: await rows(
        'SELECT t.*,md5(to_jsonb(t)::text) AS "rowContentMd5" FROM "Trade" t WHERE t."workspaceId"=$1 AND t.environment=\'DRY_RUN\' ORDER BY t.id',
      ),
      validations: await rows(
        'SELECT v.id,v."strategyVersionId",v."configHash",v."datasetSnapshotId",v."engineVersion",v.status,v.verdict,v."completedAt",md5(to_jsonb(v)::text) AS "rowContentMd5" FROM "ValidationRun" v WHERE v."workspaceId"=$1 AND v.status=\'COMPLETED\' ORDER BY v.id',
      ),
      baselines: await rows(
        'SELECT b.*,v.status,v.verdict,v."engineVersion",v."configHash",v."datasetSnapshotId",v.metrics,v."executionPolicy" FROM "ExecutionPolicyBaseline" b JOIN "ExecutionRun" r ON r.id=b."executionRunId" JOIN "ValidationRun" v ON v.id=b."validationRunId" WHERE r."workspaceId"=$1 AND r.environment=\'DRY_RUN\' ORDER BY b."executionRunId"',
      ),
      traces: await rows(
        'SELECT "positionId",symbol,"startEventId","endEventId","eventCount","fullFromEntry","snapshotHash","policyHash","startedAt","closedAt","retainUntil",snapshot->>\'executionEngineVersion\' AS "engineVersion" FROM "PositionExecutionTrace" WHERE "workspaceId"=$1 ORDER BY "positionId"',
      ),
      traceRecords: await rows(
        'SELECT r."positionId",r.kind,count(*)::int AS records,min(r.id)::text AS "firstId",max(r.id)::text AS "lastId",md5(string_agg(r."payloadHash",\'\' ORDER BY r.id)) AS "payloadHashesMd5" FROM "PositionTraceRecord" r JOIN "PositionExecutionTrace" t ON t."positionId"=r."positionId" WHERE t."workspaceId"=$1 GROUP BY 1,2 ORDER BY 1,2',
      ),
      cursors: await rows(
        'SELECT "executionRunId",symbol,"lastEvaluatedAt","pendingPriceEventId","pendingSignal","consecutiveFailures","lastFailureCode","updatedAt" FROM "RuntimeCursor" WHERE "workspaceId"=$1 ORDER BY "executionRunId",symbol',
      ),
      incidents: await rows(
        'SELECT id,domain,code,severity,status,"resourceType","resourceId","firstObservedAt","lastObservedAt","occurrenceCount" FROM "WatchdogIncident" WHERE "workspaceId"=$1 AND status<>\'RESOLVED\' ORDER BY id',
      ),
      fundingMarkets: await rows(
        'SELECT f.symbol,f."observedAt",f."nextFundingAt",f."snapshotId",f."checkedFrom",f."checkedThrough" FROM "FundingMarketState" f WHERE EXISTS(SELECT 1 FROM "WorkspaceMarket" m WHERE m."workspaceId"=$1 AND m.symbol=f.symbol) ORDER BY f.symbol',
      ),
      archives: await rows(
        'SELECT a.symbol,count(*)::int AS chunks,min(a."firstEventId")::text AS "firstEventId",max(a."lastEventId")::text AS "lastEventId",min(a."startsAt") AS "startsAt",max(a."endsAt") AS "endsAt",sum(a."eventCount")::text AS events,sum(octet_length(a.payload))::text AS bytes,md5(string_agg(a.sha256,\'\' ORDER BY a."firstEventId")) AS "chunkHashesMd5" FROM "MarketPriceArchiveChunk" a WHERE EXISTS(SELECT 1 FROM "WorkspaceMarket" m WHERE m."workspaceId"=$1 AND m.symbol=a.symbol) GROUP BY a.symbol ORDER BY a.symbol',
      ),
      hotJournal: await rows(
        'SELECT m.symbol,(SELECT min(e.id)::text FROM "MarketPriceEvent" e WHERE e.symbol=m.symbol) AS "firstId",e.id::text AS "lastId",e."observedAt" AS "latestObservedAt",e."receivedAt" AS "latestReceivedAt",e."streamId" AS "latestStreamId" FROM "WorkspaceMarket" m LEFT JOIN LATERAL (SELECT id,"observedAt","receivedAt","streamId" FROM "MarketPriceEvent" e WHERE e.symbol=m.symbol ORDER BY id DESC LIMIT 1) e ON true WHERE m."workspaceId"=$1 ORDER BY m.symbol',
      ),
      heartbeats: (
        await client.query(
          `SELECT DISTINCT ON(service) service,version,"lastSeenAt",metadata->>'executionEngineVersion' AS execution,metadata->>'validationEngineVersion' AS validation,metadata->'latency' AS latency,metadata->'queues' AS queues FROM "WorkerHeartbeat" ORDER BY service,"lastSeenAt" DESC`,
        )
      ).rows,
      migrations: (
        await client.query(
          'SELECT migration_name,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
        )
      ).rows,
    };
    await client.query("COMMIT");
    const normalized = JSON.parse(JSON.stringify(source)) as SourceSnapshot;
    const payload = {
      revision,
      implementation,
      contract: tradeAcceptanceContract,
      contractHash: hashTracePayload(tradeAcceptanceContract),
      source: normalized,
      sourceHash: hashTracePayload(normalized),
      derived: derive(normalized),
      limitations: [
        "Inventory candidates have not been replayed by N02; all acceptance cells remain insufficient-data.",
        "Trace fullFromEntry is metadata, not proof of a complete verified path.",
        "Archive/journal bounds do not prove continuous coverage; archived payloads are not included in this export.",
        "Policy fingerprints in grouping use PostgreSQL JSON text MD5; the export and source manifest have separate SHA256 hashes.",
        "A later live capture is a new cohort; verify reclassifies this captured source without querying the database.",
      ],
    };
    const hash = hashTracePayload(payload);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ payload, hash }, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        output,
        hash,
        asOf: normalized.asOf,
        positions: normalized.positions.length,
        trades: normalized.trades.length,
        groups: payload.derived.groups.length,
        acceptance: "not-yet-checked",
      }),
    );
  } finally {
    await client.end();
  }
}
