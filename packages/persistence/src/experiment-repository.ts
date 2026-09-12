import type { CryptoAnalPrismaClient } from "./client";

export class ExperimentRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async getRankingDataset(workspaceId: string) {
    const deployments = await this.prisma.deployment.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        status: true,
        environment: true,
        exchangeAccountId: true,
        createdAt: true,
        strategy: { select: { id: true, name: true } },
        strategyVersion: {
          select: { id: true, version: true, config: true },
        },
        executionRuns: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            startedAt: true,
            trades: {
              orderBy: [{ closedAt: "asc" }, { id: "asc" }],
              select: {
                symbol: true,
                grossPnl: true,
                fees: true,
                funding: true,
                slippage: true,
                netPnl: true,
                openedAt: true,
                closedAt: true,
              },
            },
            positions: {
              where: { status: "OPEN" },
              orderBy: [{ openedAt: "asc" }, { id: "asc" }],
              select: {
                symbol: true,
                side: true,
                quantity: true,
                entryPrice: true,
                markPrice: true,
                unrealizedPnl: true,
                openedAt: true,
              },
            },
          },
        },
      },
    });

    return deployments.map((deployment) => ({
      ...deployment,
      startedAt: deployment.executionRuns.find((run) => run.startedAt !== null)?.startedAt ?? null,
      trades: deployment.executionRuns.flatMap((run) =>
        run.trades.map((trade) => ({
          ...trade,
          grossPnl: trade.grossPnl.toNumber(),
          fees: trade.fees.toNumber(),
          funding: trade.funding.toNumber(),
          slippage: trade.slippage.toNumber(),
          netPnl: trade.netPnl.toNumber(),
        })),
      ),
      positions: deployment.executionRuns.flatMap((run) =>
        run.positions.map((position) => ({
          ...position,
          quantity: position.quantity.toNumber(),
          entryPrice: position.entryPrice.toNumber(),
          markPrice: position.markPrice?.toNumber() ?? null,
          unrealizedPnl: position.unrealizedPnl.toNumber(),
        })),
      ),
    }));
  }
}
