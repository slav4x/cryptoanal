import { runValidationEngine, type ValidationCandle } from "@cryptoanal/application";
import { loadServerConfig } from "@cryptoanal/config";
import {
  strategyConfigSchema,
  validationExecutionInputSchema,
  validationMetricsSchema,
} from "@cryptoanal/contracts";
import { BybitPublicMarketClient } from "@cryptoanal/exchange-bybit";
import {
  AccountSnapshotRepository,
  createPrismaClient,
  MarketDataRepository,
  ValidationRepository,
  type ClaimedValidationJob,
} from "@cryptoanal/persistence";
import pino from "pino";
import { createHash } from "node:crypto";

const heartbeatIntervalMs = 15_000;
const workerId = `worker-${process.pid}`;
const config = loadServerConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const marketDataRepository = new MarketDataRepository(prisma);
const accountSnapshotRepository = new AccountSnapshotRepository(prisma);
const validationRepository = new ValidationRepository(prisma);
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

async function accountSnapshotLoop() {
  while (!stopping) {
    try {
      const snapshot = await accountSnapshotRepository.captureDryRunSnapshot({
        workspaceId: config.DEVELOPMENT_WORKSPACE_ID,
        exchangeAccountId: config.DRY_RUN_ACCOUNT_ID,
        initialBalance: String(config.DRY_RUN_INITIAL_BALANCE),
      });
      logger.debug(
        { equity: snapshot.equity.toFixed(), observedAt: snapshot.observedAt },
        "Dry-run account snapshot updated",
      );
    } catch (error) {
      logger.error({ err: error }, "Failed to update dry-run account snapshot");
    }

    await new Promise((resolve) => setTimeout(resolve, config.ACCOUNT_SNAPSHOT_INTERVAL_MS));
  }
}

async function validationJobLoop() {
  while (!stopping) {
    let processed = false;
    try {
      const job = await validationRepository.claimNext(
        workerId,
        new Date(Date.now() - validationLeaseMs),
      );
      if (job) {
        processed = true;
        await processValidationJob(job);
      }
    } catch (error) {
      logger.error({ err: error }, "Validation worker loop failed");
    }

    if (!processed) await delay(validationPollIntervalMs);
  }
}

