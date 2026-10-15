import "dotenv/config";
import { createPrismaClient, PriceArchiveRepository } from "../packages/persistence/src/index";
import { replayRuntimeTrace } from "../apps/worker/src/runtime-trace-replay";
import { Prisma } from "../packages/persistence/src/generated/prisma/client";
import { verifyEntryExecutionProof } from "../packages/persistence/src/entry-execution-proof";
import { verifyExitTriggerProof } from "../packages/persistence/src/exit-trigger-proof";
import { entryLiquidityVersion } from "../packages/application/src/execution-entry-liquidity";
import { liquidityExitBasis } from "../packages/persistence/src/liquidity-exit-repository";
import { verifyLiquidityExitFill } from "../packages/persistence/src/liquidity-exit-proof";
import {
  isLiquidityExitPolicy,
  liquidityExitVersion,
  executionExitPolicyVersion,
} from "../packages/application/src/execution-exit-policy";
import { strategyConfigSchema } from "../packages/contracts/src/index";

const [workspaceId, positionId] = process.argv.slice(2).filter((argument) => argument !== "--");
if (!workspaceId || !positionId || !process.env.DATABASE_URL)
  throw new Error(
    "Usage: pnpm runtime:replay-trace <workspace-id> <position-id>; DATABASE_URL is required",
  );
const prisma = createPrismaClient(process.env.DATABASE_URL);
try {
  const trace = await prisma.$transaction(
    (tx) =>
      tx.positionExecutionTrace.findFirst({
        where: { positionId, workspaceId },
        include: {
          records: { orderBy: { id: "asc" } },
          position: {
            include: {
              trade: true,
              orders: { include: { fills: true } },
            },
          },
        },
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  if (!trace) throw new Error("Execution trace not found in this workspace");
  if (trace.retainUntil && trace.retainUntil <= new Date())
    throw new Error("Execution trace retention expired");
  const archive = new PriceArchiveRepository(prisma);
  const trade = trace.position.trade;
  const result = await replayRuntimeTrace({
    snapshot: trace.snapshot,
    snapshotHash: trace.snapshotHash,
    fullFromEntry: trace.fullFromEntry,
    startEventId: trace.startEventId,
    expectedEventCount: trace.eventCount,
    endEventId: trace.endEventId ?? trace.position.priceEventId ?? trace.startEventId,
    records: trace.records,
    loadEvents: (cursor, through) => archive.after(trace.symbol, cursor, through),
    loadFundingSnapshot: (id) =>
      prisma.fundingHistorySnapshot.findUnique({
        where: { id },
        select: { payload: true, payloadHash: true },
      }),
    trade: trade
      ? {
          exitReason: trade.exitReason,
          closedAt: trade.closedAt,
          averageExitPrice: trade.averageExitPrice.toFixed(),
          grossPnl: trade.grossPnl.toFixed(),
          netPnl: trade.netPnl.toFixed(),
          fees: trade.fees.toFixed(),
          funding: trade.funding.toFixed(),
          slippage: trade.slippage.toFixed(),
        }
      : null,
  });
  const entryExecution = trace.position.orders
    .filter(
      (order) =>
        (order.execution as { snapshot?: { version?: string } } | null)?.snapshot?.version ===
        entryLiquidityVersion,
    )
    .map((order) =>
      verifyEntryExecutionProof(
        order,
        strategyConfigSchema.parse((trace.snapshot as { config: unknown }).config),
      ),
    );
  const exitExecution = trace.position.orders
    .flatMap((order) => order.fills)
    .filter(
      (fill) =>
        (fill.execution as { payload?: { version?: string } } | null)?.payload?.version ===
        executionExitPolicyVersion,
    )
    .map((fill) =>
      verifyExitTriggerProof(
        fill,
        strategyConfigSchema.parse((trace.snapshot as { config: unknown }).config),
        trace.position.exitPolicy,
      ),
    );
  if (
    trace.position.exitPolicy &&
    !isLiquidityExitPolicy(trace.position.exitPolicy) &&
    trade &&
    ["stop-loss", "take-profit", "trailing-stop"].includes(trade.exitReason) &&
    exitExecution.length !== 1
  )
    throw new Error("Exit trigger receipt is missing or duplicated");
  const liquidityExitExecution = trace.position.orders
    .flatMap((order) => order.fills)
    .filter(
      (fill) =>
        (fill.execution as { payload?: { version?: string } } | null)?.payload?.version ===
        liquidityExitVersion,
    )
    .map((fill) =>
      verifyLiquidityExitFill(
        fill,
        strategyConfigSchema.parse((trace.snapshot as { config: unknown }).config),
        liquidityExitBasis(trace.position),
      ),
    );
  process.stdout.write(
    `${JSON.stringify({ positionId, ...result, ...(entryExecution.length ? { entryExecution } : {}), ...(exitExecution.length ? { exitExecution } : {}), ...(liquidityExitExecution.length ? { liquidityExitExecution } : {}) }, null, 2)}\n`,
  );
  if (result.status !== "matched") process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
