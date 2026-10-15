import "dotenv/config";
import { Client } from "pg";
import { writeFile } from "node:fs/promises";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  updateExecutionTrailingAtPrice,
  type ExecutionPosition,
} from "../packages/application/src/execution-engine";
import {
  applyExecutionProfitProtection,
  readExecutionProfitProtectionState,
} from "../packages/application/src/execution-profit-protection";
import {
  readExecutionInstrumentRules,
  executionInstrumentSizeFailure,
} from "../packages/application/src/execution-instrument";
import { readEntryExecutionMarker } from "../packages/application/src/execution-entry-liquidity";
import { verifyEntryExecutionProof } from "../packages/persistence/src/entry-execution-proof";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = new Client({ connectionString: process.env.DATABASE_URL });
const output = process.argv.slice(2).filter((argument) => argument !== "--")[0];
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '60s'");
  const one = async (sql: string) => (await client.query(sql)).rows[0];
  const rows = async (sql: string) => (await client.query(sql)).rows;
  const openProtection = { checked: 0, invalidOpenProtection: 0, protectionMismatch: 0 };
  const instrumentCompliance = {
    checked: 0,
    legacyOpenPositions: 0,
    invalidInstrumentPositions: 0,
  };
  for (const stored of await rows(`SELECT p.*,v.config FROM "Position" p
    JOIN "StrategyVersion" v ON v.id=p."strategyVersionId" WHERE p.status='OPEN' AND p.environment='DRY_RUN'`)) {
    openProtection.checked++;
    try {
      const config = strategyConfigSchema.parse(stored.config);
      const position: ExecutionPosition = {
        ...(stored.entryExecution
          ? { entryExecution: readEntryExecutionMarker(stored.entryExecution)! }
          : {}),
        ...(stored.instrumentRules
          ? { instrumentRules: readExecutionInstrumentRules(stored.instrumentRules)! }
          : {}),
        symbol: stored.symbol,
        side: stored.side === "BUY" ? "long" : "short",
        openedAt: stored.openedAt,
        entryPrice: Number(stored.entryPrice),
        quantity: Number(stored.quantity),
        stopPrice: Number(stored.stopPrice),
        takePrice: Number(stored.takePrice),
        trailingPrice: stored.trailingPrice === null ? null : Number(stored.trailingPrice),
        bestPrice: Number(stored.bestPrice),
        entryFee: Number(stored.entryFee),
        entrySlippage: Number(stored.entrySlippage),
        entryRegime: "unknown",
        entrySession: "unknown",
      };
      if (position.instrumentRules) {
        instrumentCompliance.checked++;
        if (
          executionInstrumentSizeFailure(
            position,
            position.instrumentRules,
            !!position.entryExecution,
          )
        )
          instrumentCompliance.invalidInstrumentPositions++;
      } else instrumentCompliance.legacyOpenPositions++;
      const quote = {
        symbol: position.symbol,
        price: Number(stored.markPrice ?? stored.entryPrice),
        observedAt: stored.managedThroughAt ?? stored.openedAt,
      };
      let expected = updateExecutionTrailingAtPrice(position, quote.price, config);
      const state = readExecutionProfitProtectionState(stored.profitProtection);
      if (state) {
        const [enabledAt, breakEvenActivationR, trailingActivationR, trailingDistanceR] =
          JSON.parse(state.policyKey);
        expected = applyExecutionProfitProtection(
          expected,
          quote,
          config,
          {
            enabledAt,
            breakEvenActivationR,
            trailingActivationR,
            trailingDistanceR,
          },
          state,
        ).position;
      }
      const tolerance = Math.max(1e-10, position.entryPrice * 1e-12);
      if (
        Math.abs(expected.stopPrice - position.stopPrice) > tolerance ||
        (expected.trailingPrice === null) !== (position.trailingPrice === null) ||
        (expected.trailingPrice !== null &&
          position.trailingPrice !== null &&
          Math.abs(expected.trailingPrice - position.trailingPrice) > tolerance)
      )
        openProtection.protectionMismatch++;
    } catch {
      openProtection.invalidOpenProtection++;
    }
  }
  const entryExecution = {
    checked: 0,
    open: 0,
    full: 0,
    partial: 0,
    cancelled: 0,
    invalidEntryReceipts: 0,
  };
  for (const order of await rows(`SELECT o.*,v.config,coalesce(x.fills,'[]'::json) AS fills FROM "Order" o
    JOIN "ExecutionRun" r ON r.id=o."executionRunId" JOIN "StrategyVersion" v ON v.id=r."strategyVersionId"
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('quantity',f.quantity::text,'price',f.price::text,'fee',f.fee::text,
      'filledAt',f."filledAt",'execution',f.execution) ORDER BY f."filledAt") AS fills FROM "Fill" f WHERE f."orderId"=o.id) x ON true
    WHERE o.execution IS NOT NULL`)) {
    if (order.status === "OPEN") {
      entryExecution.open++;
      continue;
    }
    entryExecution.checked++;
    try {
      const proof = verifyEntryExecutionProof(order, strategyConfigSchema.parse(order.config));
      entryExecution[proof.outcome]++;
    } catch {
      entryExecution.invalidEntryReceipts++;
    }
  }
  const sourceUse = await one(`SELECT count(*)::int AS "invalidEntryLiquidityReuse" FROM (
    SELECT d."exchangeAccountId", f.execution->'payload'->>'sourceKey',sum(f.quantity) AS consumed,
      max((f.execution->'payload'->>'sourceCapacity')::numeric) AS capacity
    FROM "Fill" f JOIN "Order" o ON o.id=f."orderId" JOIN "ExecutionRun" r ON r.id=o."executionRunId"
    JOIN "Deployment" d ON d.id=r."deploymentId" WHERE f.execution IS NOT NULL
    GROUP BY d."exchangeAccountId",f."workspaceId",f.execution->'payload'->>'sourceKey'
    HAVING sum(f.quantity)>max((f.execution->'payload'->>'sourceCapacity')::numeric)) x`);
  const summary = {
    entryExecution: { ...entryExecution, ...sourceUse },
    instrumentCompliance,
    openProtection,
    snapshot: await one('SELECT now() AS "observedAt", current_database() AS database'),
    deployments: await rows(
      'SELECT environment, status, count(*)::int AS count FROM "Deployment" GROUP BY 1,2 ORDER BY 1,2',
    ),
    positions: await rows(
      'SELECT status, count(*)::int AS count FROM "Position" GROUP BY 1 ORDER BY 1',
    ),
    trades:
      await one(`SELECT count(*)::int AS count, min("openedAt") AS "firstEntryAt", max("closedAt") AS "lastExitAt",
      count(*) FILTER (WHERE "netPnl" > 0)::int AS wins,
      count(*) FILTER (WHERE "netPnl" < 0)::int AS losses,
      sum("netPnl")::text AS "sumAcrossVirtualAccounts" FROM "Trade"`),
    virtualAccounts: await rows(`SELECT d."exchangeAccountId",d.environment,
      count(t.id)::int AS trades,coalesce(sum(t."netPnl"),0)::text AS "netPnl"
      FROM "Deployment" d LEFT JOIN "ExecutionRun" r ON r."deploymentId"=d.id
      LEFT JOIN "Trade" t ON t."executionRunId"=r.id GROUP BY 1,2 ORDER BY 1,2`),
    virtualStrategies: await rows(`SELECT d."exchangeAccountId",t."strategyVersionId",
      count(*)::int AS trades,count(*) FILTER(WHERE t."netPnl">0)::int AS wins,
      sum(t."netPnl")::text AS "netPnl" FROM "Trade" t
      JOIN "ExecutionRun" r ON r.id=t."executionRunId"
      JOIN "Deployment" d ON d.id=r."deploymentId" GROUP BY 1,2 ORDER BY 1,2`),
    traceCoverage: await one(`SELECT count(*) FILTER(WHERE t."fullFromEntry")::int AS "fromEntry",
      count(*) FILTER(WHERE NOT t."fullFromEntry")::int AS "fromCheckpoint",
      count(*) FILTER(WHERE t."retainUntil"<=now())::int AS expired,
      (SELECT count(*) FROM "Position" p WHERE p.status='OPEN' AND p.environment='DRY_RUN'
        AND NOT EXISTS(SELECT 1 FROM "PositionExecutionTrace" x WHERE x."positionId"=p.id))::int AS "openWithoutTrace"
      FROM "PositionExecutionTrace" t`),
    exits: await rows(
      'SELECT "exitReason", count(*)::int AS count, sum("netPnl")::text AS "netPnl" FROM "Trade" GROUP BY 1 ORDER BY 2 DESC',
    ),
    ledger: await one(`SELECT
      count(*) FILTER (WHERE abs(t."netPnl"-(t."grossPnl"-t.fees-t.funding)) > 0.00000002)::int AS "netPnlMismatch",
      count(*) FILTER (WHERE abs(t."grossPnl"-(t."averageExitPrice"-t."averageEntryPrice")*t.quantity*CASE WHEN t.side='BUY' THEN 1 ELSE -1 END) > t.quantity*0.000000005+0.00000002)::int AS "grossPnlBeyondLegacyRounding",
      count(*) FILTER (WHERE abs(t."grossPnl"-(t."averageExitPrice"-t."averageEntryPrice")*t.quantity*CASE WHEN t.side='BUY' THEN 1 ELSE -1 END) > 0.00001)::int AS "legacyPriceRoundingOverTenMicroUsdt",
      max(abs(t."grossPnl"-(t."averageExitPrice"-t."averageEntryPrice")*t.quantity*CASE WHEN t.side='BUY' THEN 1 ELSE -1 END))::text AS "maxGrossPnlRoundingDifference",
      count(*) FILTER (WHERE t."closedAt" < t."openedAt")::int AS "invalidTradeTimes",
      count(*) FILTER (WHERE t.quantity<=0 OR t."averageEntryPrice"<=0 OR t."averageExitPrice"<=0 OR t.fees<0)::int AS "invalidTradeValues",
      count(*) FILTER (WHERE p.status<>'CLOSED' OR p."closedAt" IS DISTINCT FROM t."closedAt" OR p.quantity<>t.quantity OR p."entryPrice"<>t."averageEntryPrice" OR p."realizedPnl"<>t."netPnl")::int AS "positionTradeMismatch"
      FROM "Trade" t JOIN "Position" p ON p.id=t."positionId"`),
    fills: await one(`SELECT
      count(*) FILTER (WHERE x.orders <> CASE WHEN p.status='CLOSED' THEN 2 ELSE 1 END)::int AS "orderCountMismatch",
      count(*) FILTER (WHERE x.fills <> CASE WHEN p.status='CLOSED' THEN 2 ELSE 1 END)::int AS "fillCountMismatch",
      count(*) FILTER (WHERE x.entries<>1 OR (p.status='CLOSED' AND x.exits<>1))::int AS "fillSideMismatch",
      count(*) FILTER (WHERE x."quantityMismatch">0)::int AS "fillQuantityMismatch",
      count(*) FILTER (WHERE t.id IS NOT NULL AND abs(x.fees-t.fees)>0.00000002)::int AS "fillFeeMismatch"
      FROM "Position" p LEFT JOIN "Trade" t ON t."positionId"=p.id
      LEFT JOIN LATERAL (SELECT count(DISTINCT o.id)::int AS orders,count(f.id)::int AS fills,
        count(f.id) FILTER(WHERE o.side=p.side)::int AS entries,
        count(f.id) FILTER(WHERE o.side<>p.side)::int AS exits,
        count(f.id) FILTER(WHERE f.quantity<>p.quantity)::int AS "quantityMismatch",sum(f.fee) AS fees
        FROM "Order" o LEFT JOIN "Fill" f ON f."orderId"=o.id WHERE o."positionId"=p.id) x ON true`),
    decisions: await one(`SELECT
      count(*) FILTER(WHERE x.opens<>1)::int AS "openDecisionMismatch",
      count(*) FILTER(WHERE x.closes<>CASE WHEN p.status='CLOSED' THEN 1 ELSE 0 END)::int AS "closeDecisionMismatch",
      count(*) FILTER(WHERE x."closeTradeMismatch">0)::int AS "closeTradeLinkMismatch"
      FROM "Position" p LEFT JOIN "Trade" t ON t."positionId"=p.id
      LEFT JOIN LATERAL (SELECT count(*) FILTER(WHERE d.action='OPEN')::int AS opens,
        count(*) FILTER(WHERE d.action='CLOSE')::int AS closes,
        count(*) FILTER(WHERE d.action='CLOSE' AND d."tradeId" IS DISTINCT FROM t.id)::int AS "closeTradeMismatch"
        FROM "Decision" d WHERE d."positionId"=p.id) x ON true`),
    journal: await one(
      'SELECT min("observedAt") AS "fromAt", max("observedAt") AS "throughAt", count(*)::int AS events FROM "MarketPriceEvent"',
    ),
    recentReplayCoverage:
      await one(`SELECT count(*)::int AS "tradesWithRetainedEntryHistory" FROM "Trade"
      WHERE "openedAt">=(SELECT min("observedAt") FROM "MarketPriceEvent")`),
    closeCheckpointHistory:
      await one(`SELECT count(*)::int AS "legacyClosuresWithoutFinalEventCheckpoint"
      FROM "Position" p JOIN "Decision" d ON d."positionId"=p.id AND d.action='CLOSE'
      WHERE d.factors ? 'lastEventId' AND p."priceEventId"::text IS DISTINCT FROM d.factors->>'lastEventId'`),
    closeProcessingDelay: await one(`SELECT count(*)::int AS count,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM d."decidedAt"-t."closedAt")) AS "p50Seconds",
      percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM d."decidedAt"-t."closedAt")) AS "p95Seconds",
      max(extract(epoch FROM d."decidedAt"-t."closedAt")) AS "maxSeconds"
      FROM "Trade" t JOIN "Decision" d ON d."tradeId"=t.id AND d.action='CLOSE'
      WHERE d.factors->>'source'='durable-price-events'`),
    openManagement: await rows(`SELECT p.symbol,count(*)::int AS positions,
      max(extract(epoch FROM now()-p."managedThroughAt")) AS "maxPriceAgeSeconds",
      max(greatest(0,extract(epoch FROM e."observedAt"-p."managedThroughAt"))) AS "maxJournalLagSeconds",
      count(*) FILTER(WHERE p."profitProtection" IS NOT NULL)::int AS guarded,
      count(*) FILTER(WHERE p."trailingPrice" IS NOT NULL)::int AS trailing,
      count(*) FILTER(WHERE e."streamId" IS DISTINCT FROM p."priceStreamId")::int AS "streamMismatch"
      FROM "Position" p LEFT JOIN LATERAL (SELECT "observedAt","streamId" FROM "MarketPriceEvent" WHERE symbol=p.symbol ORDER BY id DESC LIMIT 1) e ON true
      WHERE p.status='OPEN' GROUP BY 1 ORDER BY 1`),
    cursorFailures: await rows(
      'SELECT "lastFailureCode", count(*)::int AS count, max("consecutiveFailures") AS consecutive FROM "RuntimeCursor" GROUP BY 1',
    ),
    incidents: await rows(
      "SELECT code,severity,count(*)::int AS count FROM \"WatchdogIncident\" WHERE status='OPEN' GROUP BY 1,2 ORDER BY 1,2",
    ),
  };
  await client.query("COMMIT");
  const checks = [
    summary.ledger,
    summary.fills,
    summary.decisions,
    summary.openProtection,
    summary.instrumentCompliance,
    summary.entryExecution,
  ];
  const failures = checks.flatMap((section) =>
    Object.entries(section)
      .filter(([key, value]) => /Mismatch|invalid|BeyondLegacy/.test(key) && Number(value) !== 0)
      .map(([key, value]) => `${key}: ${value}`),
  );
  const report = {
    ...summary,
    failures,
    notes: [
      "Read-only repeatable-read snapshot; no exchange credentials or records are exported.",
      "Aggregate PnL is a sum of independent virtual accounts, not a single portfolio.",
      "Legacy exit prices were rounded to eight decimals; older trades are not rewritten.",
      "Ledger checks do not prove every historical price touch or trading profitability.",
    ],
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(output, json, { mode: 0o600 });
  process.stdout.write(json);
  if (failures.length) process.exitCode = 1;
} finally {
  await client.end();
}
