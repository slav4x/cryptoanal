import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";

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
            observedAt: true,
          },
        },
        candles: {
          where: { interval: "15" },
          orderBy: { openTime: "desc" },
          take: 60,
          select: { open: true, high: true, low: true, close: true },
        },
      },
    });
  }

  public async getMarket(workspaceId: string, symbol: string) {
    return this.prisma.marketInstrument.findFirst({
      where: { symbol, enabled: true },
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
            observedAt: true,
          },
        },
        candles: {
          where: { interval: "15" },
          orderBy: { openTime: "desc" },
          take: 200,
          select: {
            openTime: true,
            open: true,
            high: true,
            low: true,
            close: true,
            volume: true,
            turnover: true,
          },
        },
      },
    });
  }

  public async hasEnabledMarket(symbol: string): Promise<boolean> {
    const count = await this.prisma.marketInstrument.count({
      where: { symbol, enabled: true },
    });
    return count > 0;
  }

  public async setWatchlisted(
    workspaceId: string,
    symbol: string,
    watchlisted: boolean,
  ): Promise<void> {
    if (!watchlisted) {
      await this.prisma.watchlistItem.deleteMany({ where: { workspaceId, symbol } });
      return;
    }

    const lastItem = await this.prisma.watchlistItem.findFirst({
      where: { workspaceId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    await this.prisma.watchlistItem.upsert({
      where: { workspaceId_symbol: { workspaceId, symbol } },
      update: {},
      create: { workspaceId, symbol, position: (lastItem?.position ?? -1) + 1 },
    });
  }

  public async getTradingLedger(workspaceId: string) {
    const [positions, trades, tradeSummary] = await Promise.all([
      this.prisma.position.findMany({
        where: { workspaceId, status: "OPEN" },
        orderBy: { openedAt: "desc" },
        select: {
          id: true,
          symbol: true,
          environment: true,
          side: true,
          quantity: true,
          entryPrice: true,
          markPrice: true,
          unrealizedPnl: true,
          openedAt: true,
          strategyVersion: {
            select: { version: true, strategy: { select: { id: true, name: true } } },
          },
        },
      }),
      this.prisma.trade.findMany({
        where: { workspaceId },
        orderBy: { closedAt: "desc" },
        take: 100,
        select: {
          id: true,
          symbol: true,
          environment: true,
          side: true,
          quantity: true,
          averageEntryPrice: true,
          averageExitPrice: true,
          grossPnl: true,
          fees: true,
          funding: true,
          slippage: true,
          netPnl: true,
          exitReason: true,
          openedAt: true,
          closedAt: true,
          strategyVersion: {
            select: { version: true, strategy: { select: { id: true, name: true } } },
          },
        },
      }),
      this.prisma.trade.aggregate({
        where: { workspaceId },
        _count: true,
        _sum: { netPnl: true },
      }),
    ]);

    const openExposure = positions
      .reduce(
        (sum, position) =>
          sum.add(position.quantity.mul(position.markPrice ?? position.entryPrice).abs()),
        new Prisma.Decimal(0),
      )
      .toFixed();
    const unrealizedPnl = positions
      .reduce((sum, position) => sum.add(position.unrealizedPnl), new Prisma.Decimal(0))
      .toFixed();

    return {
      positions,
      trades,
      summary: {
        openPositions: positions.length,
        openExposure,
        unrealizedPnl,
        closedTrades: tradeSummary._count,
        netPnl: tradeSummary._sum.netPnl?.toFixed() ?? "0",
      },
    };
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
