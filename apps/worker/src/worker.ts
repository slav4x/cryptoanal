import { loadServerConfig } from "@cryptoanal/config";
import { BybitPublicMarketClient } from "@cryptoanal/exchange-bybit";
import { createPrismaClient, MarketDataRepository } from "@cryptoanal/persistence";
import pino from "pino";

const heartbeatIntervalMs = 15_000;
const workerId = `worker-${process.pid}`;
const config = loadServerConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const marketDataRepository = new MarketDataRepository(prisma);
const marketClient = new BybitPublicMarketClient(config.BYBIT_PUBLIC_BASE_URL);
const logger = pino({ level: config.LOG_LEVEL, name: "cryptoanal-worker" });

let stopping = false;

async function writeHeartbeat() {
  await prisma.workerHeartbeat.upsert({
    where: { workerId },
    update: {
      lastSeenAt: new Date(),
      metadata: { workspaceId: config.DEVELOPMENT_WORKSPACE_ID },
    },
    create: {
      workerId,
      service: "worker",
      version: "0.1.0",
      lastSeenAt: new Date(),
      metadata: { workspaceId: config.DEVELOPMENT_WORKSPACE_ID },
    },
  });
}

async function heartbeatLoop() {
  while (!stopping) {
    try {
      await writeHeartbeat();
    } catch (error) {
      logger.error({ err: error }, "Failed to write worker heartbeat");
    }

    await new Promise((resolve) => setTimeout(resolve, heartbeatIntervalMs));
  }
}

async function marketDataLoop() {
  while (!stopping) {
    try {
      const enabledSymbols = new Set(await marketDataRepository.listEnabledSymbols());
      const tickers = await marketClient.getLinearTickers();
      const snapshots = tickers.filter((ticker) => enabledSymbols.has(ticker.symbol));
      const inserted = await marketDataRepository.saveSnapshots(snapshots);
      logger.debug({ received: snapshots.length, inserted }, "Market snapshots updated");
    } catch (error) {
      logger.error({ err: error }, "Failed to update market snapshots");
    }

    await new Promise((resolve) => setTimeout(resolve, config.MARKET_POLL_INTERVAL_MS));
  }
}

async function candleDataLoop() {
  while (!stopping) {
    try {
      const symbols = await marketDataRepository.listEnabledSymbols();
      const results = await Promise.allSettled(
        symbols.map((symbol) => marketClient.getLinearKlines(symbol, "15", 200)),
      );
      const candles = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
      const failedSymbols = results.flatMap((result, index) =>
        result.status === "rejected" ? [symbols[index]!] : [],
      );
      const inserted = await marketDataRepository.saveCandles(candles);
      logger.debug({ received: candles.length, inserted }, "Market candles updated");
      if (failedSymbols.length > 0) {
        logger.warn({ symbols: failedSymbols }, "Some market candle requests failed");
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to update market candles");
    }

    await new Promise((resolve) => setTimeout(resolve, config.CANDLE_POLL_INTERVAL_MS));
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Shutting down worker");
  await prisma.workerHeartbeat.deleteMany({ where: { workerId } });
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

logger.info({ workerId }, "Worker started");
await Promise.all([heartbeatLoop(), marketDataLoop(), candleDataLoop()]);
