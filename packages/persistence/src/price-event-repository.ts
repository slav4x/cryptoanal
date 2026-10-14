import { PriceArchiveRepository } from "./price-archive-repository";
import type { CryptoAnalPrismaClient } from "./client";
import {
  readExecutionMarketData,
  type StoredExecutionMarketData,
} from "../../application/src/execution-market-data";

export type PriceEventInput = {
  eventKey: string;
  symbol: string;
  price: string;
  observedAt: Date;
  streamId: string;
  receivedAt?: Date;
  executionData?: StoredExecutionMarketData;
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
    for (const event of events) {
      if (!event.executionData) continue;
      const data = readExecutionMarketData(event.executionData);
      if (
        !event.receivedAt ||
        !Number.isFinite(+event.receivedAt) ||
        (data.book &&
          (data.book.observedAt > +event.observedAt || data.book.receivedAt > +event.receivedAt))
      )
        throw new Error("Execution market data requires causal receive times");
    }
    // The transaction-level lock keeps ids in commit order across workers.
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('market-price-events'))`;
      await tx.$queryRaw`SELECT id FROM "MarketStreamLease" WHERE id = 'bybit' FOR UPDATE`;
      const lease = await tx.marketStreamLease.findUnique({ where: { id: "bybit" } });
      if (lease?.owner !== owner || lease.expiresAt.getTime() <= Date.now())
        throw new Error("Market writer lease lost");
      await tx.marketPriceEvent.createMany({ data: events, skipDuplicates: true });
      const saved = await tx.marketPriceEvent.findMany({
        where: { eventKey: { in: events.map((event) => event.eventKey) } },
        orderBy: { id: "asc" },
      });
      const byKey = new Map(saved.map((event) => [event.eventKey, event]));
      for (const event of events) {
        const stored = byKey.get(event.eventKey)!;
        if (
          stored.symbol !== event.symbol ||
          !stored.price.eq(event.price) ||
          +stored.observedAt !== +event.observedAt ||
          (stored.executionData &&
            event.executionData &&
            JSON.stringify(readExecutionMarketData(stored.executionData).trade) !==
              JSON.stringify(readExecutionMarketData(event.executionData).trade))
        )
          throw new Error("Conflicting duplicate public trade");
      }
      return saved;
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
    return new PriceArchiveRepository(this.prisma).archiveAndPrune(before);
  }
}