async function processValidationJob(job: ClaimedValidationJob) {
  try {
    const executionInput = validationExecutionInputSchema.parse(job.input);
    const strategyConfig = strategyConfigSchema.parse(job.config);
    if (executionInput.kind === "holdout") {
      throw new ValidationWorkerError(
        "UNSUPPORTED_VALIDATION_KIND",
        "Holdout пока не поддерживается",
      );
    }
    if (
      executionInput.dataset.timeframe !== strategyConfig.universe.timeframe ||
      executionInput.dataset.symbols.some(
        (symbol) => !strategyConfig.universe.symbols.includes(symbol),
      )
    ) {
      throw new ValidationWorkerError(
        "DATASET_CONFIG_MISMATCH",
        "Параметры датасета не соответствуют версии стратегии",
      );
    }

    const symbols = [...new Set(executionInput.dataset.symbols)].sort();
    const enabledSymbols = new Set(await marketDataRepository.listEnabledSymbols());
    const unknownSymbols = symbols.filter((symbol) => !enabledSymbols.has(symbol));
    if (unknownSymbols.length > 0) {
      throw new ValidationWorkerError(
        "UNKNOWN_MARKET_INSTRUMENT",
        `Пары отсутствуют в каталоге рынков: ${unknownSymbols.join(", ")}`,
      );
    }

    const interval = bybitIntervals[executionInput.dataset.timeframe];
    const intervalMs = timeframeMinutes[executionInput.dataset.timeframe] * 60_000;
    const startTime = new Date(`${executionInput.dataset.startDate}T00:00:00.000Z`);
    const requestedEnd = new Date(`${executionInput.dataset.endDate}T23:59:59.999Z`);
    const lastCompleteCandleEnd = Math.floor(Date.now() / intervalMs) * intervalMs - 1;
    const endTime = new Date(Math.min(requestedEnd.getTime(), lastCompleteCandleEnd));
    if (endTime <= startTime) {
      throw new ValidationWorkerError(
        "DATASET_EMPTY",
        "Выбранный период не содержит завершённых свечей",
      );
    }

    const estimatedCandles =
      Math.ceil((endTime.getTime() - startTime.getTime()) / intervalMs) * symbols.length;
    if (estimatedCandles > maximumDatasetCandles) {
      throw new ValidationWorkerError(
        "DATASET_TOO_LARGE",
        `Расчётный объём ${estimatedCandles} свечей превышает лимит ${maximumDatasetCandles}`,
      );
    }

    const candles: ValidationCandle[] = [];
    const datasetHasher = createHash("sha256");
    let datasetAsOf = startTime;
    for (const [index, symbol] of symbols.entries()) {
      let marketCandles;
      try {
        marketCandles = await marketClient.getLinearKlinesRange(
          symbol,
          interval,
          startTime,
          endTime,
        );
      } catch (error) {
        throw new ValidationWorkerError(
          "DATASET_FETCH_FAILED",
          `Не удалось загрузить ${symbol}: ${errorMessage(error)}`,
        );
      }

      const requiredCandles = minimumRequiredCandles(strategyConfig);
      if (marketCandles.length < requiredCandles) {
        throw new ValidationWorkerError(
          "DATASET_INSUFFICIENT",
          `Для ${symbol} получено ${marketCandles.length} свечей, требуется минимум ${requiredCandles}`,
        );
      }
      if (candles.length + marketCandles.length > maximumDatasetCandles) {
        throw new ValidationWorkerError(
          "DATASET_TOO_LARGE",
          `Фактический объём превышает лимит ${maximumDatasetCandles} свечей`,
        );
      }

      for (const candle of marketCandles) {
        datasetHasher.update(
          [
            candle.symbol,
            candle.interval,
            candle.openTime.toISOString(),
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            candle.volume,
            candle.turnover,
          ].join("|"),
        );
        datasetHasher.update("\n");
        candles.push({
          symbol: candle.symbol,
          openTime: candle.openTime,
          open: finiteNumber(candle.open, "open", symbol),
          high: finiteNumber(candle.high, "high", symbol),
          low: finiteNumber(candle.low, "low", symbol),
          close: finiteNumber(candle.close, "close", symbol),
          turnover: finiteNumber(candle.turnover, "turnover", symbol),
        });
        if (candle.openTime > datasetAsOf) datasetAsOf = candle.openTime;
      }
      for (let offset = 0; offset < marketCandles.length; offset += persistenceBatchSize) {
        await marketDataRepository.saveCandles(
          marketCandles.slice(offset, offset + persistenceBatchSize),
        );
      }
      const leaseKept = await validationRepository.updateProgress(
        job.jobId,
        workerId,
        5 + ((index + 1) / symbols.length) * 65,
      );
      if (!leaseKept) {
        throw new ValidationWorkerError("JOB_LEASE_LOST", "Worker потерял lease задачи");
      }
    }

    if (candles.length === 0) {
      throw new ValidationWorkerError("DATASET_EMPTY", "Bybit не вернул свечи за выбранный период");
    }
    const leaseKept = await validationRepository.updateProgress(job.jobId, workerId, 75);
    if (!leaseKept) {
      throw new ValidationWorkerError("JOB_LEASE_LOST", "Worker потерял lease задачи");
    }
    const result = runValidationEngine({
      config: strategyConfig,
      candles,
      initialCapital: Number(executionInput.initialCapital),
      kind: executionInput.kind,
      walkForward: executionInput.walkForward,
    });
    const datasetHash = datasetHasher.digest("hex");
    const metrics = validationMetricsSchema.parse({
      ...result.metrics,
      gateReasons: result.gateReasons,
      provenance: {
        datasetHash,
        symbols,
        timeframe: executionInput.dataset.timeframe,
        startDate: executionInput.dataset.startDate,
        endDate: executionInput.dataset.endDate,
        candleCount: candles.length,
      },
    });
    await validationRepository.complete({
      workerId,
      jobId: job.jobId,
      runId: job.runId,
      workspaceId: job.workspaceId,
      datasetId: `market-candles:sha256:${datasetHash}`,
      datasetAsOf,
      metrics,
      verdict: persistedVerdicts[result.verdict],
      trades: result.trades.map((trade) => ({
        symbol: trade.symbol,
        side: trade.side === "long" ? "BUY" : "SELL",
        openedAt: new Date(trade.openedAt),
        closedAt: new Date(trade.closedAt),
        entryPrice: String(trade.entryPrice),
        exitPrice: String(trade.exitPrice),
        quantity: String(trade.quantity),
        netPnl: String(trade.netPnl),
        fees: String(trade.fees),
        exitReason: trade.exitReason,
      })),
    });
    logger.info(
      {
        jobId: job.jobId,
        runId: job.runId,
        verdict: result.verdict,
        candles: candles.length,
        trades: result.metrics.trades,
      },
      "Validation job completed",
    );
  } catch (error) {
    const failure = validationFailure(error);
    try {
      await validationRepository.fail({
        workerId,
        jobId: job.jobId,
        runId: job.runId,
        workspaceId: job.workspaceId,
        failureCode: failure.code,
        failureMessage: failure.message,
      });
    } catch (persistenceError) {
      logger.error(
        { err: persistenceError, jobId: job.jobId, originalError: error },
        "Failed to persist validation failure",
      );
      return;
    }
    logger.error({ err: error, jobId: job.jobId, runId: job.runId }, "Validation job failed");
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

class ValidationWorkerError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function validationFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ValidationWorkerError) {
    return { code: error.code, message: error.message.slice(0, 500) };
  }
  return { code: "VALIDATION_ENGINE_FAILED", message: errorMessage(error).slice(0, 500) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function finiteNumber(value: string, field: string, symbol: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ValidationWorkerError(
      "DATASET_INVALID_CANDLE",
      `Некорректное поле ${field} у свечи ${symbol}`,
    );
  }
  return parsed;
}

function minimumRequiredCandles(config: {
  universe: { timeframe: keyof typeof timeframeMinutes };
  signal: { emaSlowPeriod: number; rsiPeriod: number };
}): number {
  const volumeBars = Math.round(1_440 / timeframeMinutes[config.universe.timeframe]);
  return Math.max(config.signal.emaSlowPeriod + 2, config.signal.rsiPeriod + 2, volumeBars + 2, 16);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const validationPollIntervalMs = 2_000;
const validationLeaseMs = 5 * 60_000;
const maximumDatasetCandles = 250_000;
const persistenceBatchSize = 2_000;
const timeframeMinutes = { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 } as const;
const bybitIntervals: Record<keyof typeof timeframeMinutes, string> = {
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "4h": "240",
};
const persistedVerdicts = {
  passed: "PASSED",
  failed: "FAILED",
  warning: "WARNING",
} as const;

logger.info({ workerId }, "Worker started");
await Promise.all([
  heartbeatLoop(),
  marketDataLoop(),
  candleDataLoop(),
  accountSnapshotLoop(),
  validationJobLoop(),
]);
