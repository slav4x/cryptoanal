import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";

export type MarketSnapshotInput = {
  symbol: string;
  price: string;
  change24hPercent: string;
  volume24h: string;
  observedAt: Date;
};

export type MarketCandleInput = {
  isClosed: boolean;
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
      where: {
        enabled: true,
        status: "Trading",
        workspaceMarkets: { some: {} },
      },
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

    const unique = new Map<string, MarketCandleInput>();
    for (const candle of candles) {
      const key = `${candle.symbol}:${candle.interval}:${candle.openTime.toISOString()}`;
      const existing = unique.get(key);
      if (!existing?.isClosed || candle.isClosed) unique.set(key, candle);
    }
    return this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "MarketCandle" ("symbol", "interval", "openTime", "open", "high", "low", "close", "volume", "turnover", "isClosed")
      SELECT "symbol", "interval", "openTime", "open", "high", "low", "close", "volume", "turnover", "isClosed"
      FROM jsonb_to_recordset(${JSON.stringify([...unique.values()])}::jsonb)
      AS candle("symbol" text, "interval" text, "openTime" timestamptz, "open" numeric, "high" numeric,
        "low" numeric, "close" numeric, "volume" numeric, "turnover" numeric, "isClosed" boolean)
      ON CONFLICT ("symbol", "interval", "openTime") DO UPDATE SET
        "open" = EXCLUDED."open", "high" = EXCLUDED."high", "low" = EXCLUDED."low",
        "close" = EXCLUDED."close", "volume" = EXCLUDED."volume", "turnover" = EXCLUDED."turnover",
        "isClosed" = EXCLUDED."isClosed"
      WHERE (NOT "MarketCandle"."isClosed" OR EXCLUDED."isClosed")
        AND ("MarketCandle"."open", "MarketCandle"."high", "MarketCandle"."low", "MarketCandle"."close",
          "MarketCandle"."volume", "MarketCandle"."turnover", "MarketCandle"."isClosed")
        IS DISTINCT FROM (EXCLUDED."open", EXCLUDED."high", EXCLUDED."low", EXCLUDED."close",
          EXCLUDED."volume", EXCLUDED."turnover", EXCLUDED."isClosed")
    `);
  }
}
