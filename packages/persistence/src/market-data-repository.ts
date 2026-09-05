import type { CryptoAnalPrismaClient } from "./client";

export type MarketSnapshotInput = {
  symbol: string;
  price: string;
  change24hPercent: string;
  volume24h: string;
  observedAt: Date;
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
}
