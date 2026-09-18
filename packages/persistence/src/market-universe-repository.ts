import type { CryptoAnalPrismaClient } from "./client";
import type { Prisma } from "./generated/prisma/client";

export type MarketUniverseInstrumentInput = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  settleAsset: string;
  exchange: "bybit";
  instrumentType: "linear-perpetual";
  contractType: string;
  status: string;
  tickSize: string;
  qtyStep: string;
  minOrderQty: string;
  minNotional: string;
};

export class MarketUniverseInstrumentConflictError extends Error {}
export class MarketUniverseMarketNotFoundError extends Error {}
export class MarketUniverseMarketInUseError extends Error {
  public constructor(
    message: string,
    public readonly blockers: string[],
  ) {
    super(message);
  }
}

export class MarketUniverseRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async listSymbols(workspaceId: string): Promise<string[]> {
    const markets = await this.prisma.workspaceMarket.findMany({
      where: { workspaceId },
      orderBy: [{ position: "asc" }, { symbol: "asc" }],
      select: { symbol: true },
    });
    return markets.map(({ symbol }) => symbol);
  }

  public async addMarkets(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    instruments: MarketUniverseInstrumentInput[];
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const symbols = input.instruments.map(({ symbol }) => symbol);
      const [knownInstruments, existingMarkets, lastMarket] = await Promise.all([
        transaction.marketInstrument.findMany({
          where: { symbol: { in: symbols } },
          select: { symbol: true, exchange: true, instrumentType: true },
        }),
        transaction.workspaceMarket.findMany({
          where: { workspaceId: input.workspaceId, symbol: { in: symbols } },
          select: { symbol: true },
        }),
        transaction.workspaceMarket.findFirst({
          where: { workspaceId: input.workspaceId },
          orderBy: { position: "desc" },
          select: { position: true },
        }),
      ]);

      const requestedBySymbol = new Map(
        input.instruments.map((instrument) => [instrument.symbol, instrument]),
      );
      for (const known of knownInstruments) {
        const requested = requestedBySymbol.get(known.symbol)!;
        if (
          known.exchange !== requested.exchange ||
          known.instrumentType !== requested.instrumentType
        ) {
          throw new MarketUniverseInstrumentConflictError(
            `Инструмент ${known.symbol} уже зарегистрирован для другого рынка`,
          );
        }
      }

      const syncedAt = new Date();
      for (const instrument of input.instruments) {
        await transaction.marketInstrument.upsert({
          where: { symbol: instrument.symbol },
          update: {
            baseAsset: instrument.baseAsset,
            quoteAsset: instrument.quoteAsset,
            settleAsset: instrument.settleAsset,
            contractType: instrument.contractType,
            status: instrument.status,
            tickSize: instrument.tickSize,
            qtyStep: instrument.qtyStep,
            minOrderQty: instrument.minOrderQty,
            minNotional: instrument.minNotional,
            enabled: instrument.status === "Trading",
            metadataSyncedAt: syncedAt,
          },
          create: {
            ...instrument,
            enabled: instrument.status === "Trading",
            metadataSyncedAt: syncedAt,
          },
        });
      }

      const existing = new Set(existingMarkets.map(({ symbol }) => symbol));
      const added = input.instruments.filter(({ symbol }) => !existing.has(symbol));
      const firstPosition = (lastMarket?.position ?? -1) + 1;
      if (added.length > 0) {
        await transaction.workspaceMarket.createMany({
          data: added.map((instrument, index) => ({
            workspaceId: input.workspaceId,
            symbol: instrument.symbol,
            position: firstPosition + index,
            addedByActorId: input.actorId,
          })),
        });
        await transaction.auditEvent.create({
          data: {
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            action: "market.universe.add",
            resourceType: "workspace-market",
            resourceId: added.map(({ symbol }) => symbol).join(","),
            outcome: "COMPLETED",
            requestId: input.requestId,
            metadata: {
              exchange: "bybit",
              instrumentType: "linear-perpetual",
              symbols: added.map(({ symbol }) => symbol),
            },
          },
        });
      }

      return {
        added: added.map(({ symbol }) => symbol),
        existing: input.instruments
          .filter(({ symbol }) => existing.has(symbol))
          .map(({ symbol }) => symbol),
      };
    });
  }

  public async removeMarket(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    symbol: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const membership = await transaction.workspaceMarket.findUnique({
        where: {
          workspaceId_symbol: { workspaceId: input.workspaceId, symbol: input.symbol },
        },
        select: { symbol: true },
      });
      if (!membership) throw new MarketUniverseMarketNotFoundError("Пара отсутствует в рынке");

      const [openPositions, activeDeployments] = await Promise.all([
        transaction.position.count({
          where: {
            workspaceId: input.workspaceId,
            symbol: input.symbol,
            status: { not: "CLOSED" },
          },
        }),
        transaction.deployment.findMany({
          where: {
            workspaceId: input.workspaceId,
            status: { in: ["READY", "RUNNING", "PAUSED"] },
          },
          select: {
            strategy: { select: { name: true } },
            strategyVersion: { select: { config: true } },
          },
        }),
      ]);

      const strategyBlockers = activeDeployments
        .filter((deployment) =>
          readStrategySymbols(deployment.strategyVersion.config).includes(input.symbol),
        )
        .map((deployment) => deployment.strategy.name);
      const blockers = [
        ...(openPositions > 0 ? [`Открытые позиции: ${openPositions}`] : []),
        ...strategyBlockers.map((name) => `Активная стратегия: ${name}`),
      ];
      if (blockers.length > 0) {
        throw new MarketUniverseMarketInUseError(
          `Нельзя удалить ${input.symbol}, пока пара используется`,
          blockers,
        );
      }

      await transaction.watchlistItem.deleteMany({
        where: { workspaceId: input.workspaceId, symbol: input.symbol },
      });
      await transaction.workspaceMarket.delete({
        where: {
          workspaceId_symbol: { workspaceId: input.workspaceId, symbol: input.symbol },
        },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "market.universe.remove",
          resourceType: "workspace-market",
          resourceId: input.symbol,
          outcome: "COMPLETED",
          requestId: input.requestId,
          metadata: { symbol: input.symbol },
        },
      });
    });
  }
}

function readStrategySymbols(config: Prisma.JsonValue): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const universe = config.universe;
  if (!universe || typeof universe !== "object" || Array.isArray(universe)) return [];
  return Array.isArray(universe.symbols)
    ? universe.symbols.filter((symbol): symbol is string => typeof symbol === "string")
    : [];
}
