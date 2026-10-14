import "dotenv/config";
import { createPrismaClient, PriceArchiveRepository } from "../packages/persistence/src/index";
import { replayRuntimeTrace } from "../apps/worker/src/runtime-trace-replay";
import { Prisma } from "../packages/persistence/src/generated/prisma/client";

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
          position: { include: { trade: true } },
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
    trade: trade
      ? {
          exitReason: trade.exitReason,
          closedAt: trade.closedAt,
          averageExitPrice: trade.averageExitPrice.toFixed(),
          grossPnl: trade.grossPnl.toFixed(),
          netPnl: trade.netPnl.toFixed(),
          fees: trade.fees.toFixed(),
          slippage: trade.slippage.toFixed(),
        }
      : null,
  });
  process.stdout.write(`${JSON.stringify({ positionId, ...result }, null, 2)}\n`);
  if (result.status !== "matched") process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
