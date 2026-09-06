import {
  enrichExecutionCandles,
  evaluateHealth,
  evaluateExecutionExit,
  executionUnrealizedPnl,
  getExecutionSignal,
  getExecutionMarketRegime,
  getExecutionTradingSession,
  getTradingDateKey,
  minimumExecutionCandleCount,
  openExecutionPosition,
  runValidationEngine,
  updateExecutionTrailing,
  type ExecutionPosition,
  type ExecutionSettlement,
  type PendingExecutionSignal,
  type ValidationCandle,
} from "@cryptoanal/application";
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
  HealthRepository,
  MarketDataRepository,
  RuntimeRepository,
  RuntimeStateConflictError,
  ValidationDatasetConflictError,
  ValidationRepository,
  type ClaimedValidationJob,
  type ValidationDatasetCandlePersistenceInput,
} from "@cryptoanal/persistence";
import pino from "pino";

const heartbeatIntervalMs = 15_000;
const workerId = `worker-${process.pid}`;
const watchdogId = `${workerId}:watchdog`;
const config = loadServerConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const marketDataRepository = new MarketDataRepository(prisma);
const accountSnapshotRepository = new AccountSnapshotRepository(prisma);
const validationRepository = new ValidationRepository(prisma);
const runtimeRepository = new RuntimeRepository(prisma);
const healthRepository = new HealthRepository(prisma);
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
      const requirements = new Map<string, { symbol: string; interval: string; limit: number }>();
      for (const symbol of symbols) {
        requirements.set(`${symbol}:15`, { symbol, interval: "15", limit: 200 });
      }
      const runtimeTargets = await runtimeRepository.listActiveTargets(
        config.DEVELOPMENT_WORKSPACE_ID,
      );
      for (const target of runtimeTargets) {
        const strategyConfig = strategyConfigSchema.parse(target.strategyVersion.config);
        const interval = bybitIntervals[strategyConfig.universe.timeframe];
        const limit = Math.min(1_000, minimumExecutionCandleCount(strategyConfig) + 1);
        for (const symbol of strategyConfig.universe.symbols) {
          const key = `${symbol}:${interval}`;
          const current = requirements.get(key);
          requirements.set(key, {
            symbol,
            interval,
            limit: Math.max(current?.limit ?? 0, limit),
          });
        }
      }
      const requestedSeries = [...requirements.values()];
      const results = await Promise.allSettled(
        requestedSeries.map((series) =>
          marketClient.getLinearKlines(series.symbol, series.interval, series.limit),
        ),
      );
      const candles = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
      const failedSeries = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [`${requestedSeries[index]!.symbol}:${requestedSeries[index]!.interval}`]
          : [],
      );
      const inserted = await marketDataRepository.saveCandles(candles);
      logger.debug({ received: candles.length, inserted }, "Market candles updated");
      if (failedSeries.length > 0) {
        logger.warn({ series: failedSeries }, "Some market candle requests failed");
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

async function runtimeLoop() {
  while (!stopping) {
    try {
      const targets = await runtimeRepository.listActiveTargets(config.DEVELOPMENT_WORKSPACE_ID);
      for (const target of targets) {
        await processRuntimeTarget(target);
      }
    } catch (error) {
      logger.error({ err: error }, "Runtime worker loop failed");
    }

    await delay(config.RUNTIME_POLL_INTERVAL_MS);
  }
}

async function watchdogLoop() {
  await delay(1_000);
  while (!stopping) {
    try {
      const now = new Date();
      const signals = await healthRepository.getSignals(config.DEVELOPMENT_WORKSPACE_ID, now);
      const health = evaluateHealth({
        ...signals,
        now,
        initialCapital: config.DRY_RUN_INITIAL_BALANCE,
        thresholds: healthThresholds(),
        driftCandidates: signals.driftCandidates.map((candidate) => ({
          ...candidate,
          environment: tradingEnvironment[candidate.environment],
        })),
      });
      await healthRepository.syncIncidents(config.DEVELOPMENT_WORKSPACE_ID, health.conditions, now);
      await prisma.workerHeartbeat.upsert({
        where: { workerId: watchdogId },
        update: { lastSeenAt: now, metadata: { workspaceId: config.DEVELOPMENT_WORKSPACE_ID } },
        create: {
          workerId: watchdogId,
          service: "watchdog",
          version: "0.1.0",
          lastSeenAt: now,
          metadata: { workspaceId: config.DEVELOPMENT_WORKSPACE_ID },
        },
      });
      logger.debug(
        { status: health.overallStatus, incidents: health.conditions.length },
        "Watchdog cycle completed",
      );
    } catch (error) {
      logger.error({ err: error }, "Watchdog cycle failed");
    }

    await delay(config.WATCHDOG_INTERVAL_MS);
  }
}

async function processRuntimeTarget(
  target: Awaited<ReturnType<RuntimeRepository["listActiveTargets"]>>[number],
) {
  if (target.status !== "RUNNING" && target.status !== "PAUSED") return;
  const executionRun = target.executionRuns[0];
  if (!executionRun) return;
  const strategyConfig = strategyConfigSchema.parse(target.strategyVersion.config);
  const interval = bybitIntervals[strategyConfig.universe.timeframe];
  const intervalMs = timeframeMinutes[strategyConfig.universe.timeframe] * 60_000;
  const lastCompleteCandleAt = new Date(
    Math.floor(Date.now() / intervalMs) * intervalMs - intervalMs,
  );
  const candleLimit = minimumExecutionCandleCount(strategyConfig);

  for (const symbol of [...strategyConfig.universe.symbols].sort()) {
    try {
      const state = await runtimeRepository.getCycleState({
        workspaceId: target.workspaceId,
        executionRunId: executionRun.id,
        symbol,
        interval,
        lastCompleteCandleAt,
        candleLimit,
      });
      const latest = state.candles.at(-1);
      if (!latest || state.candles.length < candleLimit) {
        throw new RuntimeWorkerError(
          "RUNTIME_CANDLES_INSUFFICIENT",
          `Для ${symbol} недостаточно завершённых свечей: ${state.candles.length}/${candleLimit}`,
        );
      }
      if (state.cursor?.lastEvaluatedAt && state.cursor.lastEvaluatedAt >= latest.openTime)
        continue;

      const candles = enrichExecutionCandles(
        state.candles.map((candle) => ({
          symbol: candle.symbol,
          openTime: candle.openTime,
          open: candle.open.toNumber(),
          high: candle.high.toNumber(),
          low: candle.low.toNumber(),
          close: candle.close.toNumber(),
          turnover: candle.turnover.toNumber(),
        })),
        strategyConfig,
      );
      const candle = candles.at(-1)!;
      const existingPosition = state.position ? deserializeExecutionPosition(state.position) : null;
      const pendingSignal = parsePendingSignal(state.cursor?.pendingSignal ?? null);
      const equity = await runtimeRepository.getDryRunEquity(
        target.workspaceId,
        String(config.DRY_RUN_INITIAL_BALANCE),
      );
      const tradingDay = getTradingDateKey(candle.openTime, strategyConfig.schedule.timezone);
      const dailyPnl = state.recentTrades
        .filter(
          (trade) =>
            getTradingDateKey(trade.closedAt, strategyConfig.schedule.timezone) === tradingDay,
        )
        .reduce((sum, trade) => sum + trade.netPnl.toNumber(), 0);
      const lossLimit =
        config.DRY_RUN_INITIAL_BALANCE * (strategyConfig.risk.maxDailyLossPercent / 100);
      const entriesAllowed = target.status === "RUNNING" && dailyPnl > -lossLimit;

      let positionAction: Parameters<RuntimeRepository["persistCycle"]>[0]["positionAction"] = {
        kind: "none",
      };
      let decision: Parameters<RuntimeRepository["persistCycle"]>[0]["decision"] = {
        action: target.status === "PAUSED" ? "SKIP" : "HOLD",
        reasonCode: target.status === "PAUSED" ? "DEPLOYMENT_PAUSED" : "NO_SIGNAL",
        summary:
          target.status === "PAUSED"
            ? "Новые входы отключены: deployment на паузе"
            : "Условий для действия нет",
        factors: runtimeFactors(candle, dailyPnl, equity),
      };
      let pendingSignalAfter: PendingExecutionSignal | null = null;
      let positionRemainsOpen = existingPosition !== null;

      if (existingPosition && state.position) {
        const settlement = evaluateExecutionExit(existingPosition, candle, strategyConfig);
        if (settlement) {
          positionAction = {
            kind: "close",
            positionId: state.position.id,
            settlement: serializeSettlement(settlement),
          };
          decision = {
            action: "CLOSE",
            reasonCode: settlement.exitReason.toUpperCase().replaceAll("-", "_"),
            summary: `Позиция закрыта: ${settlement.exitReason}`,
            factors: runtimeFactors(candle, dailyPnl, equity),
          };
          positionRemainsOpen = false;
        } else {
          const updated = updateExecutionTrailing(existingPosition, candle, strategyConfig);
          positionAction = {
            kind: "update",
            positionId: state.position.id,
            markPrice: String(candle.close),
            unrealizedPnl: String(executionUnrealizedPnl(updated, candle.close)),
            bestPrice: String(updated.bestPrice),
            trailingPrice: updated.trailingPrice === null ? null : String(updated.trailingPrice),
          };
          decision = {
            action: "HOLD",
            reasonCode: "POSITION_MANAGED",
            summary: "Позиция остаётся открытой, защитные уровни обновлены",
            factors: runtimeFactors(candle, dailyPnl, equity),
          };
        }
      } else if (pendingSignal && entriesAllowed) {
        const opened = openExecutionPosition(
          pendingSignal,
          candle,
          equity,
          Math.max(0, equity) / strategyConfig.risk.maxOpenPositions,
          strategyConfig,
        );
        if (opened) {
          const settlement = evaluateExecutionExit(opened, candle, strategyConfig);
          const updated = settlement
            ? opened
            : updateExecutionTrailing(opened, candle, strategyConfig);
          positionAction = {
            kind: "open",
            position: serializePosition(updated),
            markPrice: String(candle.close),
            unrealizedPnl: settlement ? "0" : String(executionUnrealizedPnl(updated, candle.close)),
            immediateSettlement: settlement ? serializeSettlement(settlement) : null,
          };
          decision = {
            action: settlement ? "CLOSE" : "OPEN",
            reasonCode: settlement ? "ENTRY_EXIT_SAME_CANDLE" : "PENDING_SIGNAL_FILLED",
            summary: settlement
              ? `Позиция открыта и закрыта в одной свече: ${settlement.exitReason}`
              : `Открыта ${opened.side === "long" ? "long" : "short"} позиция`,
            factors: runtimeFactors(candle, dailyPnl, equity),
          };
          positionRemainsOpen = !settlement;
        } else {
          decision = {
            action: "SKIP",
            reasonCode: "LIMIT_NOT_FILLED",
            summary: "Лимитный вход не исполнен в следующей свече",
            factors: runtimeFactors(candle, dailyPnl, equity),
          };
          positionRemainsOpen = false;
        }
      } else if (pendingSignal && !entriesAllowed) {
        decision = {
          action: "SKIP",
          reasonCode: target.status === "PAUSED" ? "DEPLOYMENT_PAUSED" : "DAILY_LOSS_LIMIT",
          summary:
            target.status === "PAUSED"
              ? "Отложенный сигнал сброшен: deployment на паузе"
              : "Отложенный сигнал сброшен: достигнут дневной лимит убытка",
          factors: runtimeFactors(candle, dailyPnl, equity),
        };
        positionRemainsOpen = false;
      }

      if (!positionRemainsOpen && target.status === "RUNNING") {
        pendingSignalAfter = getExecutionSignal(candle, strategyConfig);
        if (pendingSignalAfter && positionAction.kind === "none") {
          decision = {
            action: "OPEN",
            reasonCode: "ENTRY_SIGNAL_PENDING",
            summary: `Зафиксирован ${pendingSignalAfter.side} сигнал для следующей свечи`,
            factors: runtimeFactors(candle, dailyPnl, equity),
          };
        }
      }

      const result = await runtimeRepository.persistCycle({
        workspaceId: target.workspaceId,
        deploymentId: target.id,
        executionRunId: executionRun.id,
        strategyVersionId: target.strategyVersion.id,
        symbol,
        interval,
        candleAt: candle.openTime,
        expectedDeploymentStatus: target.status,
        expectedPositionId: state.position?.id ?? null,
        pendingSignal: pendingSignalAfter,
        maxOpenPositions: strategyConfig.risk.maxOpenPositions,
        entryOrderType: strategyConfig.entry.orderType === "market" ? "MARKET" : "LIMIT",
        decision,
        positionAction,
      });
      if (result.applied) {
        logger.info(
          {
            deploymentId: target.id,
            executionRunId: executionRun.id,
            symbol,
            action: decision.action,
          },
          "Runtime candle processed",
        );
      }
    } catch (error) {
      if (error instanceof RuntimeStateConflictError) return;
      const failure = runtimeFailure(error);
      await runtimeRepository.recordFailure({
        workspaceId: target.workspaceId,
        executionRunId: executionRun.id,
        symbol,
        code: failure.code,
        message: failure.message,
      });
      logger.error(
        { err: error, deploymentId: target.id, executionRunId: executionRun.id, symbol },
        "Runtime symbol cycle failed",
      );
    }
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

    const dataset = await prepareValidationDataset(job, executionInput, strategyConfig);
    const result = runValidationEngine({
      config: strategyConfig,
      candles: dataset.candles,
      initialCapital: Number(executionInput.initialCapital),
      kind: executionInput.kind,
      walkForward: executionInput.walkForward,
    });
    const metrics = validationMetricsSchema.parse({
      ...result.metrics,
      gateReasons: result.gateReasons,
      provenance: {
        datasetHash: dataset.contentHash,
        symbols: dataset.symbols,
        timeframe: executionInput.dataset.timeframe,
        startDate: executionInput.dataset.startDate,
        endDate: executionInput.dataset.endDate,
        candleCount: dataset.candles.length,
      },
    });
    await validationRepository.complete({
      workerId,
      jobId: job.jobId,
      runId: job.runId,
      workspaceId: job.workspaceId,
      datasetSnapshotId: dataset.id,
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
        candles: dataset.candles.length,
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

async function prepareValidationDataset(
  job: ClaimedValidationJob,
  executionInput: ReturnType<typeof validationExecutionInputSchema.parse>,
  strategyConfig: ReturnType<typeof strategyConfigSchema.parse>,
): Promise<{
  id: string;
  contentHash: string;
  symbols: string[];
  candles: ValidationCandle[];
}> {
  const symbols = [...new Set(executionInput.dataset.symbols)].sort();
  if (job.datasetSnapshotId) {
    const snapshot = await validationRepository.getDatasetSnapshot(
      job.workspaceId,
      job.datasetSnapshotId,
    );
    if (!snapshot) {
      throw new ValidationWorkerError(
        "DATASET_SNAPSHOT_MISSING",
        "Связанный immutable dataset snapshot не найден",
      );
    }
    const snapshotSymbols = readDatasetSymbols(snapshot.symbols);
    if (
      snapshot.source !== validationDatasetSource ||
      snapshot.exchange !== "bybit" ||
      snapshot.instrumentType !== "linear-perpetual" ||
      snapshot.timeframe !== executionInput.dataset.timeframe ||
      JSON.stringify(snapshotSymbols) !== JSON.stringify(symbols)
    ) {
      throw new ValidationWorkerError(
        "DATASET_SNAPSHOT_MISMATCH",
        "Immutable dataset snapshot не соответствует параметрам validation run",
      );
    }
    const leaseKept = await validationRepository.updateProgress(job.jobId, workerId, 80);
    if (!leaseKept) {
      throw new ValidationWorkerError("JOB_LEASE_LOST", "Worker потерял lease задачи");
    }
    return deserializeValidationDataset(snapshot, snapshotSymbols);
  }

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

  const snapshotCandles: ValidationDatasetCandlePersistenceInput[] = [];
  for (const [index, symbol] of symbols.entries()) {
    let marketCandles;
    try {
      marketCandles = await marketClient.getLinearKlinesRange(symbol, interval, startTime, endTime);
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
    if (snapshotCandles.length + marketCandles.length > maximumDatasetCandles) {
      throw new ValidationWorkerError(
        "DATASET_TOO_LARGE",
        `Фактический объём превышает лимит ${maximumDatasetCandles} свечей`,
      );
    }

    for (const candle of marketCandles) {
      finiteNumber(candle.open, "open", symbol);
      finiteNumber(candle.high, "high", symbol);
      finiteNumber(candle.low, "low", symbol);
      finiteNumber(candle.close, "close", symbol);
      finiteNumber(candle.volume, "volume", symbol);
      finiteNumber(candle.turnover, "turnover", symbol);
      snapshotCandles.push({
        symbol: candle.symbol,
        openTime: candle.openTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        turnover: candle.turnover,
      });
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

  if (snapshotCandles.length === 0) {
    throw new ValidationWorkerError("DATASET_EMPTY", "Bybit не вернул свечи за выбранный период");
  }
  const materialized = await validationRepository.materializeDataset({
    workerId,
    jobId: job.jobId,
    runId: job.runId,
    workspaceId: job.workspaceId,
    source: validationDatasetSource,
    exchange: "bybit",
    instrumentType: "linear-perpetual",
    timeframe: executionInput.dataset.timeframe,
    symbols,
    candles: snapshotCandles,
  });
  const snapshot = await validationRepository.getDatasetSnapshot(job.workspaceId, materialized.id);
  if (!snapshot) {
    throw new ValidationWorkerError(
      "DATASET_SNAPSHOT_MISSING",
      "Материализованный immutable dataset snapshot не найден",
    );
  }
  return deserializeValidationDataset(snapshot, symbols);
}

function deserializeValidationDataset(
  snapshot: NonNullable<Awaited<ReturnType<ValidationRepository["getDatasetSnapshot"]>>>,
  symbols: string[],
) {
  return {
    id: snapshot.id,
    contentHash: snapshot.contentHash,
    symbols,
    candles: snapshot.candles.map((candle) => ({
      symbol: candle.symbol,
      openTime: candle.openTime,
      open: candle.open.toNumber(),
      high: candle.high.toNumber(),
      low: candle.low.toNumber(),
      close: candle.close.toNumber(),
      turnover: candle.turnover.toNumber(),
    })),
  };
}

function readDatasetSymbols(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value].sort()
    : [];
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Shutting down worker");
  await prisma.workerHeartbeat.deleteMany({ where: { workerId: { in: [workerId, watchdogId] } } });
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

class RuntimeWorkerError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function runtimeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof RuntimeWorkerError) {
    return { code: error.code, message: error.message.slice(0, 500) };
  }
  return { code: "RUNTIME_CYCLE_FAILED", message: errorMessage(error).slice(0, 500) };
}

function deserializeExecutionPosition(position: {
  symbol?: string;
  side: "BUY" | "SELL";
  entryRegime: "BULL" | "BEAR" | "NEUTRAL" | "UNKNOWN";
  entrySession: "ASIA" | "EUROPE" | "US" | "OFF_HOURS" | "UNKNOWN";
  openedAt: Date;
  entryPrice: { toNumber(): number };
  quantity: { toNumber(): number };
  stopPrice: { toNumber(): number };
  takePrice: { toNumber(): number };
  trailingPrice: { toNumber(): number } | null;
  bestPrice: { toNumber(): number };
  entryFee: { toNumber(): number };
  entrySlippage: { toNumber(): number };
}): ExecutionPosition {
  return {
    symbol: position.symbol ?? "",
    side: position.side === "BUY" ? "long" : "short",
    entryRegime: deserializeMarketRegime(position.entryRegime),
    entrySession: deserializeTradingSession(position.entrySession),
    openedAt: position.openedAt,
    entryPrice: position.entryPrice.toNumber(),
    quantity: position.quantity.toNumber(),
    stopPrice: position.stopPrice.toNumber(),
    takePrice: position.takePrice.toNumber(),
    trailingPrice: position.trailingPrice?.toNumber() ?? null,
    bestPrice: position.bestPrice.toNumber(),
    entryFee: position.entryFee.toNumber(),
    entrySlippage: position.entrySlippage.toNumber(),
  };
}

function serializePosition(position: ExecutionPosition) {
  return {
    symbol: position.symbol,
    side: position.side === "long" ? ("BUY" as const) : ("SELL" as const),
    entryRegime: serializeMarketRegime(position.entryRegime),
    entrySession: serializeTradingSession(position.entrySession),
    openedAt: position.openedAt,
    entryPrice: String(position.entryPrice),
    quantity: String(position.quantity),
    stopPrice: String(position.stopPrice),
    takePrice: String(position.takePrice),
    trailingPrice: position.trailingPrice === null ? null : String(position.trailingPrice),
    bestPrice: String(position.bestPrice),
    entryFee: String(position.entryFee),
    entrySlippage: String(position.entrySlippage),
  };
}

function serializeSettlement(settlement: ExecutionSettlement) {
  return {
    exitPrice: String(settlement.exitPrice),
    grossPnl: String(settlement.grossPnl),
    netPnl: String(settlement.netPnl),
    fees: String(settlement.fees),
    slippage: String(settlement.slippage),
    exitReason: settlement.exitReason,
    closedAt: new Date(settlement.closedAt),
  };
}

function parsePendingSignal(value: unknown): PendingExecutionSignal | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  if (!("side" in value) || !("signalPrice" in value)) return null;
  const side = value.side;
  const signalPrice = value.signalPrice;
  if ((side !== "long" && side !== "short") || typeof signalPrice !== "number") return null;
  if (!Number.isFinite(signalPrice) || signalPrice <= 0) return null;
  return { side, signalPrice };
}

function runtimeFactors(
  candle: {
    openTime: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    emaFast: number | null;
    emaSlow: number | null;
    rsi: number | null;
    atrPercent: number | null;
    volume24h: number;
  },
  dailyPnl: number,
  equity: number,
) {
  return {
    candle: { open: candle.open, high: candle.high, low: candle.low, close: candle.close },
    market: {
      regime: getExecutionMarketRegime(candle),
      session: getExecutionTradingSession(candle.openTime),
    },
    indicators: {
      emaFast: candle.emaFast,
      emaSlow: candle.emaSlow,
      rsi: candle.rsi,
      atrPercent: candle.atrPercent,
      volume24h: candle.volume24h,
    },
    risk: { dailyPnl, equity },
  };
}

function serializeMarketRegime(regime: ExecutionPosition["entryRegime"]) {
  return regime === "bull"
    ? ("BULL" as const)
    : regime === "bear"
      ? ("BEAR" as const)
      : regime === "neutral"
        ? ("NEUTRAL" as const)
        : ("UNKNOWN" as const);
}

function deserializeMarketRegime(regime: "BULL" | "BEAR" | "NEUTRAL" | "UNKNOWN") {
  return regime === "BULL"
    ? ("bull" as const)
    : regime === "BEAR"
      ? ("bear" as const)
      : regime === "NEUTRAL"
        ? ("neutral" as const)
        : ("unknown" as const);
}

function serializeTradingSession(session: ExecutionPosition["entrySession"]) {
  return session === "asia"
    ? ("ASIA" as const)
    : session === "europe"
      ? ("EUROPE" as const)
      : session === "us"
        ? ("US" as const)
        : session === "off-hours"
          ? ("OFF_HOURS" as const)
          : ("UNKNOWN" as const);
}

function deserializeTradingSession(session: "ASIA" | "EUROPE" | "US" | "OFF_HOURS" | "UNKNOWN") {
  return session === "ASIA"
    ? ("asia" as const)
    : session === "EUROPE"
      ? ("europe" as const)
      : session === "US"
        ? ("us" as const)
        : session === "OFF_HOURS"
          ? ("off-hours" as const)
          : ("unknown" as const);
}

function validationFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ValidationDatasetConflictError) {
    return {
      code: "DATASET_SNAPSHOT_CONFLICT",
      message: "Immutable dataset snapshot не прошёл проверку целостности",
    };
  }
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

function healthThresholds() {
  return {
    workerStaleMs: heartbeatIntervalMs * 3,
    marketStaleMs: config.MARKET_POLL_INTERVAL_MS * 3,
    accountStaleMs: config.ACCOUNT_SNAPSHOT_INTERVAL_MS * 2,
    queueLagMs: 5 * 60_000,
    outboxLagMs: 5 * 60_000,
  };
}

const validationPollIntervalMs = 2_000;
const validationLeaseMs = 5 * 60_000;
const maximumDatasetCandles = 250_000;
const persistenceBatchSize = 2_000;
const validationDatasetSource = "bybit-public-linear-klines";
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
const tradingEnvironment = {
  DRY_RUN: "dry-run",
  DEMO: "demo",
  LIVE: "live",
} as const;

logger.info({ workerId }, "Worker started");
await Promise.all([
  heartbeatLoop(),
  marketDataLoop(),
  candleDataLoop(),
  accountSnapshotLoop(),
  validationJobLoop(),
  runtimeLoop(),
  watchdogLoop(),
]);
