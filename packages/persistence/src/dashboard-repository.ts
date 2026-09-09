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

  public async getOverview(
    workspaceId: string,
    equityWindow: { startsAt: Date; bucketSeconds: number },
    portfolioAccountId: string,
  ) {
    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);

    const [
      positions,
      activeStrategies,
      totalAggregate,
      dayAggregate,
      account,
      heartbeat,
      activeDeployments,
    ] = await Promise.all([
      this.prisma.position.findMany({
        where: { workspaceId, status: "OPEN" },
        select: {
          quantity: true,
          entryPrice: true,
          markPrice: true,
          unrealizedPnl: true,
        },
      }),
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
        where: { workspaceId, exchangeAccountId: portfolioAccountId },
        orderBy: { observedAt: "desc" },
        select: {
          exchangeAccountId: true,
          environment: true,
          equity: true,
          availableBalance: true,
          observedAt: true,
        },
      }),
      this.prisma.workerHeartbeat.findFirst({
        where: { service: "worker" },
        orderBy: { lastSeenAt: "desc" },
        select: { lastSeenAt: true },
      }),
      this.prisma.deployment.findMany({
        where: { workspaceId, status: { in: ["RUNNING", "PAUSED"] } },
        select: {
          status: true,
          executionRuns: {
            where: { status: "RUNNING" },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              runtimeCursors: {
                where: { consecutiveFailures: { gt: 0 } },
                take: 1,
                select: { symbol: true },
              },
            },
          },
        },
      }),
    ]);

    const openExposure = positions.reduce(
      (sum, position) =>
        sum.add(position.quantity.mul(position.markPrice ?? position.entryPrice).abs()),
      new Prisma.Decimal(0),
    );
    const unrealizedPnl = positions.reduce(
      (sum, position) => sum.add(position.unrealizedPnl),
      new Prisma.Decimal(0),
    );

    const equitySeries = account
      ? await this.getEquitySeries({
          workspaceId,
          exchangeAccountId: account.exchangeAccountId,
          environment: account.environment,
          ...equityWindow,
        })
      : [];

    return {
      openPositions: positions.length,
      openExposure: openExposure.toFixed(),
      unrealizedPnl: unrealizedPnl.toFixed(),
      activeStrategies,
      totalPnl: totalAggregate._sum.netPnl?.toFixed() ?? "0",
      dayPnl: dayAggregate._sum.netPnl?.toFixed() ?? "0",
      account: account
        ? {
            ...account,
            equity: account.equity.toFixed(),
            availableBalance: account.availableBalance?.toFixed() ?? null,
          }
        : null,
      equitySeries,
      workerLastSeenAt: heartbeat?.lastSeenAt ?? null,
      runtimeDeploymentStatus: activeDeployments.some(
        (deployment) => deployment.status === "RUNNING",
      )
        ? ("RUNNING" as const)
        : activeDeployments.some((deployment) => deployment.status === "PAUSED")
          ? ("PAUSED" as const)
          : null,
      runtimeHasFailures: activeDeployments.some(
        (deployment) => (deployment.executionRuns[0]?.runtimeCursors.length ?? 0) > 0,
      ),
    };
  }

  private async getEquitySeries({
    workspaceId,
    exchangeAccountId,
    environment,
    startsAt,
    bucketSeconds,
  }: {
    workspaceId: string;
    exchangeAccountId: string;
    environment: "DRY_RUN" | "DEMO" | "LIVE";
    startsAt: Date;
    bucketSeconds: number;
  }) {
    const rows = await this.prisma.$queryRaw<
      Array<{ equity: Prisma.Decimal; observedAt: Date }>
    >(Prisma.sql`
      WITH samples AS (
        SELECT
          "equity",
          "observedAt",
          FLOOR(EXTRACT(EPOCH FROM ("observedAt" - ${startsAt})) / ${bucketSeconds}) AS bucket
        FROM "AccountSnapshot"
        WHERE "workspaceId" = ${workspaceId}
          AND "exchangeAccountId" = ${exchangeAccountId}
          AND "environment" = CAST(${environment} AS "TradingEnvironment")
          AND "observedAt" >= ${startsAt}
      )
      SELECT "equity", "observedAt"
      FROM (
        SELECT DISTINCT ON (bucket)
          "equity",
          "observedAt",
          bucket
        FROM samples
        ORDER BY bucket, "observedAt" DESC
      ) AS buckets
      ORDER BY "observedAt" ASC
    `);

    return rows.map((row) => ({
      equity: row.equity.toFixed(),
      observedAt: row.observedAt,
    }));
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
          stopPrice: true,
          takePrice: true,
          trailingPrice: true,
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
          entryRegime: true,
          entrySession: true,
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
          position: {
            select: { stopPrice: true, takePrice: true, trailingPrice: true },
          },
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

  public getTradeDetail(workspaceId: string, tradeId: string) {
    return this.prisma.trade.findFirst({
      where: { id: tradeId, workspaceId },
      select: {
        id: true,
        symbol: true,
        environment: true,
        side: true,
        entryRegime: true,
        entrySession: true,
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
        executionRun: {
          select: { id: true, status: true, engineVersion: true, configHash: true },
        },
        position: {
          select: {
            stopPrice: true,
            takePrice: true,
            trailingPrice: true,
            orders: {
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                clientOrderId: true,
                exchangeOrderId: true,
                side: true,
                type: true,
                status: true,
                quantity: true,
                price: true,
                createdAt: true,
                updatedAt: true,
                fills: {
                  orderBy: { filledAt: "asc" },
                  select: {
                    id: true,
                    exchangeFillId: true,
                    quantity: true,
                    price: true,
                    fee: true,
                    feeAsset: true,
                    filledAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  public listStrategies(workspaceId: string) {
    return this.prisma.strategy.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        updatedAt: true,
        activeVersion: {
          select: { id: true, version: true, configHash: true, createdAt: true },
        },
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { id: true, version: true, configHash: true, createdAt: true },
        },
        validationRuns: {
          orderBy: { queuedAt: "desc" },
          take: 1,
          select: {
            id: true,
            kind: true,
            status: true,
            verdict: true,
            completedAt: true,
            strategyVersion: { select: { version: true } },
          },
        },
        deployments: {
          orderBy: { updatedAt: "desc" },
          take: 1,
          select: {
            id: true,
            environment: true,
            status: true,
            updatedAt: true,
            strategyVersion: { select: { version: true } },
          },
        },
        _count: { select: { versions: true } },
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
