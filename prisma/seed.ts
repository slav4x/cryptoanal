import "dotenv/config";
import { createPrismaClient } from "../packages/persistence/src/client";

const workspaceId = process.env.DEVELOPMENT_WORKSPACE_ID ?? "development";

const instruments = [
  ["BTCUSDT", "BTC"],
  ["ETHUSDT", "ETH"],
  ["SOLUSDT", "SOL"],
  ["XRPUSDT", "XRP"],
  ["DOGEUSDT", "DOGE"],
  ["NEARUSDT", "NEAR"],
  ["LINKUSDT", "LINK"],
  ["AVAXUSDT", "AVAX"],
] as const;

const prisma = createPrismaClient();

await prisma.workspace.upsert({
  where: { id: workspaceId },
  update: { name: "CryptoAnal Development" },
  create: {
    id: workspaceId,
    slug: "development",
    name: "CryptoAnal Development",
    settings: { create: {} },
  },
});

for (const [position, [symbol, baseAsset]] of instruments.entries()) {
  await prisma.marketInstrument.upsert({
    where: { symbol },
    update: { enabled: true },
    create: {
      symbol,
      baseAsset,
      quoteAsset: "USDT",
      exchange: "bybit",
      instrumentType: "linear-perpetual",
    },
  });

  await prisma.watchlistItem.upsert({
    where: { workspaceId_symbol: { workspaceId, symbol } },
    update: { position },
    create: { workspaceId, symbol, position },
  });
}

await prisma.$disconnect();
