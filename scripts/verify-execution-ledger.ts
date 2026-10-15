import {
  verifyFundingRecord,
  verifyFundingAllocation,
  type FundingReplayBalance,
} from "../packages/persistence/src/funding-proof";
import { readPositionFundingState } from "../packages/persistence/src/funding-repository";
import "dotenv/config";
import { Client } from "pg";
import { writeFile } from "node:fs/promises";
import { hashTracePayload } from "../packages/persistence/src/position-trace";
import { readPinnedExecutionPolicy } from "../packages/persistence/src/execution-policy-repository";
import { readExecutionRecoveryModel } from "../packages/application/src/execution-recovery-policy";
import {
  verifyLiquidityExitFill,
  verifyLiquidityExitStep,
  type LiquidityExitStep,
} from "../packages/persistence/src/liquidity-exit-proof";
import {
  exitDecimal,
  initialLiquidityExitState,
  remainingExitQuantity,
  remainingExitEntryFee,
  type ExitPositionBasis,
  type LiquidityExitState,
} from "../packages/persistence/src/liquidity-exit-model";
import {
  isLiquidityExitPolicy,
  liquidityExitVersion,
} from "../packages/application/src/execution-exit-policy";
import { entryLiquidityVersion } from "../packages/application/src/execution-entry-liquidity";
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
import { verifyExitTriggerProof } from "../packages/persistence/src/exit-trigger-proof";
import {
  executionExitPolicyVersion,
  readExecutionExitPolicy,
} from "../packages/application/src/execution-exit-policy";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = new Client({ connectionString: process.env.DATABASE_URL });
const output = process.argv.slice(2).filter((argument) => argument !== "--")[0];
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '60s'");
  const one = async (sql: string) => (await client.query(sql)).rows[0];
  const rows = async (sql: string) => (await client.query(sql)).rows;
  const executionPolicies = {
    runs: 0,
    positions: 0,
    validations: 0,
    orders: 0,
    baselines: 0,
    invalidExecutionPolicies: 0,
    errors: [] as string[],
  };
  for (const [table, countKey] of [
    ["ExecutionRun", "runs"],
    ["Position", "positions"],
    ["ValidationRun", "validations"],
  ] as const) {
    for (const row of await rows(
      `SELECT id,"executionPolicy" FROM "${table}" WHERE "executionPolicy" IS NOT NULL`,
    )) {
      executionPolicies[countKey]++;
      try {
        readPinnedExecutionPolicy(row.executionPolicy);
      } catch {
        executionPolicies.invalidExecutionPolicies++;
        executionPolicies.errors.push(`${table}:${row.id}:invalid snapshot`);
      }
    }
  }
  for (const row of await rows(`SELECT o.id,o.execution->'snapshot'->'executionPolicy' AS policy,r."executionPolicy" AS run,p."executionPolicy" AS position
    FROM "Order" o JOIN "ExecutionRun" r ON r.id=o."executionRunId" LEFT JOIN "Position" p ON p.id=o."positionId"
    WHERE o.execution->'snapshot'->'executionPolicy' IS NOT NULL`)) {
    executionPolicies.orders++;
    try {
      const order = readPinnedExecutionPolicy(row.policy),
        run = readPinnedExecutionPolicy(row.run),
        position = readPinnedExecutionPolicy(row.position);
      if (!order || order.hash !== run?.hash || (position && position.hash !== order.hash))
        throw new Error("binding mismatch");
    } catch {
      executionPolicies.invalidExecutionPolicies++;
      executionPolicies.errors.push(`Order:${row.id}:policy binding`);
    }
  }
  for (const row of await rows(`SELECT b."executionRunId",r."executionPolicy" AS run,v."executionPolicy" AS validation,v.status,
    r."workspaceId"=v."workspaceId" AND r."strategyVersionId"=v."strategyVersionId" AND r."configHash"=v."configHash" AS compatible
    FROM "ExecutionPolicyBaseline" b JOIN "ExecutionRun" r ON r.id=b."executionRunId" JOIN "ValidationRun" v ON v.id=b."validationRunId"`)) {
    executionPolicies.baselines++;
    try {
      const run = readPinnedExecutionPolicy(row.run),
        validation = readPinnedExecutionPolicy(row.validation);
      if (
        !run ||
        run.profileHash !== validation?.profileHash ||
        row.status !== "COMPLETED" ||
        !row.compatible
      )
        throw new Error("baseline mismatch");
    } catch {
      executionPolicies.invalidExecutionPolicies++;
      executionPolicies.errors.push(`Baseline:${row.executionRunId}:policy binding`);
    }
  }
  const openProtection = { checked: 0, invalidOpenProtection: 0, protectionMismatch: 0 };
  const recoveryPolicies = { checked: 0, invalidRecoveryPolicyBindings: 0 };
  for (const row of await rows(
    `SELECT p.id,p."recoveryModel",o.execution->'snapshot'->>'recoveryModel' AS "orderModel",t.snapshot->>'recoveryModel' AS "traceModel" FROM "Position" p LEFT JOIN "Order" o ON o."positionId"=p.id AND o.side=p.side LEFT JOIN "PositionExecutionTrace" t ON t."positionId"=p.id WHERE p."recoveryModel" IS NOT NULL OR o.execution->'snapshot'->>'recoveryModel' IS NOT NULL OR t.snapshot->>'recoveryModel' IS NOT NULL`,
  )) {
    recoveryPolicies.checked++;
    try {
      const model = readExecutionRecoveryModel(row.recoveryModel);
      if (!model || model !== row.orderModel || model !== row.traceModel)
        throw Error("Recovery binding mismatch");
    } catch {
      recoveryPolicies.invalidRecoveryPolicyBindings++;
    }
  }
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
        ...(stored.exitPolicy ? { exitPolicy: readExecutionExitPolicy(stored.exitPolicy)! } : {}),
        ...(stored.entryExecution
          ? { entryExecution: readEntryExecutionMarker(stored.entryExecution)! }
          : {}),
        ...(stored.instrumentRules
          ? { instrumentRules: readExecutionInstrumentRules(stored.instrumentRules)! }
          : {}),
        ...(stored.fundingPolicy ? { fundingPaid: Number(stored.fundingRemaining) } : {}),
        symbol: stored.symbol,
        side: stored.side === "BUY" ? "long" : "short",
        openedAt: stored.openedAt,
        entryPrice: Number(stored.entryPrice),
        quantity: Number(stored.remainingQuantity ?? stored.quantity),
        stopPrice: Number(stored.stopPrice),
        takePrice: Number(stored.takePrice),
        trailingPrice: stored.trailingPrice === null ? null : Number(stored.trailingPrice),
        bestPrice: Number(stored.bestPrice),
        entryFee: Number(stored.remainingEntryFee ?? stored.entryFee),
        entrySlippage: Number(stored.entrySlippage),
        entryRegime: "unknown",
        entrySession: "unknown",
      };
      if (position.instrumentRules) {
        instrumentCompliance.checked++;
        if (
          executionInstrumentSizeFailure(
            { ...position, quantity: Number(stored.quantity) },
            position.instrumentRules,
            !!position.entryExecution,
          )
        )
          instrumentCompliance.invalidInstrumentPositions++;
      } else instrumentCompliance.legacyOpenPositions++;
      if (stored.exitState) continue;
      const quote = {
        source: "LastPrice" as const,
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
    WHERE o.execution->'snapshot'->>'version'='${entryLiquidityVersion}'`)) {
    if (order.status === "OPEN") {
      entryExecution.open++;
      continue;
    }
    entryExecution.checked++;
    try {
      const proof = verifyEntryExecutionProof(order, strategyConfigSchema.parse(order.config));
      if (proof.outcome === "full") entryExecution.full++;
      else if (proof.outcome === "partial") entryExecution.partial++;
      else if (proof.outcome === "cancelled") entryExecution.cancelled++;
      else throw new Error("Unsupported entry outcome");
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
  const exitExecution = { checked: 0, invalidExitReceipts: 0 };
  for (const fill of await rows(`SELECT f.quantity::text,f.price::text,f.fee::text,f."filledAt",f.execution,p."exitPolicy",v.config
    FROM "Fill" f JOIN "Order" o ON o.id=f."orderId" JOIN "Position" p ON p.id=o."positionId"
    JOIN "StrategyVersion" v ON v.id=p."strategyVersionId" WHERE f.execution->'payload'->>'version'='${executionExitPolicyVersion}'`)) {
    exitExecution.checked++;
    try {
      verifyExitTriggerProof(fill, strategyConfigSchema.parse(fill.config), fill.exitPolicy);
    } catch {
      exitExecution.invalidExitReceipts++;
    }
  }
  const missingExitReceipts = await one(`SELECT count(*)::int AS "missingExitReceipts" FROM "Fill" f
    JOIN "Order" o ON o.id=f."orderId" JOIN "Position" p ON p.id=o."positionId" JOIN "Trade" t ON t."positionId"=p.id
    WHERE p."exitPolicy"->>'fillModel'='fixed-slippage@1' AND o.side<>p.side AND t."exitReason" IN ('stop-loss','take-profit','trailing-stop')
    AND (f.execution->'payload'->>'version' IS DISTINCT FROM '${executionExitPolicyVersion}')`);
  const liquidityExits = {
    checked: 0,
    fills: 0,
    closing: 0,
    invalidLiquidityExitPositions: 0,
    errors: [] as Array<{ positionId: string; message: string }>,
  };
  for (const p of await rows(
    `SELECT p.*,v.config FROM "Position" p JOIN "StrategyVersion" v ON v.id=p."strategyVersionId" WHERE p."exitPolicy"->>'fillModel'='l1-ioc@1'`,
  )) {
    liquidityExits.checked++;
    if (p.status === "OPEN" && p.exitState) liquidityExits.closing++;
    try {
      const policy = readExecutionExitPolicy(p.exitPolicy);
      if (!isLiquidityExitPolicy(policy)) throw new Error("Invalid liquidity exit policy");
      const basis: ExitPositionBasis = {
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        quantity: exitDecimal(p.quantity).toFixed(),
        entryPrice: exitDecimal(p.entryPrice).toFixed(),
        entryFee: exitDecimal(p.entryFee).toFixed(),
        entrySlippage: exitDecimal(p.entrySlippage).toFixed(),
        instrumentRules: readExecutionInstrumentRules(p.instrumentRules)!,
        policy,
      };
      const config = strategyConfigSchema.parse(p.config);
      const orders = (await client.query('SELECT * FROM "Order" WHERE "positionId"=$1', [p.id]))
        .rows;
      let net = exitDecimal(0),
        gross = exitDecimal(0),
        allocated = exitDecimal(0),
        exits = exitDecimal(0),
        fees = exitDecimal(0),
        entries = exitDecimal(0),
        open = 0;
      for (const o of orders) {
        const fills = (await client.query('SELECT * FROM "Fill" WHERE "orderId"=$1', [o.id])).rows;
        for (const f of fills) {
          fees = fees.add(f.fee);
          if (o.side === p.side) entries = entries.add(f.quantity);
        }
        if (o.side === p.side) continue;
        const receipt = o.execution;
        if (
          !receipt ||
          receipt.snapshot?.version !== liquidityExitVersion ||
          hashTracePayload(receipt.snapshot) !== receipt.hash ||
          receipt.snapshot.positionId !== p.id ||
          hashTracePayload(receipt.snapshot.policy) !== hashTracePayload(policy) ||
          !exitDecimal(o.quantity).eq(receipt.snapshot.ioc.quantity) ||
          o.type !== "MARKET" ||
          fills.length > 1
        )
          throw new Error("Invalid liquidity exit order receipt");
        let filled = exitDecimal(0);
        for (const f of fills) {
          verifyLiquidityExitFill(f, config, basis);
          liquidityExits.fills++;
          if (
            f.execution.payload.orderId !== o.id ||
            hashTracePayload(f.execution.payload.snapshot) !== receipt.hash
          )
            throw new Error("Fill order link mismatch");
          filled = filled.add(f.quantity);
          exits = exits.add(f.quantity);
          net = net.add(f.realizedNetPnl);
          gross = gross.add(f.realizedGrossPnl);
          allocated = allocated.add(f.entryFeeAllocated);
        }
        if (o.status === "OPEN") {
          open++;
          if (fills.length || receipt.terminal || p.exitState?.order?.id !== o.id)
            throw new Error("Open exit order mismatch");
        } else if (
          !receipt.terminal ||
          !filled.eq(receipt.terminal.filledQuantity) ||
          !filled.add(receipt.terminal.cancelledQuantity).eq(o.quantity) ||
          (o.status === "FILLED") !== filled.eq(o.quantity)
        )
          throw new Error("Exit terminal balance mismatch");
      }
      if (
        !entries.eq(p.quantity) ||
        !exits.add(p.remainingQuantity).eq(p.quantity) ||
        !allocated.add(p.remainingEntryFee).eq(p.entryFee) ||
        !net.sub(p.fundingAccrued ?? 0).eq(p.realizedPnl) ||
        open !== (p.exitState?.order ? 1 : 0) ||
        (p.status === "CLOSED" && !exitDecimal(p.remainingQuantity).eq(0)) ||
        (p.status === "OPEN" &&
          exitDecimal(p.remainingQuantity).eq(0) &&
          (!p.fundingPolicy ||
            !p.closedAt ||
            p.exitState?.waitingReason !== "EXIT_WAITING_FUNDING"))
      )
        throw new Error("Position partial balance mismatch");
      if (p.fundingPolicy || p.exitState) {
        const header = (
          await client.query(
            'SELECT snapshot FROM "PositionExecutionTrace" WHERE "positionId"=$1',
            [p.id],
          )
        ).rows[0]?.snapshot;
        let funding: FundingReplayBalance | null = p.fundingPolicy
          ? {
              state: readPositionFundingState(header.funding.state)!,
              accrued: header.funding.accrued,
              remaining: header.funding.remaining,
              paid: {},
            }
          : null;
        const fundingExits: Array<{ quantity: string; filledAt: string }> = [];
        const checkedPayments = new Set<string>();
        let state: LiquidityExitState | null = null;
        for (const r of (
          await client.query(
            'SELECT * FROM "PositionTraceRecord" WHERE "positionId"=$1 ORDER BY id',
            [p.id],
          )
        ).rows) {
          if (hashTracePayload(r.payload) !== r.payloadHash) throw new Error("Trace hash mismatch");
          if (r.kind === "funding") {
            if (!funding) throw new Error("Unexpected funding trace");
            funding = await verifyFundingRecord(
              r.payload,
              {
                id: p.id,
                symbol: p.symbol,
                side: p.side,
                quantity: basis.quantity,
                openedAt: p.openedAt.toISOString(),
              },
              funding,
              fundingExits,
              async (id) =>
                (
                  await client.query(
                    'SELECT payload,"payloadHash" FROM "FundingHistorySnapshot" WHERE id=$1',
                    [id],
                  )
                ).rows[0] ?? null,
            );
            for (const payment of r.payload.payments) {
              const row = (
                await client.query(
                  'SELECT * FROM "PositionFundingPayment" WHERE "positionId"=$1 AND "settledAt"=$2',
                  [p.id, payment.event.settledAt],
                )
              ).rows[0];
              if (
                !row ||
                checkedPayments.has(row.id) ||
                hashTracePayload(row.execution.payload) !== row.execution.hash ||
                row.execution.payload.positionId !== p.id ||
                hashTracePayload(row.execution.payload.event) !== hashTracePayload(payment.event) ||
                !exitDecimal(row.quantity).eq(payment.quantity) ||
                !exitDecimal(row.amount).eq(payment.amount) ||
                !exitDecimal(row.rate).eq(payment.event.rate) ||
                !exitDecimal(row.markPrice).eq(payment.event.markPrice)
              )
                throw new Error("Funding receipt mismatch");
              checkedPayments.add(row.id);
            }
          } else if (r.kind === "liquidity-finalize") {
            if (
              !state ||
              !funding ||
              hashTracePayload(r.payload.before) !== hashTracePayload(state) ||
              hashTracePayload(r.payload.after) !==
                hashTracePayload({ ...state, waitingReason: null })
            )
              throw new Error("Funding finalization mismatch");
            state = r.payload.after;
          } else if (r.kind === "liquidity-trigger") {
            if (state || hashTracePayload(r.payload.basis) !== hashTracePayload(basis))
              throw new Error("Trigger basis mismatch");
            state = initialLiquidityExitState(basis, r.payload.state.intent);
            if (hashTracePayload(state) !== hashTracePayload(r.payload.state))
              throw new Error("Initial exit balance mismatch");
          } else if (r.kind === "liquidity-step") {
            if (!state) throw new Error("Missing exit intent");
            const step = r.payload as LiquidityExitStep;
            if (step.action.kind === "fill" && step.action.result.kind === "fill") {
              if (funding) {
                const allocation = verifyFundingAllocation(
                  step.fundingAllocation,
                  funding.remaining,
                  step.action.result.quantity,
                  remainingExitQuantity(state),
                );
                funding = { ...funding, remaining: allocation.remaining };
              }
              fundingExits.push({
                quantity: step.action.result.quantity,
                filledAt: step.event.observedAt,
              });
            }
            state = verifyLiquidityExitStep(step, config, basis, state).state;
          }
        }
        if (funding) {
          if (
            !exitDecimal(funding.accrued).eq(p.fundingAccrued) ||
            !exitDecimal(funding.remaining).eq(p.fundingRemaining) ||
            hashTracePayload(funding.state) !== hashTracePayload(p.fundingState) ||
            (
              await client.query(
                'SELECT count(*)::int AS count FROM "PositionFundingPayment" WHERE "positionId"=$1',
                [p.id],
              )
            ).rows[0].count !== checkedPayments.size
          )
            throw new Error("Funding persisted balance mismatch");
        }
        if (
          p.exitState &&
          (!state ||
            hashTracePayload(state) !== hashTracePayload(p.exitState) ||
            !exitDecimal(remainingExitQuantity(state)).eq(p.remainingQuantity) ||
            !exitDecimal(remainingExitEntryFee(state)).eq(p.remainingEntryFee))
        )
          throw new Error("Stored exit state mismatch");
      }
      if (p.status === "CLOSED") {
        const t = (await client.query('SELECT * FROM "Trade" WHERE "positionId"=$1', [p.id]))
          .rows[0];
        if (
          !t ||
          !net.sub(p.fundingAccrued ?? 0).eq(t.netPnl) ||
          !exitDecimal(t.funding).eq(p.fundingAccrued ?? 0) ||
          !gross.eq(t.grossPnl) ||
          !fees.eq(t.fees)
        )
          throw new Error("Aggregate trade mismatch");
      }
    } catch (error) {
      liquidityExits.invalidLiquidityExitPositions++;
      liquidityExits.errors.push({
        positionId: p.id,
        message: error instanceof Error ? error.message : "Unknown receipt failure",
      });
    }
  }
  const summary = {
    recoveryPolicies,
    executionPolicies,
    liquidityExits,
    funding:
      await one(`SELECT count(*)::int AS positions,count(*) FILTER(WHERE "fundingState"->>'status'='pending')::int AS pending,
      count(*) FILTER(WHERE status='OPEN' AND "remainingQuantity"=0)::int AS financialPending,
      (SELECT count(*)::int FROM "PositionFundingPayment") AS payments,
      (SELECT coalesce(sum(amount),0)::text FROM "PositionFundingPayment") AS signedCost FROM "Position" WHERE "fundingPolicy" IS NOT NULL`),
    exitExecution: { ...exitExecution, ...missingExitReceipts },
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
        FROM "Order" o LEFT JOIN "Fill" f ON f."orderId"=o.id WHERE o."positionId"=p.id) x ON true
      WHERE p."exitPolicy"->>'fillModel' IS DISTINCT FROM 'l1-ioc@1'`),
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
      WHERE p.status='OPEN' AND coalesce(p."remainingQuantity",p.quantity)>0 GROUP BY 1 ORDER BY 1`),
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
    summary.exitExecution,
    summary.liquidityExits,
    summary.executionPolicies,
    summary.recoveryPolicies,
  ];
  const failures = checks.flatMap((section) =>
    Object.entries(section)
      .filter(
        ([key, value]) =>
          /Mismatch|invalid|BeyondLegacy|missingExit/.test(key) && Number(value) !== 0,
      )
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
