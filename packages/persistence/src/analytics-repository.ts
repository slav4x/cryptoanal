import type { CryptoAnalPrismaClient } from "./client";

export type AnalyticsTradeFilters = {
  startsAt: Date | null;
  environment: "DRY_RUN" | "DEMO" | "LIVE" | null;
  strategyId: string | null;
  symbol: string | null;
};

export class AnalyticsRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async getPerformanceDataset(workspaceId: string, filters: AnalyticsTradeFilters) {
    const where = {
      workspaceId,
      ...(filters.startsAt ? { closedAt: { gte: filters.startsAt } } : {}),
      ...(filters.environment ? { environment: filters.environment } : {}),
      ...(filters.strategyId ? { strategyVersion: { strategyId: filters.strategyId } } : {}),
      ...(filters.symbol ? { symbol: filters.symbol } : {}),
    } as const;

    const [trades, availableTrades] = await Promise.all([
      this.prisma.trade.findMany({
        where,
        orderBy: [{ closedAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          symbol: true,
          environment: true,
          entryRegime: true,
          entrySession: true,
          grossPnl: true,
          fees: true,
          funding: true,
          slippage: true,
          netPnl: true,
          exitReason: true,
          openedAt: true,
          closedAt: true,
          strategyVersion: {
            select: {
              version: true,
              strategy: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.trade.findMany({
        where: { workspaceId },
        distinct: ["strategyVersionId", "symbol", "environment"],
        select: {
          symbol: true,
          environment: true,
          strategyVersion: {
            select: { strategy: { select: { id: true, name: true } } },
          },
        },
      }),
    ]);

    const strategies = new Map<string, string>();
    const symbols = new Set<string>();
    const environments = new Set<"DRY_RUN" | "DEMO" | "LIVE">();
    for (const trade of availableTrades) {
      strategies.set(trade.strategyVersion.strategy.id, trade.strategyVersion.strategy.name);
      symbols.add(trade.symbol);
      environments.add(trade.environment);
    }

    return {
      trades: trades.map((trade) => ({
        id: trade.id,
        symbol: trade.symbol,
        environment: trade.environment,
        entryRegime: analyticsMarketRegime[trade.entryRegime],
        entrySession: analyticsTradingSession[trade.entrySession],
        grossPnl: trade.grossPnl.toNumber(),
        fees: trade.fees.toNumber(),
        funding: trade.funding.toNumber(),
        slippage: trade.slippage.toNumber(),
        netPnl: trade.netPnl.toNumber(),
        exitReason: trade.exitReason,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        strategy: {
          id: trade.strategyVersion.strategy.id,
          name: trade.strategyVersion.strategy.name,
          version: trade.strategyVersion.version,
        },
      })),
      options: {
        strategies: [...strategies.entries()]
          .map(([id, name]) => ({ id, name }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        symbols: [...symbols].sort(),
        environments: [...environments].sort(),
      },
    };
  }
}

const analyticsMarketRegime = {
  BULL: "bull",
  BEAR: "bear",
  NEUTRAL: "neutral",
  UNKNOWN: "unknown",
} as const;

const analyticsTradingSession = {
  ASIA: "asia",
  EUROPE: "europe",
  US: "us",
  OFF_HOURS: "off-hours",
  UNKNOWN: "unknown",
} as const;
