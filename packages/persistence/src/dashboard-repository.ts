import type { CryptoAnalPrismaClient } from "./client";

export class DashboardRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async getWorkspace(workspaceId: string) {
    return this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true },
    });
  }

  public async getOverview(workspaceId: string) {
    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);

    const [openPositions, activeStrategies, totalAggregate, dayAggregate, account, heartbeat] =
      await Promise.all([
        this.prisma.position.count({ where: { workspaceId, status: "OPEN" } }),
        this.prisma.strategy.count({
          where: { workspaceId, status: { in: ["DEPLOYED", "PAUSED"] } },
        }),
        this.prisma.trade.aggregate({
          where: { workspaceId },
          _sum: { netPnl: true },
        }),
        this.prisma.trade.aggregate({
          where: { workspaceId, closedAt: { gte: startOfUtcDay } },
          _sum: { netPnl: true },
        }),
        this.prisma.accountSnapshot.findFirst({
          where: { workspaceId },
          orderBy: { observedAt: "desc" },
          select: { equity: true, observedAt: true },
        }),
        this.prisma.workerHeartbeat.findFirst({
          where: { service: "worker" },
          orderBy: { lastSeenAt: "desc" },
          select: { lastSeenAt: true },
        }),
      ]);

    return {
      openPositions,
      activeStrategies,
      totalPnl: totalAggregate._sum.netPnl?.toFixed() ?? "0",
      dayPnl: dayAggregate._sum.netPnl?.toFixed() ?? "0",
      equity: account?.equity.toFixed() ?? null,
      accountObservedAt: account?.observedAt ?? null,
      workerLastSeenAt: heartbeat?.lastSeenAt ?? null,
    };
  }

  public async listMarkets(workspaceId: string) {
    return this.prisma.marketInstrument.findMany({
      where: { enabled: true },
      orderBy: [{ watchlistItems: { _count: "desc" } }, { symbol: "asc" }],
      select: {
        symbol: true,
        baseAsset: true,
        quoteAsset: true,
        exchange: true,
        instrumentType: true,
        watchlistItems: {
          where: { workspaceId },
          select: { position: true },
        },
        snapshots: {
          orderBy: { observedAt: "desc" },
          take: 1,
          select: {
            price: true,
            change24hPercent: true,
            volume24h: true,
            regime: true,
            observedAt: true,
          },
        },
      },
    });
  }

  public async ping(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
