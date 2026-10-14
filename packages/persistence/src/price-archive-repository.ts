import { Prisma } from "./generated/prisma/client";
import type { CryptoAnalPrismaClient } from "./client";
import {
  encodePriceArchive,
  decodePriceArchive,
  type ArchivedPriceEvent,
} from "./price-archive-codec";

export class PriceArchiveRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async archiveAndPrune(before: Date, limit = 10_000) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error("Invalid archive batch size");
    return this.prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<Array<{ owned: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext('market-price-archive')) AS owned`;
        if (!lock?.owned) return { count: 0, archived: 0, rawBytes: 0, compressedBytes: 0 };
        const [positions, pending] = await Promise.all([
          tx.position.aggregate({
            where: { status: "OPEN", environment: "DRY_RUN" },
            _min: { priceEventId: true },
          }),
          tx.runtimeCursor.aggregate({
            where: { pendingSignal: { not: Prisma.DbNull }, executionRun: { status: "RUNNING" } },
            _min: { pendingPriceEventId: true },
          }),
        ]);
        const cursors = [positions._min.priceEventId, pending._min.pendingPriceEventId].filter(
          (id): id is bigint => id !== null,
        );
        const oldest = cursors.reduce<bigint | null>(
          (minimum, id) => (minimum === null || id < minimum ? id : minimum),
          null,
        );
        const batch = await tx.marketPriceEvent.findMany({
          where: {
            observedAt: { lt: before },
            ...(oldest === null ? {} : { id: { lt: oldest } }),
          },
          orderBy: { id: "asc" },
          take: limit,
        });
        if (!batch.length) return { count: 0, archived: 0, rawBytes: 0, compressedBytes: 0 };
        const traces = await tx.positionExecutionTrace.findMany({
          where: {
            symbol: { in: [...new Set(batch.map((event) => event.symbol))] },
            startEventId: { lte: batch.at(-1)!.id },
            OR: [{ retainUntil: null }, { retainUntil: { gt: new Date() } }],
          },
          select: { symbol: true, startEventId: true, endEventId: true },
        });
        const groups = new Map<string, ArchivedPriceEvent[]>();
        for (const event of batch) {
          if (
            !traces.some(
              (trace) =>
                trace.symbol === event.symbol &&
                event.id >= trace.startEventId &&
                (trace.endEventId === null || event.id <= trace.endEventId),
            )
          )
            continue;
          const group = groups.get(event.symbol) ?? [];
          group.push({ ...event, price: event.price.toFixed() });
          groups.set(event.symbol, group);
        }
        let archived = 0,
          rawBytes = 0,
          compressedBytes = 0;
        for (const group of groups.values()) {
          const encoded = await encodePriceArchive(group);
          const { rawBytes: bytes, ...data } = encoded;
          // Archive and removal commit together; a failed compression/write leaves the journal intact.
          await tx.marketPriceArchiveChunk.create({ data });
          archived += group.length;
          rawBytes += bytes;
          compressedBytes += data.payload.byteLength;
        }
        const removed = await tx.marketPriceEvent.deleteMany({
          where: { id: { in: batch.map((event) => event.id) } },
        });
        return { count: removed.count, archived, rawBytes, compressedBytes };
      },
      { timeout: 30_000 },
    );
  }

  public async after(symbol: string, cursor: bigint, through: bigint, limit = 2000) {
    const [hot, chunks] = await this.prisma.$transaction(
      [
        this.prisma.marketPriceEvent.findMany({
          where: { symbol, id: { gt: cursor, lte: through } },
          orderBy: { id: "asc" },
          take: limit,
        }),
        this.prisma.marketPriceArchiveChunk.findMany({
          where: { symbol, firstEventId: { lte: through }, lastEventId: { gt: cursor } },
          orderBy: { firstEventId: "asc" },
          take: 8,
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const upper =
      chunks.length === 8 && chunks.at(-1)!.lastEventId < through
        ? chunks.at(-1)!.lastEventId
        : through;
    const events = new Map<bigint, ArchivedPriceEvent>();
    for (const chunk of chunks)
      for (const event of decodePriceArchive(chunk)) {
        if (event.id > cursor && event.id <= upper) events.set(event.id, event);
      }
    for (const event of hot) {
      if (event.id > upper) continue;
      const normalized = { ...event, price: event.price.toFixed() };
      const previous = events.get(event.id);
      if (
        previous &&
        (previous.price !== normalized.price ||
          previous.streamId !== normalized.streamId ||
          +previous.observedAt !== +normalized.observedAt ||
          +previous.receivedAt !== +normalized.receivedAt)
      )
        throw new Error("Conflicting hot/archive price event");
      events.set(event.id, normalized);
    }
    return [...events.values()]
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .slice(0, limit);
  }

  public async cleanup() {
    return this.prisma.$transaction(async (tx) => {
      const chunks = await tx.$executeRaw`
        DELETE FROM "MarketPriceArchiveChunk" c WHERE NOT EXISTS (
          SELECT 1 FROM "PositionExecutionTrace" t WHERE t.symbol=c.symbol
          AND t."startEventId"<=c."lastEventId" AND (t."endEventId" IS NULL OR t."endEventId">=c."firstEventId")
          AND (t."retainUntil" IS NULL OR t."retainUntil">clock_timestamp())
        )`;
      const records = await tx.positionTraceRecord.deleteMany({
        where: { trace: { retainUntil: { lte: new Date() } } },
      });
      return { chunks, records: records.count };
    });
  }
}
