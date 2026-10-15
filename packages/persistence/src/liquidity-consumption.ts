import { Prisma } from "./generated/prisma/client";
import type { ExecutionEntryOrder } from "../../application/src/execution-entry-liquidity";
import { readExecutionMarketData } from "../../application/src/execution-market-data";
import { exitDecimal } from "./liquidity-exit-model";

export async function consumedExecutionLiquidity(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    exchangeAccountId: string;
    sourceKey: string;
    order: ExecutionEntryOrder;
    event: {
      id: bigint;
      symbol: string;
      streamId: string;
      receivedAt: Date;
      executionData: unknown;
    };
  },
) {
  const { event, order } = input;
  const fills = await tx.fill.findMany({
    where: {
      workspaceId: input.workspaceId,
      order: {
        executionRun: {
          environment: "DRY_RUN",
          deployment: { exchangeAccountId: input.exchangeAccountId },
        },
      },
      execution: { path: ["payload", "sourceKey"], equals: input.sourceKey },
    },
    select: { quantity: true },
  });
  const own = fills
    .reduce((sum, fill) => sum.add(fill.quantity.toFixed()), exitDecimal(0))
    .toFixed();
  let publicConsumed = "0";
  if (order.timeInForce === "IOC") {
    const book = readExecutionMarketData(event.executionData).book!;
    const raw = (event.executionData as ExecutionEntryOrder["placementData"])[5]!;
    const [row] = await tx.$queryRaw<Array<{ quantity: string }>>(Prisma.sql`
      SELECT coalesce(sum(("executionData"->>1)::numeric),0)::text AS quantity FROM "MarketPriceEvent"
      WHERE symbol=${event.symbol} AND "streamId"=${event.streamId} AND id>${BigInt(order.submitEventId)} AND id<${event.id}
      AND "observedAt">=${new Date(book.observedAt)} AND "receivedAt"<=${event.receivedAt} AND "executionData"->5->>6=${raw[6]}
      AND "executionData"->>2=${order.side === "long" ? "Buy" : "Sell"}
      AND coalesce("executionData"->>3,'false')<>'true' AND coalesce("executionData"->>4,'false')<>'true'
      AND ${order.side === "long" ? Prisma.sql`price>=${book.ask[0]}::numeric` : Prisma.sql`price<=${book.bid[0]}::numeric`}`);
    publicConsumed = row!.quantity;
  }
  return { own, publicConsumed };
}
