import type { CryptoAnalPrismaClient } from "./client";

export type PriceEventInput = {
  eventKey: string;
  symbol: string;
  price: string;
  observedAt: Date;
  streamId: string;
};

export class PriceEventRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async claimWriter(owner: string) {
    const claimed = await this.prisma.$queryRaw<Array<{ owner: string }>>`
      INSERT INTO "MarketStreamLease" (id, owner, "expiresAt") VALUES ('bybit', ${owner}, now() + interval '30 seconds')
      ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, "expiresAt" = EXCLUDED."expiresAt"
      WHERE "MarketStreamLease".owner = EXCLUDED.owner OR "MarketStreamLease"."expiresAt" < now()
      RETURNING owner
    `;
    return claimed.length === 1;
  }

  public async append(events: PriceEventInput[], owner: string) {
    if (events.length === 0) return [];
    // The transaction-level lock keeps ids in commit order across workers.
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('market-price-events'))`;
      await tx.$queryRaw`SELECT id FROM "MarketStreamLease" WHERE id = 'bybit' FOR UPDATE`;
      const lease = await tx.marketStreamLease.findUnique({ where: { id: "bybit" } });
      if (lease?.owner !== owner || lease.expiresAt.getTime() <= Date.now())
        throw new Error("Market writer lease lost");
      await tx.marketPriceEvent.createMany({ data: events, skipDuplicates: true });
      return tx.marketPriceEvent.findMany({
        where: { eventKey: { in: events.map((event) => event.eventKey) } },
        orderBy: { id: "asc" },
      });
    });
  }

  public after(symbol: string, eventId: bigint | null, since: Date, limit = 2000) {
    return this.prisma.marketPriceEvent.findMany({
      where: {
        symbol,
        ...(eventId === null ? { observedAt: { gte: since } } : { id: { gt: eventId } }),
      },
      orderBy: { id: "asc" },
      take: limit,
    });
  }

  public latest(symbol: string) {
    return this.prisma.marketPriceEvent.findFirst({ where: { symbol }, orderBy: { id: "desc" } });
  }

  public async prune(before: Date) {
    const oldest = await this.prisma.position.aggregate({
      where: { status: "OPEN", environment: "DRY_RUN" },
      _min: { priceEventId: true },
    });
    return this.prisma.marketPriceEvent.deleteMany({
      where: {
        observedAt: { lt: before },
        ...(oldest._min.priceEventId === null ? {} : { id: { lt: oldest._min.priceEventId } }),
      },
    });
  }
}
