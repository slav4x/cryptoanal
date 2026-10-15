import { Prisma } from "./generated/prisma/client";
import { exitDecimal } from "./liquidity-exit-model";

export async function realizedCashPnl(
  tx: Pick<Prisma.TransactionClient, "trade" | "fill" | "positionFundingPayment">,
  input: {
    workspaceId: string;
    exchangeAccountId?: string;
    environment?: "DRY_RUN";
    since: Date;
    until?: Date;
  },
) {
  const account = input.exchangeAccountId
    ? { deployment: { exchangeAccountId: input.exchangeAccountId } }
    : {};
  const range = { gte: input.since, ...(input.until ? { lte: input.until } : {}) };
  const [legacy, partial, funding] = await Promise.all([
    tx.trade.aggregate({
      where: {
        workspaceId: input.workspaceId,
        ...(input.environment ? { environment: input.environment } : {}),
        executionRun: account,
        closedAt: range,
        position: {
          OR: [
            { exitPolicy: { equals: Prisma.DbNull } },
            { exitPolicy: { path: ["fillModel"], not: "l1-ioc@1" } },
          ],
        },
      },
      _sum: { netPnl: true },
    }),
    tx.fill.aggregate({
      where: {
        workspaceId: input.workspaceId,
        realizedNetPnl: { not: null },
        filledAt: range,
        order: {
          executionRun: {
            ...(input.environment ? { environment: input.environment } : {}),
            ...account,
          },
        },
      },
      _sum: { realizedNetPnl: true },
    }),
    tx.positionFundingPayment.aggregate({
      where: {
        workspaceId: input.workspaceId,
        settledAt: range,
        position: {
          executionRun: account,
          ...(input.environment ? { environment: input.environment } : {}),
        },
      },
      _sum: { amount: true },
    }),
  ]);
  return exitDecimal(legacy._sum.netPnl ?? 0)
    .add(partial._sum.realizedNetPnl?.toFixed() ?? 0)
    .sub(funding._sum.amount?.toFixed() ?? 0)
    .toFixed();
}
