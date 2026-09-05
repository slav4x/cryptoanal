import type { CryptoAnalPrismaClient } from "./client";

export type MarketSnapshotInput = {
  symbol: string;
  price: string;
  change24hPercent: string;
  volume24h: string;
  observedAt: Date;
};

export type MarketCandleInput = {
  symbol: string;
  interval: string;
  openTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  turnover: string;
};

export class MarketDataRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async listEnabledSymbols(): Promise<string[]> {
    const instruments = await this.prisma.marketInstrument.findMany({
      where: { enabled: true },
      select: { symbol: true },
    });
    return instruments.map(({ symbol }) => symbol);
  }

  public async saveSnapshots(snapshots: MarketSnapshotInput[]): Promise<number> {
    if (snapshots.length === 0) return 0;
    const result = await this.prisma.marketSnapshot.createMany({
      data: snapshots.map((snapshot) => ({ ...snapshot, regime: "unknown" })),
      skipDuplicates: true,
    });
    return result.count;
  }

  public async saveCandles(candles: MarketCandleInput[]): Promise<number> {
    if (candles.length === 0) return 0;

    const result = await this.prisma.marketCandle.createMany({
      data: candles,
      skipDuplicates: true,
    });

    const latestBySeries = new Map<string, MarketCandleInput>();
    for (const candle of candles) {
      const key = `${candle.symbol}:${candle.interval}`;
      const current = latestBySeries.get(key);
      if (!current || current.openTime < candle.openTime) latestBySeries.set(key, candle);
    }

    await this.prisma.$transaction(
      [...latestBySeries.values()].map((candle) =>
        this.prisma.marketCandle.update({
          where: {
            symbol_interval_openTime: {
              symbol: candle.symbol,
              interval: candle.interval,
              openTime: candle.openTime,
            },
          },
          data: {
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            turnover: candle.turnover,
          },
        }),
      ),
    );

    return result.count;
  }
}
