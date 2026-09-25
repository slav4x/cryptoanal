import {
  buildDecisionMarketFrame,
  createDecisionContextSnapshot,
  decisionContextSchemaVersion,
  decisionFeatureSetVersion,
  enrichExecutionCandles,
  evaluateHealth,
  settleExecutionPosition,
  evaluateExecutionPriceExit,
  executionUnrealizedPnl,
  getExecutionSignal,
  getExecutionMarketRegime,
  getExecutionTradingSession,
  getTradingDateKey,
  fundingPolicy,
  metricProvenanceSchemaVersion,
  minimumExecutionCandleCount,
  openExecutionPositionAtQuote,
  runValidationEngine,
  updateExecutionTrailingAtPrice,
  validationEngineVersion,
  type ExecutionMarketRegime,
  type ExecutionPosition,
  type ExecutionQuote,
  type ExecutionSettlement,
  type DecisionCandidate,
  type PendingExecutionSignal,
  type ValidationCandle,
  validationDatasetSource,
} from "@cryptoanal/application";
import { loadServerConfig } from "@cryptoanal/config";
import {
  strategyConfigSchema,
  validationExecutionInputSchema,
  validationMetricsSchema,
} from "@cryptoanal/contracts";
import {
  BybitCredentialsRejectedError,
  BybitPrivateApiUnavailableError,
  BybitPrivateClient,
  BybitPublicMarketClient,
  BybitPublicStreamClient,
  describeBybitCredentialRejection,
  evaluateBybitPermissions,
} from "@cryptoanal/exchange-bybit";
import {
  AccountSnapshotRepository,
  CredentialCipher,
  DecisionRepository,
  ExchangeConnectionRepository,
  ExchangeConnectionVerificationConflictError,
  ExchangeConnectionVerificationLeaseLostError,
  createPrismaClient,
  exchangeCredentialContext,
  HealthRepository,
  MarketDataRepository,
  MarketUniverseRepository,
  RuntimeRepository,
  RuntimeRiskRepository,
  PriceEventRepository,
  type PriceEventInput,
  RuntimeStateConflictError,
  ValidationDatasetConflictError,
  ValidationRepository,
  WorkspaceRepository,
  type ClaimedValidationJob,
  type ValidationDatasetCandlePersistenceInput,
} from "@cryptoanal/persistence";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { evaluateRuntimeCandleExit } from "./runtime-position";
import { OrderedPriceJournal } from "./price-journal";
import {
  recoverRuntimeGap,
  limitRuntimePositionRisk,
  RuntimeRecoveryIncompleteError,
} from "./runtime-recovery";

const heartbeatIntervalMs = 15_000;
const workerId = `worker-${randomUUID()}`;
const watchdogId = `${workerId}:watchdog`;
const config = loadServerConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const marketDataRepository = new MarketDataRepository(prisma);
const marketUniverseRepository = new MarketUniverseRepository(prisma);
const accountSnapshotRepository = new AccountSnapshotRepository(prisma);
const validationRepository = new ValidationRepository(prisma);
const runtimeRiskPolicy = {
  initialBalance: config.DRY_RUN_INITIAL_BALANCE,
  maxDailyLossPercent: config.RUNTIME_MAX_DAILY_LOSS_PERCENT,
  maxAccountExposurePercent: config.RUNTIME_MAX_ACCOUNT_EXPOSURE_PERCENT,
  maxOpenPositions: config.RUNTIME_MAX_OPEN_POSITIONS,
  maxQuoteAgeMs: config.RUNTIME_QUOTE_MAX_AGE_MS,
};
const runtimeRepository = new RuntimeRepository(prisma, runtimeRiskPolicy);
const runtimeRiskRepository = new RuntimeRiskRepository(prisma, runtimeRiskPolicy);
const decisionRepository = new DecisionRepository(prisma);
const priceEventRepository = new PriceEventRepository(prisma);
const healthRepository = new HealthRepository(prisma);
const workspaceRepository = new WorkspaceRepository(prisma);
const exchangeConnectionRepository = new ExchangeConnectionRepository(prisma);
const credentialCipher = new CredentialCipher(config.EXCHANGE_CREDENTIALS_KEY);
const marketClient = new BybitPublicMarketClient(
  config.BYBIT_PUBLIC_BASE_URL,
  config.BYBIT_PROXY_URL,
);
const marketStreamClient = new BybitPublicStreamClient(config.BYBIT_PUBLIC_WS_URL);
const privateClients = {
  DEMO: new BybitPrivateClient(config.BYBIT_DEMO_BASE_URL, undefined, config.BYBIT_PROXY_URL),
  LIVE: new BybitPrivateClient(config.BYBIT_LIVE_BASE_URL, undefined, config.BYBIT_PROXY_URL),
} as const;
const logger = pino({ level: config.LOG_LEVEL, name: "cryptoanal-worker" });
const marketStreamAbortController = new AbortController();
type JournalQuote = ExecutionQuote & { id: bigint; streamId: string };
const latestQuotes = new Map<string, JournalQuote>();
let streamSession = randomUUID();
let streamConnected = false;
const priceJournal = new OrderedPriceJournal<PriceEventInput>(async (events) => {
  const saved = await priceEventRepository.append(events, workerId);
  for (const event of saved) {
    const current = latestQuotes.get(event.symbol);
    if (!current || event.observedAt >= current.observedAt) {
      latestQuotes.set(event.symbol, {
        id: event.id,
        symbol: event.symbol,
        price: Number(event.price),
        observedAt: event.observedAt,
        streamId: event.streamId,
      });
    }
  }
});

let stopping = false;

async function writeHeartbeat() {
  const workspaceIds = await workspaceRepository.listOperationalIds();
  await prisma.workerHeartbeat.upsert({
    where: { workerId },
    update: {
      lastSeenAt: new Date(),
      metadata: { workspaceIds },
    },
    create: {
      workerId,
      service: "worker",
      version: "0.1.0",
      lastSeenAt: new Date(),
      metadata: { workspaceIds },
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
      const requestedSeries = await listRequiredMarketSeries();
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

async function instrumentMetadataLoop() {
  while (!stopping) {
    try {
      const syncedAt = new Date();
      const instruments = await marketClient.getLinearInstrumentsByStatuses(["Trading", "Closed"]);
      const changes = await marketUniverseRepository.syncTrackedInstruments(
        instruments.map((instrument) => ({
          ...instrument,
          exchange: "bybit" as const,
          instrumentType: "linear-perpetual" as const,
        })),
        syncedAt,
      );
      const unavailableSymbols = await marketUniverseRepository.listUnavailableTrackedSymbols();
      const pausedDeployments = await marketUniverseRepository.pauseDeploymentsUsingSymbols({
        symbols: unavailableSymbols,
        actorId: `system:${workerId}`,
        requestId: `instrument-sync:${syncedAt.toISOString()}`,
      });
      if (changes.length > 0) {
        logger.warn({ changes, pausedDeployments }, "Tracked market instrument statuses changed");
      } else {
        logger.debug({ instruments: instruments.length }, "Market instrument metadata synced");
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to sync market instrument metadata");
    }

    await delay(config.INSTRUMENT_SYNC_INTERVAL_MS);
  }
}

async function marketStreamLoop() {
  while (!stopping) {
    const leaseAbort = new AbortController();
    let renewal: ReturnType<typeof setInterval> | undefined;
    try {
      if (!(await priceEventRepository.claimWriter(workerId))) {
        await delay(5000);
        continue;
      }
      renewal = setInterval(() => {
        void priceEventRepository
          .claimWriter(workerId)
          .then((owned) => {
            if (!owned) leaseAbort.abort();
          })
          .catch(() => leaseAbort.abort());
      }, 5000);
      await marketStreamClient.run(
        {
          getSubscriptions: async () => {
            const symbols = await marketDataRepository.listEnabledSymbols();
            const series = await listRequiredMarketSeries();
            return {
              tickerSymbols: [],
              tradeSymbols: [...new Set([...symbols, ...series.map(({ symbol }) => symbol)])],
              klines: series.map(({ symbol, interval }) => ({ symbol, interval })),
            };
          },
          onQuote: () => {},
          onTrade: (quote) => {
            if (stopping) return;
            const price = Number(quote.price);
            if (
              !Number.isFinite(price) ||
              price <= 0 ||
              !Number.isFinite(quote.observedAt.getTime()) ||
              quote.observedAt.getTime() > Date.now() + 1000
            )
              return;
            if (
              !priceJournal.enqueue({
                eventKey: `bybit-trade:${quote.symbol}:${quote.tradeId}`,
                symbol: quote.symbol,
                price: quote.price,
                observedAt: quote.observedAt,
                streamId: streamSession,
              })
            ) {
              streamSession = randomUUID();
              latestQuotes.clear();
              logger.error("Market price journal overflow; recovery required");
            }
          },
          onClosedCandle: async (candle) => {
            await marketDataRepository.saveCandles([candle]);
          },
          onConnected: () => {
            streamSession = randomUUID();
            streamConnected = true;
            latestQuotes.clear();
            logger.info("Bybit public market stream connected");
          },
          onDisconnected: (code, reason) => {
            streamConnected = false;
            logger.warn({ code, reason }, "Bybit public market stream disconnected");
          },
          onError: (error) => logger.warn({ err: error }, "Bybit public market stream error"),
        },
        AbortSignal.any([marketStreamAbortController.signal, leaseAbort.signal]),
      );
    } catch (error) {
      logger.error({ err: error }, "Market stream leader failed");
    } finally {
      if (renewal) clearInterval(renewal);
      streamConnected = false;
    }
    if (!stopping) await delay(2000);
  }
}

async function priceJournalLoop() {
  let nextCleanup = 0;
  while (!stopping) {
    try {
      await priceJournal.flush();
      if (Date.now() >= nextCleanup) {
        await priceEventRepository.prune(
          new Date(Date.now() - config.RUNTIME_EVENT_RETENTION_HOURS * 3600_000),
        );
        nextCleanup = Date.now() + 3600_000;
      }
    } catch (error) {
      logger.error({ err: error }, "Market price journal write failed; entries blocked");
    }
    await delay(50);
  }
}

async function listRequiredMarketSeries() {
  const symbols = await marketDataRepository.listEnabledSymbols();
  const enabledSymbols = new Set(symbols);
  const requirements = new Map<string, { symbol: string; interval: string; limit: number }>();
  for (const symbol of symbols) {
    requirements.set(`${symbol}:15`, { symbol, interval: "15", limit: 200 });
  }
  const workspaceIds = await workspaceRepository.listOperationalIds();
  const runtimeTargets = (
    await Promise.all(
      workspaceIds.map((workspaceId) => runtimeRepository.listActiveTargets(workspaceId)),
    )
  ).flat();
  for (const target of runtimeTargets) {
    const strategyConfig = strategyConfigSchema.parse(target.strategyVersion.config);
    const interval = bybitIntervals[strategyConfig.universe.timeframe];
    const limit = Math.min(1_000, minimumExecutionCandleCount(strategyConfig) + 1);
    for (const symbol of strategyConfig.universe.symbols) {
      if (!enabledSymbols.has(symbol)) continue;
      const key = `${symbol}:${interval}`;
      const current = requirements.get(key);
      requirements.set(key, {
        symbol,
        interval,
        limit: Math.max(current?.limit ?? 0, limit),
      });
      for (const contextTimeframe of decisionContextTimeframes) {
        const contextInterval = bybitIntervals[contextTimeframe];
        const contextKey = `${symbol}:${contextInterval}`;
        const currentContext = requirements.get(contextKey);
        requirements.set(contextKey, {
          symbol,
          interval: contextInterval,
          limit: Math.max(currentContext?.limit ?? 0, decisionContextAnalysisCandleLimit),
        });
      }
    }
  }
  return [...requirements.values()];
}

async function accountSnapshotLoop() {
  while (!stopping) {
    const workspaceIds = await listOperationalWorkspaceIds("account snapshot");
    for (const workspaceId of workspaceIds) {
      try {
        const knownAccountIds = await accountSnapshotRepository.listDryRunAccountIds(workspaceId);
        const accountIds =
          knownAccountIds.length > 0 ? knownAccountIds : [config.DRY_RUN_ACCOUNT_ID];
        for (const exchangeAccountId of accountIds) {
          await accountSnapshotRepository.captureDryRunSnapshot({
            workspaceId,
            exchangeAccountId,
            initialBalance: String(config.DRY_RUN_INITIAL_BALANCE),
          });
        }
        const snapshot = await accountSnapshotRepository.captureDryRunSnapshot({
          workspaceId,
          exchangeAccountId: `${config.DRY_RUN_ACCOUNT_ID}:portfolio`,
          sourceAccountIds: accountIds,
          initialBalance: String(config.DRY_RUN_INITIAL_BALANCE * accountIds.length),
        });
        logger.debug(
          {
            workspaceId,
            accounts: accountIds.length,
            equity: snapshot.equity.toFixed(),
            observedAt: snapshot.observedAt,
          },
          "Dry-run portfolio snapshot updated",
        );
      } catch (error) {
        logger.error({ err: error, workspaceId }, "Failed to update dry-run account snapshot");
      }
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

async function exchangeVerificationLoop() {
  while (!stopping) {
    let processed = false;
    try {
      const now = new Date();
      const connection = await exchangeConnectionRepository.claimDueVerification({
        workerId,
        now,
        leaseExpiresAt: addMilliseconds(now, config.EXCHANGE_VERIFICATION_LEASE_SECONDS * 1_000),
      });
      if (connection) {
        processed = true;
        await verifyExchangeConnection(connection);
      }
    } catch (error) {
      if (
        error instanceof ExchangeConnectionVerificationConflictError ||
        error instanceof ExchangeConnectionVerificationLeaseLostError
      ) {
        logger.info({ err: error }, "Exchange verification claim was superseded");
      } else {
        logger.error({ err: error }, "Exchange verification loop failed");
      }
    }

    if (!processed) await delay(config.EXCHANGE_VERIFICATION_POLL_INTERVAL_MS);
  }
}

async function verifyExchangeConnection(
  connection: NonNullable<
    Awaited<ReturnType<ExchangeConnectionRepository["claimDueVerification"]>>
  >,
) {
  const attemptedAt = new Date();
  try {
    if (!connection.encryptedApiKey || !connection.encryptedApiSecret) {
      throw new Error("Encrypted credentials are unavailable");
    }
    const context = exchangeCredentialContext({
      workspaceId: connection.workspaceId,
      exchange: connection.exchange,
      environment: connection.environment,
      label: connection.label,
    });
    let apiKey: string;
    let apiSecret: string;
    try {
      apiKey = credentialCipher.decrypt(connection.encryptedApiKey, context);
      apiSecret = credentialCipher.decrypt(connection.encryptedApiSecret, context);
    } catch {
      throw new ScheduledCredentialsUnreadableError();
    }
    const information = await privateClients[connection.environment].getApiKeyInformation(
      apiKey,
      apiSecret,
      AbortSignal.timeout(config.BYBIT_PRIVATE_REQUEST_TIMEOUT_MS),
    );
    const { tradingPermission, withdrawalPermission } = evaluateBybitPermissions(
      information.permissions,
    );
    await exchangeConnectionRepository.recordVerification({
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      actorId: `system:${workerId}`,
      requestId: `scheduled:${randomUUID()}`,
      status: withdrawalPermission ? "INVALID" : "ACTIVE",
      code: withdrawalPermission ? "WITHDRAW_PERMISSION_NOT_ALLOWED" : "VERIFIED",
      message: withdrawalPermission
        ? "Отключите разрешение Withdraw у API-ключа"
        : information.readOnly
          ? "Ключ действителен и работает только на чтение"
          : tradingPermission
            ? "Ключ действителен; торговые разрешения доступны"
            : "Ключ действителен; торговые разрешения отсутствуют",
      readOnly: information.readOnly,
      tradingPermission,
      ipBound: information.ipBound,
      accountUid: information.accountUid,
      permissions: information.permissions,
      verifiedAt: attemptedAt,
      nextVerificationAt: withdrawalPermission
        ? null
        : addHours(attemptedAt, config.EXCHANGE_VERIFICATION_INTERVAL_HOURS),
      expectedCredentialRevision: connection.credentialRevision,
      leaseOwner: workerId,
    });
    logger.info(
      { connectionId: connection.id, workspaceId: connection.workspaceId },
      "Exchange connection verified",
    );
  } catch (error) {
    if (error instanceof BybitCredentialsRejectedError) {
      await exchangeConnectionRepository.recordVerification({
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        actorId: `system:${workerId}`,
        requestId: `scheduled:${randomUUID()}`,
        status: "INVALID",
        code: `BYBIT_${error.code}`,
        message: describeBybitCredentialRejection(error.code),
        readOnly: null,
        tradingPermission: null,
        ipBound: null,
        accountUid: null,
        permissions: null,
        verifiedAt: attemptedAt,
        nextVerificationAt: null,
        expectedCredentialRevision: connection.credentialRevision,
        leaseOwner: workerId,
      });
      logger.warn(
        { connectionId: connection.id, workspaceId: connection.workspaceId, code: error.code },
        "Exchange connection became invalid",
      );
      return;
    }
    if (
      error instanceof ExchangeConnectionVerificationConflictError ||
      error instanceof ExchangeConnectionVerificationLeaseLostError
    ) {
      throw error;
    }
    const unavailable = error instanceof BybitPrivateApiUnavailableError;
    const credentialsUnreadable = error instanceof ScheduledCredentialsUnreadableError;
    await exchangeConnectionRepository.recordVerificationUnavailable({
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      expectedCredentialRevision: connection.credentialRevision,
      leaseOwner: workerId,
      attemptedAt,
      nextVerificationAt: addMinutes(attemptedAt, config.EXCHANGE_VERIFICATION_RETRY_MINUTES),
      code: unavailable
        ? "BYBIT_UNAVAILABLE"
        : credentialsUnreadable
          ? "CREDENTIALS_UNREADABLE"
          : "VERIFICATION_FAILED",
      message: unavailable
        ? "Bybit временно не подтвердил подключение; запланирована повторная проверка"
        : credentialsUnreadable
          ? "Credentials не удалось расшифровать; проверьте master key"
          : "Плановая проверка завершилась технической ошибкой; будет выполнен повтор",
    });
    logger.warn(
      { connectionId: connection.id, workspaceId: connection.workspaceId },
      "Exchange verification postponed",
    );
  }
}

async function runtimeLoop() {
  while (!stopping) {
    const workspaceIds = await listOperationalWorkspaceIds("runtime");
    for (const workspaceId of workspaceIds) {
      try {
        const targets = await runtimeRepository.listActiveTargets(workspaceId);
        for (const target of targets) {
          try {
            await processRuntimeTarget(target);
          } catch (error) {
            logger.error(
              { err: error, workspaceId, deploymentId: target.id },
              "Runtime target failed",
            );
          }
        }
      } catch (error) {
        logger.error({ err: error, workspaceId }, "Runtime workspace cycle failed");
      }
    }

    await delay(config.RUNTIME_POLL_INTERVAL_MS);
  }
}

async function runtimeQuoteLoop() {
  while (!stopping) {
    const workspaceIds = await listOperationalWorkspaceIds("runtime quote");
    for (const workspaceId of workspaceIds) {
      try {
        const [positions, pendingEntries] = await Promise.all([
          runtimeRepository.listRealtimePositions(workspaceId),
          runtimeRepository.listRealtimePendingEntries(workspaceId),
        ]);
        for (const position of positions) {
          try {
            await processRealtimePosition(position);
          } catch (error) {
            await runtimeRepository.recordFailure({
              workspaceId,
              executionRunId: position.executionRunId,
              symbol: position.symbol,
              code: "RUNTIME_RECOVERY_REQUIRED",
              message: errorMessage(error).slice(0, 500),
            });
            logger.error(
              { err: error, workspaceId, positionId: position.id, symbol: position.symbol },
              "Realtime position update failed",
            );
          }
        }
        for (const pending of pendingEntries) {
          try {
            await processRealtimeEntry(pending);
          } catch (error) {
            logger.error(
              {
                err: error,
                workspaceId,
                executionRunId: pending.executionRun.id,
                symbol: pending.symbol,
              },
              "Realtime pending entry failed",
            );
          }
        }
      } catch (error) {
        logger.error({ err: error, workspaceId }, "Realtime quote cycle failed");
      }
    }
    await delay(config.RUNTIME_QUOTE_INTERVAL_MS);
  }
}

async function processRealtimePosition(
  target: Awaited<ReturnType<RuntimeRepository["listRealtimePositions"]>>[number],
) {
  const strategyConfig = strategyConfigSchema.parse(target.strategyVersion.config);
  let position = deserializeExecutionPosition(target);
  let through = target.managedThroughAt ?? target.openedAt;
  let streamId = target.priceStreamId;
  let markPrice = Number(target.markPrice ?? target.entryPrice);
  const events = await priceEventRepository.after(target.symbol, target.priceEventId, through);
  let processed: (typeof events)[number] | null = null;
  let settlement: ExecutionSettlement | null = null;
  let recovered = false;
  for (const event of events) {
    if (event.observedAt < target.openedAt) {
      processed = event;
      continue;
    }
    const quote = {
      symbol: event.symbol,
      price: Number(event.price),
      observedAt: new Date(Math.max(event.observedAt.getTime(), through.getTime())),
    };
    if (
      streamId !== event.streamId ||
      quote.observedAt.getTime() - through.getTime() > config.RUNTIME_QUOTE_MAX_AGE_MS
    ) {
      // A persisted stream change proves a possible missing interval, even after process restart.
      if (
        quote.observedAt.getTime() - through.getTime() >
        config.RUNTIME_RECOVERY_MAX_HOURS * 3600_000
      ) {
        throw new RuntimeRecoveryIncompleteError(
          "Recovery window exceeds configured limit; manual position review required",
        );
      }
      const minuteStart = new Date(Math.floor(through.getTime() / 60_000) * 60_000);
      const intervalMs = timeframeMinutes[strategyConfig.universe.timeframe] * 60_000;
      const signalStart = new Date(
        Math.floor(through.getTime() / intervalMs) * intervalMs -
          minimumExecutionCandleCount(strategyConfig) * intervalMs,
      );
      const [minutes, history] = await Promise.all([
        marketClient.getLinearKlinesRange(target.symbol, "1", minuteStart, quote.observedAt),
        marketClient.getLinearKlinesRange(
          target.symbol,
          bybitIntervals[strategyConfig.universe.timeframe],
          signalStart,
          quote.observedAt,
        ),
      ]);
      const completeSignals = history.filter(
        (candle) => candle.openTime.getTime() + intervalMs <= quote.observedAt.getTime(),
      );
      const lastSignal = new Date(
        Math.floor(quote.observedAt.getTime() / intervalMs) * intervalMs - intervalMs,
      );
      if (
        !assessCandleContinuity(
          completeSignals,
          intervalMs,
          lastSignal,
          Math.ceil((lastSignal.getTime() - signalStart.getTime()) / intervalMs) + 1,
        ).complete
      ) {
        throw new RuntimeRecoveryIncompleteError("Signal history is incomplete during recovery");
      }
      const result = recoverRuntimeGap({
        position,
        since: through,
        quote,
        minutes: minutes.map(toExecutionCandle),
        signals: enrichExecutionCandles(completeSignals.map(toExecutionCandle), strategyConfig),
        signalIntervalMs: intervalMs,
        config: strategyConfig,
      });
      position = result.position;
      settlement = result.settlement;
      recovered = true;
    }
    if (!settlement) settlement = evaluateExecutionPriceExit(position, quote, strategyConfig);
    if (!settlement)
      position = updateExecutionTrailingAtPrice(position, quote.price, strategyConfig);
    processed = event;
    markPrice = quote.price;
    through = quote.observedAt;
    streamId = event.streamId;
    if (settlement) break;
  }
  if (!processed) return;
  const result = await runtimeRepository.persistRealtimeQuote({
    workspaceId: target.workspaceId,
    deploymentId: target.executionRun.deployment.id,
    executionRunId: target.executionRunId,
    strategyVersionId: target.strategyVersionId,
    positionId: target.id,
    expectedPositionVersion: target.runtimeVersion,
    symbol: target.symbol,
    quotePrice: String(markPrice),
    quoteAt: through,
    processedPrice: {
      eventId: processed.id,
      streamId: streamId ?? processed.streamId,
      throughAt: through,
    },
    factors: {
      source: recovered ? "ohlc-recovery" : "durable-price-events",
      lastEventId: String(processed.id),
      recovered,
    },
    action: settlement
      ? { kind: "close", settlement: serializeSettlement(settlement) }
      : {
          kind: "update",
          markPrice: String(markPrice),
          unrealizedPnl: String(executionUnrealizedPnl(position, markPrice)),
          bestPrice: String(position.bestPrice),
          stopPrice: String(position.stopPrice),
          trailingPrice: position.trailingPrice === null ? null : String(position.trailingPrice),
        },
  });
  if (result.applied) {
    await prisma.runtimeCursor.updateMany({
      where: {
        executionRunId: target.executionRunId,
        symbol: target.symbol,
        lastFailureCode: "RUNTIME_RECOVERY_REQUIRED",
      },
      data: { lastFailureCode: null, lastFailureMessage: null, consecutiveFailures: 0 },
    });
  }
  if (result.closed)
    logger.info(
      { positionId: target.id, symbol: target.symbol, reason: settlement?.exitReason },
      "Position closed from price journal",
    );
}

function toExecutionCandle(candle: {
  symbol: string;
  openTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  turnover: string;
}) {
  return {
    symbol: candle.symbol,
    openTime: candle.openTime,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    turnover: Number(candle.turnover),
  };
}

async function riskGuardLoop() {
  while (!stopping) {
    for (const workspaceId of await listOperationalWorkspaceIds("risk guard")) {
      try {
        await enforceRuntimeRisk(workspaceId);
      } catch (error) {
        logger.error({ err: error, workspaceId }, "Independent risk guard failed");
      }
    }
    await delay(config.RUNTIME_QUOTE_INTERVAL_MS);
  }
}

async function enforceRuntimeRisk(workspaceId: string) {
  const positions = await runtimeRepository.listRealtimePositions(workspaceId);
  const assessed = new Map<string, Awaited<ReturnType<RuntimeRiskRepository["assess"]>>>();
  for (const target of positions) {
    const account = target.executionRun.deployment.exchangeAccountId;
    let risk = assessed.get(account);
    if (!risk) {
      risk = await runtimeRiskRepository.assess(
        workspaceId,
        account,
        target.strategyVersion.config,
      );
      assessed.set(account, risk);
    }
    if (!risk.forceCloseReason) continue;
    const quote = getFreshQuote(target.symbol);
    if (!quote) continue;
    const strategyConfig = strategyConfigSchema.parse(target.strategyVersion.config);
    const settlement = settleExecutionPosition(
      deserializeExecutionPosition(target),
      quote.price,
      quote.observedAt,
      risk.forceCloseReason,
      strategyConfig,
    );
    await runtimeRepository.persistRealtimeQuote({
      workspaceId,
      deploymentId: target.executionRun.deployment.id,
      executionRunId: target.executionRunId,
      strategyVersionId: target.strategyVersionId,
      positionId: target.id,
      expectedPositionVersion: target.runtimeVersion,
      symbol: target.symbol,
      quoteAt: quote.observedAt,
      quotePrice: String(quote.price),
      processedPrice: { eventId: quote.id, streamId: quote.streamId, throughAt: quote.observedAt },
      factors: {
        source: "independent-risk-guard",
        reason: risk.forceCloseReason,
        equity: risk.equity,
        dailyPnl: risk.dailyPnl,
      },
      action: { kind: "close", settlement: serializeSettlement(settlement) },
    });
  }
}

async function processRealtimeEntry(
  target: Awaited<ReturnType<RuntimeRepository["listRealtimePendingEntries"]>>[number],
) {
  const pending = parseRealtimePendingSignal(target.pendingSignal);
  if (!pending || !target.lastEvaluatedAt) return;
  const quote = getFreshQuote(target.symbol);
  if (!quote || quote.observedAt < pending.detectedAt || quote.observedAt >= pending.expiresAt) {
    return;
  }
  const strategyConfig = strategyConfigSchema.parse(target.executionRun.strategyVersion.config);
  const risk = await runtimeRiskRepository.assess(
    target.executionRun.deployment.workspaceId,
    target.executionRun.deployment.exchangeAccountId,
    target.executionRun.strategyVersion.config,
  );
  if (risk.reason) return;
  const equity = risk.equity;
  const candidate = openExecutionPositionAtQuote(
    pending,
    quote,
    pending.entryRegime,
    equity,
    Math.max(0, equity) / strategyConfig.risk.maxOpenPositions,
    strategyConfig,
  );
  const position = candidate
    ? limitRuntimePositionRisk(
        candidate,
        equity,
        Math.max(0, risk.maximumExposure - risk.exposure),
        strategyConfig,
      )
    : null;
  if (!position) return;
  const result = await runtimeRepository.persistRealtimeEntry({
    entryPriceEventId: quote.id,
    workspaceId: target.executionRun.deployment.workspaceId,
    deploymentId: target.executionRun.deployment.id,
    executionRunId: target.executionRun.id,
    strategyVersionId: target.executionRun.strategyVersionId,
    symbol: target.symbol,
    expectedCandleAt: target.lastEvaluatedAt,
    quoteAt: quote.observedAt,
    quotePrice: String(quote.price),
    unrealizedPnl: String(executionUnrealizedPnl(position, quote.price)),
    maxOpenPositions: strategyConfig.risk.maxOpenPositions,
    entryOrderType: strategyConfig.entry.orderType === "market" ? "MARKET" : "LIMIT",
    position: serializePosition(position),
    factors: realtimeQuoteFactors(quote),
  });
  if (result.applied) {
    logger.info(
      { executionRunId: target.executionRun.id, symbol: target.symbol },
      "Pending signal filled from realtime quote",
    );
  }
}

function getFreshQuote(symbol: string) {
  const quote = latestQuotes.get(symbol);
  if (
    !streamConnected ||
    !priceJournal.healthy ||
    !quote ||
    quote.streamId !== streamSession ||
    quote.observedAt.getTime() < Date.now() - config.RUNTIME_QUOTE_MAX_AGE_MS
  ) {
    return null;
  }
  return quote;
}

async function watchdogLoop() {
  await delay(1_000);
  while (!stopping) {
    const now = new Date();
    const workspaceIds = await listOperationalWorkspaceIds("watchdog");
    for (const workspaceId of workspaceIds) {
      try {
        const signals = await healthRepository.getSignals(workspaceId, now);
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
        await healthRepository.syncIncidents(workspaceId, health.conditions, now);
        logger.debug(
          { workspaceId, status: health.overallStatus, incidents: health.conditions.length },
          "Watchdog workspace cycle completed",
        );
      } catch (error) {
        logger.error({ err: error, workspaceId }, "Watchdog workspace cycle failed");
      }
    }
    try {
      await prisma.workerHeartbeat.upsert({
        where: { workerId: watchdogId },
        update: { lastSeenAt: now, metadata: { workspaceIds } },
        create: {
          workerId: watchdogId,
          service: "watchdog",
          version: "0.1.0",
          lastSeenAt: now,
          metadata: { workspaceIds },
        },
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to write watchdog heartbeat");
    }

    await delay(config.WATCHDOG_INTERVAL_MS);
  }
}

async function listOperationalWorkspaceIds(loop: string) {
  try {
    return await workspaceRepository.listOperationalIds();
  } catch (error) {
    logger.error({ err: error, loop }, "Failed to list operational workspaces");
    return [];
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
      let state = await runtimeRepository.getCycleState({
        workspaceId: target.workspaceId,
        exchangeAccountId: target.exchangeAccountId,
        executionRunId: executionRun.id,
        symbol,
        interval,
        lastCompleteCandleAt,
        candleLimit,
      });
      if (!state.instrument?.enabled || state.instrument.status !== "Trading") {
        if (target.status === "PAUSED") continue;
        throw new RuntimeWorkerError(
          "RUNTIME_INSTRUMENT_UNAVAILABLE",
          `${symbol} недоступен для новых сигналов: статус ${state.instrument?.status ?? "Unknown"}`,
        );
      }

      const continuity = assessCandleContinuity(
        state.candles,
        intervalMs,
        lastCompleteCandleAt,
        candleLimit,
      );
      if (!continuity.complete) {
        logger.warn(
          {
            symbol,
            interval,
            missingCandles: continuity.missing.length,
            from: continuity.expectedStart,
            to: lastCompleteCandleAt,
          },
          "Runtime candle gap detected; starting REST backfill",
        );
        const backfill = await marketClient.getLinearKlinesRange(
          symbol,
          interval,
          continuity.expectedStart,
          lastCompleteCandleAt,
        );
        await marketDataRepository.saveCandles(backfill);
        state = await runtimeRepository.getCycleState({
          workspaceId: target.workspaceId,
          exchangeAccountId: target.exchangeAccountId,
          executionRunId: executionRun.id,
          symbol,
          interval,
          lastCompleteCandleAt,
          candleLimit,
        });
        const restored = assessCandleContinuity(
          state.candles,
          intervalMs,
          lastCompleteCandleAt,
          candleLimit,
        );
        if (!restored.complete) {
          throw new RuntimeWorkerError(
            "RUNTIME_CANDLE_GAP",
            `Для ${symbol} не восстановлено ${restored.missing.length} свечей ${interval}`,
          );
        }
        logger.info(
          { symbol, interval, restoredCandles: backfill.length },
          "Runtime candle continuity restored",
        );
      }
      const signalCursor = state.cursor?.lastEvaluatedAt;
      if (
        state.position &&
        signalCursor &&
        lastCompleteCandleAt.getTime() - signalCursor.getTime() > intervalMs
      ) {
        if (
          lastCompleteCandleAt.getTime() - signalCursor.getTime() >
          config.RUNTIME_RECOVERY_MAX_HOURS * 3600_000
        ) {
          throw new RuntimeRecoveryIncompleteError("Signal recovery exceeds configured limit");
        }
        const start = new Date(signalCursor.getTime() - candleLimit * intervalMs);
        const history = await marketClient.getLinearKlinesRange(
          symbol,
          interval,
          start,
          lastCompleteCandleAt,
        );
        const count =
          Math.round((lastCompleteCandleAt.getTime() - start.getTime()) / intervalMs) + 1;
        if (!assessCandleContinuity(history, intervalMs, lastCompleteCandleAt, count).complete) {
          throw new RuntimeRecoveryIncompleteError("Signal backlog is incomplete");
        }
        await marketDataRepository.saveCandles(history);
        state = await runtimeRepository.getCycleState({
          workspaceId: target.workspaceId,
          exchangeAccountId: target.exchangeAccountId,
          executionRunId: executionRun.id,
          symbol,
          interval,
          lastCompleteCandleAt,
          candleLimit: count,
        });
      }
      const latest = state.candles.at(-1);
      if (!latest || state.candles.length < candleLimit) {
        throw new RuntimeWorkerError(
          "RUNTIME_CANDLES_INSUFFICIENT",
          `Для ${symbol} недостаточно завершённых свечей: ${state.candles.length}/${candleLimit}`,
        );
      }
      if (state.cursor?.lastEvaluatedAt && state.cursor.lastEvaluatedAt >= latest.openTime)
        continue;

      const executionCandles = state.candles.map((candle) => ({
        symbol: candle.symbol,
        openTime: candle.openTime,
        open: candle.open.toNumber(),
        high: candle.high.toNumber(),
        low: candle.low.toNumber(),
        close: candle.close.toNumber(),
        turnover: candle.turnover.toNumber(),
      }));
      const candles = enrichExecutionCandles(executionCandles, strategyConfig);
      const candle = candles.at(-1)!;
      const candleClosedAt = new Date(candle.openTime.getTime() + intervalMs);
      const existingPosition = state.position ? deserializeExecutionPosition(state.position) : null;
      const pendingSignal = parsePendingSignal(state.cursor?.pendingSignal ?? null);
      const realtimePendingSignal = parseRealtimePendingSignal(state.cursor?.pendingSignal ?? null);
      const equity = await runtimeRepository.getDryRunEquity(
        target.workspaceId,
        target.exchangeAccountId,
        String(config.DRY_RUN_INITIAL_BALANCE),
      );
      const tradingDay = getTradingDateKey(new Date(), strategyConfig.schedule.timezone);
      const dailyPnl = state.recentTrades
        .filter(
          (trade) =>
            getTradingDateKey(trade.closedAt, strategyConfig.schedule.timezone) === tradingDay,
        )
        .reduce((sum, trade) => sum + trade.netPnl.toNumber(), 0);
      const lossLimit =
        config.DRY_RUN_INITIAL_BALANCE * (strategyConfig.risk.maxDailyLossPercent / 100);
      const riskAssessment = await runtimeRiskRepository.assess(
        target.workspaceId,
        target.exchangeAccountId,
        target.strategyVersion.config,
      );
      const entriesAllowed =
        target.status === "RUNNING" &&
        target.exchangeConnection?.status === "ACTIVE" &&
        target.exchangeConnection.revokedAt === null &&
        dailyPnl > -lossLimit &&
        !riskAssessment.reason;

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
      let pendingSignalAfter: RuntimePendingSignal | null = null;
      let entryPriceEventId: bigint | undefined;
      let positionRemainsOpen = existingPosition !== null;
      let signalCandidate: PendingExecutionSignal | null = null;

      if (existingPosition && state.position) {
        if (!state.position.managedThroughAt || state.position.managedThroughAt < candleClosedAt)
          continue;
        const freshQuote = getFreshQuote(symbol);
        if (!freshQuote || state.position.priceStreamId !== freshQuote.streamId) continue;
        const settlement =
          candles
            .filter(
              (candidate) =>
                !state.cursor?.lastEvaluatedAt || candidate.openTime > state.cursor.lastEvaluatedAt,
            )
            .map((candidate) =>
              evaluateRuntimeCandleExit(
                existingPosition,
                candidate,
                new Date(candidate.openTime.getTime() + intervalMs),
                strategyConfig,
                freshQuote,
              ),
            )
            .find((candidate) => candidate !== null) ?? null;
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
          decision = {
            action: "HOLD",
            reasonCode: "POSITION_MANAGED",
            summary: "Позиция остаётся открытой; защитные уровни контролирует quote loop",
            factors: runtimeFactors(candle, dailyPnl, equity),
          };
        }
      } else if (pendingSignal && !realtimePendingSignal) {
        decision = {
          action: "SKIP",
          reasonCode: "LEGACY_SIGNAL_DISCARDED",
          summary: "Устаревший сигнал сброшен; ожидается новый сигнал со свежей котировкой",
          factors: runtimeFactors(candle, dailyPnl, equity),
        };
      }

      if (!positionRemainsOpen && target.status === "RUNNING") {
        const signal = getExecutionSignal(candle, strategyConfig);
        signalCandidate = signal;
        if (signal && !entriesAllowed && positionAction.kind === "none") {
          decision = {
            action: "SKIP",
            reasonCode: riskAssessment.reason ?? "ENTRY_GATE_CLOSED",
            summary: "Торговый сигнал отклонён до исполнения общим risk gate",
            factors: runtimeFactors(candle, dailyPnl, equity),
          };
        } else if (signal) {
          const quote = getFreshQuote(symbol);
          const candidate =
            quote &&
            quote.observedAt >= candleClosedAt &&
            quote.observedAt.getTime() < candleClosedAt.getTime() + intervalMs
              ? openExecutionPositionAtQuote(
                  signal,
                  quote,
                  getExecutionMarketRegime(candle),
                  equity,
                  Math.max(0, equity) / strategyConfig.risk.maxOpenPositions,
                  strategyConfig,
                )
              : null;
          const opened =
            candidate && !riskAssessment.reason
              ? limitRuntimePositionRisk(
                  candidate,
                  riskAssessment.equity,
                  Math.max(0, riskAssessment.maximumExposure - riskAssessment.exposure),
                  strategyConfig,
                )
              : null;
          if (opened && positionAction.kind === "none") {
            entryPriceEventId = quote!.id;
            positionAction = {
              kind: "open",
              position: serializePosition(opened),
              markPrice: String(quote!.price),
              unrealizedPnl: String(executionUnrealizedPnl(opened, quote!.price)),
              immediateSettlement: null,
            };
            decision = {
              action: "OPEN",
              reasonCode: "ENTRY_SIGNAL_FILLED_REALTIME",
              summary: `Открыта ${opened.side} позиция сразу после закрытия сигнальной свечи`,
              factors: {
                ...runtimeFactors(candle, dailyPnl, equity),
                executionQuote: realtimeQuoteFactors(quote!),
              },
            };
            positionRemainsOpen = true;
          } else {
            pendingSignalAfter = createRealtimePendingSignal(
              signal,
              candleClosedAt,
              new Date(candleClosedAt.getTime() + intervalMs),
              getExecutionMarketRegime(candle),
            );
            if (positionAction.kind === "none") {
              decision = {
                action: "OPEN",
                reasonCode: "ENTRY_SIGNAL_PENDING",
                summary: `Зафиксирован ${signal.side} сигнал; ожидается realtime quote`,
                factors: runtimeFactors(candle, dailyPnl, equity),
              };
            }
          }
        }
      }

      const decisionAt = new Date();
      const [higherSeries, recentMemory] = await Promise.all([
        marketDataRepository.listClosedCandleSeries({
          symbol,
          intervals: decisionContextTimeframes.map((timeframe) => ({
            interval: bybitIntervals[timeframe],
            intervalMs: timeframeMinutes[timeframe] * 60_000,
          })),
          availableAt: decisionAt,
          limit: decisionContextAnalysisCandleLimit,
        }),
        decisionRepository.listMemory({
          workspaceId: target.workspaceId,
          executionRunId: executionRun.id,
          symbol,
        }),
      ]);
      const primaryFrame = buildDecisionMarketFrame({
        candles: executionCandles,
        timeframe: strategyConfig.universe.timeframe,
        intervalMs,
        availableAt: decisionAt,
        maxCandles: decisionContextStoredCandleLimit,
      });
      const contextSnapshot = createDecisionContextSnapshot({
        workspaceId: target.workspaceId,
        executionRunId: executionRun.id,
        strategyVersionId: target.strategyVersion.id,
        strategyConfigHash: target.strategyVersion.configHash,
        engineVersion: executionRun.engineVersion,
        symbol,
        availableAt: decisionAt.toISOString(),
        primaryFrame,
        higherTimeframes: higherSeries.map((series) =>
          buildDecisionMarketFrame({
            candles: series.candles.map((item) => ({
              symbol: item.symbol,
              openTime: item.openTime,
              open: item.open.toNumber(),
              high: item.high.toNumber(),
              low: item.low.toNumber(),
              close: item.close.toNumber(),
              turnover: item.turnover.toNumber(),
            })),
            timeframe: timeframeForBybitInterval(series.interval),
            intervalMs: series.intervalMs,
            availableAt: decisionAt,
            maxCandles: decisionContextStoredCandleLimit,
          }),
        ),
        account: {
          equity: riskAssessment.equity,
          availableBalance: Math.max(0, riskAssessment.equity - riskAssessment.exposure),
          realizedPnlToday: riskAssessment.dailyPnl,
          openExposure: riskAssessment.exposure,
        },
        position: state.position
          ? {
              id: state.position.id,
              side: state.position.side === "BUY" ? "long" : "short",
              openedAt: state.position.openedAt.toISOString(),
              entryPrice: state.position.entryPrice.toNumber(),
              markPrice: state.position.markPrice?.toNumber() ?? null,
              quantity: state.position.quantity.toNumber(),
              stopPrice: state.position.stopPrice.toNumber(),
              takePrice: state.position.takePrice.toNumber(),
              trailingPrice: state.position.trailingPrice?.toNumber() ?? null,
              unrealizedPnl: state.position.unrealizedPnl.toNumber(),
            }
          : null,
        risk: {
          entriesAllowed,
          maxOpenPositions: riskAssessment.maximumPositions,
          maxDailyLossPercent: strategyConfig.risk.maxDailyLossPercent,
          riskPerTradePercent: strategyConfig.risk.riskPerTradePercent,
          maximumAccountExposure: riskAssessment.maximumExposure,
          remainingAccountExposure: Math.max(
            0,
            riskAssessment.maximumExposure - riskAssessment.exposure,
          ),
        },
        memory: recentMemory.map((item) => ({
          decisionId: item.id,
          decidedAt: item.decidedAt.toISOString(),
          action: item.action,
          reasonCode: item.reasonCode,
          summary: item.summary,
          providerId: item.providerId,
          mode: item.mode === "SHADOW" ? "shadow" : "execution",
        })),
      });
      const candidate = ruleBasedDecisionCandidate({
        signal: signalCandidate,
        decision,
        strategyConfig,
        generatedAt: decisionAt,
        validUntil: new Date(decisionAt.getTime() + intervalMs),
      });
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
        expectedPositionVersion: state.position?.runtimeVersion ?? null,
        ...(entryPriceEventId === undefined ? {} : { entryPriceEventId }),
        pendingSignal: pendingSignalAfter,
        maxOpenPositions: strategyConfig.risk.maxOpenPositions,
        entryOrderType: strategyConfig.entry.orderType === "market" ? "MARKET" : "LIMIT",
        providerVersion: executionRun.engineVersion,
        contextSnapshot: {
          workspaceId: target.workspaceId,
          executionRunId: executionRun.id,
          strategyVersionId: target.strategyVersion.id,
          symbol,
          schemaVersion: decisionContextSchemaVersion,
          featureSetVersion: decisionFeatureSetVersion,
          contentHash: contextSnapshot.contentHash,
          availableAt: decisionAt,
          context: contextSnapshot.snapshot,
        },
        candidate,
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
        schemaVersion: metricProvenanceSchemaVersion,
        environment: executionInput.kind,
        exchange: dataset.exchange,
        source: dataset.source,
        instrumentType: dataset.instrumentType,
        datasetVersion: `dataset-snapshot@${dataset.schemaVersion}`,
        datasetId: dataset.id,
        datasetHash: dataset.contentHash,
        configVersion: `strategy-config@${strategyConfig.schemaVersion}`,
        configHash: job.configHash,
        engineVersion: validationEngineVersion,
        asOf: dataset.endsAt.toISOString(),
        freshness: "immutable",
        fundingPolicy,
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
  schemaVersion: number;
  source: string;
  exchange: string;
  instrumentType: string;
  contentHash: string;
  symbols: string[];
  endsAt: Date;
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

    const requiredCandles = minimumExecutionCandleCount(strategyConfig);
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
    schemaVersion: snapshot.schemaVersion,
    source: snapshot.source,
    exchange: snapshot.exchange,
    instrumentType: snapshot.instrumentType,
    contentHash: snapshot.contentHash,
    symbols,
    endsAt: snapshot.endsAt,
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
  marketStreamAbortController.abort();
  logger.info({ signal }, "Shutting down worker");
  try {
    await priceJournal.flushAll();
  } catch (error) {
    logger.error({ err: error }, "Final journal flush failed; recovery required on restart");
  }
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

class ScheduledCredentialsUnreadableError extends Error {}

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

type RuntimePendingSignal = PendingExecutionSignal & {
  mode: "realtime";
  detectedAt: string;
  expiresAt: string;
  entryRegime: ExecutionMarketRegime;
};

function createRealtimePendingSignal(
  signal: PendingExecutionSignal,
  detectedAt: Date,
  expiresAt: Date,
  entryRegime: ExecutionMarketRegime,
): RuntimePendingSignal {
  return {
    ...signal,
    mode: "realtime",
    detectedAt: detectedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    entryRegime,
  };
}

function parseRealtimePendingSignal(value: unknown):
  | (PendingExecutionSignal & {
      detectedAt: Date;
      expiresAt: Date;
      entryRegime: ExecutionMarketRegime;
    })
  | null {
  const signal = parsePendingSignal(value);
  if (!signal || !value || Array.isArray(value) || typeof value !== "object") return null;
  if (
    !("mode" in value) ||
    value.mode !== "realtime" ||
    !("detectedAt" in value) ||
    typeof value.detectedAt !== "string" ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "string" ||
    !("entryRegime" in value) ||
    (value.entryRegime !== "bull" &&
      value.entryRegime !== "bear" &&
      value.entryRegime !== "neutral" &&
      value.entryRegime !== "unknown")
  ) {
    return null;
  }
  const detectedAt = new Date(value.detectedAt);
  const expiresAt = new Date(value.expiresAt);
  if (
    !Number.isFinite(detectedAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= detectedAt
  ) {
    return null;
  }
  return { ...signal, detectedAt, expiresAt, entryRegime: value.entryRegime };
}

function realtimeQuoteFactors(quote: ExecutionQuote) {
  return {
    source: "bybit-public-websocket",
    quote: { price: quote.price, observedAt: quote.observedAt.toISOString() },
  };
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
    breakoutHigh: number | null;
    breakoutLow: number | null;
    meanReversionZScore: number | null;
    momentumPercent: number | null;
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
      breakoutHigh: candle.breakoutHigh,
      breakoutLow: candle.breakoutLow,
      meanReversionZScore: candle.meanReversionZScore,
      momentumPercent: candle.momentumPercent,
    },
    risk: { dailyPnl, equity },
  };
}

function ruleBasedDecisionCandidate(input: {
  signal: PendingExecutionSignal | null;
  decision: Parameters<RuntimeRepository["persistCycle"]>[0]["decision"];
  strategyConfig: ReturnType<typeof strategyConfigSchema.parse>;
  generatedAt: Date;
  validUntil: Date;
}): DecisionCandidate {
  const side = input.signal?.side ?? null;
  return {
    action: side === "long" ? "BUY" : side === "short" ? "SELL" : "HOLD",
    side,
    tradable: side !== null,
    confidence: side === null ? 0 : 1,
    riskBudgetPercent: side === null ? null : input.strategyConfig.risk.riskPerTradePercent,
    stopLossPercent: side === null ? null : input.strategyConfig.exit.stopLossPercent,
    takeProfitPercent: side === null ? null : input.strategyConfig.exit.takeProfitPercent,
    horizonCandles: null,
    reasonCodes: [input.decision.reasonCode.toUpperCase().replaceAll(/[^A-Z0-9_:-]/g, "_")],
    summary: input.decision.summary,
    generatedAt: input.generatedAt.toISOString(),
    validUntil: input.validUntil.toISOString(),
  };
}

function timeframeForBybitInterval(interval: string): keyof typeof timeframeMinutes {
  const timeframe = Object.entries(bybitIntervals).find(([, value]) => value === interval)?.[0];
  if (!timeframe || !(timeframe in timeframeMinutes)) {
    throw new RuntimeWorkerError(
      "RUNTIME_CONTEXT_TIMEFRAME_UNKNOWN",
      `Неизвестный interval decision context: ${interval}`,
    );
  }
  return timeframe as keyof typeof timeframeMinutes;
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

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function addMilliseconds(value: Date, milliseconds: number) {
  return new Date(value.getTime() + milliseconds);
}

function addMinutes(value: Date, minutes: number) {
  return addMilliseconds(value, minutes * 60_000);
}

function addHours(value: Date, hours: number) {
  return addMinutes(value, hours * 60);
}

function healthThresholds() {
  return {
    workerStaleMs: heartbeatIntervalMs * 3,
    marketStaleMs: config.MARKET_POLL_INTERVAL_MS * 3,
    accountStaleMs: config.ACCOUNT_SNAPSHOT_INTERVAL_MS * 2,
    queueLagMs: 5 * 60_000,
    outboxLagMs: 5 * 60_000,
    exchangeVerificationOverdueMs: config.EXCHANGE_VERIFICATION_POLL_INTERVAL_MS * 3,
  };
}

const validationPollIntervalMs = 2_000;
const validationLeaseMs = 5 * 60_000;
const maximumDatasetCandles = 250_000;
const persistenceBatchSize = 2_000;
const timeframeMinutes = { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 } as const;
const decisionContextTimeframes = ["1h", "4h"] as const;
const decisionContextAnalysisCandleLimit = 80;
const decisionContextStoredCandleLimit = 32;
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

function assessCandleContinuity(
  candles: Array<{ openTime: Date }>,
  intervalMs: number,
  expectedLatest: Date,
  requiredCount: number,
) {
  const expectedStart = new Date(expectedLatest.getTime() - (requiredCount - 1) * intervalMs);
  const available = new Set(candles.map((candle) => candle.openTime.getTime()));
  const missing: Date[] = [];
  for (
    let timestamp = expectedStart.getTime();
    timestamp <= expectedLatest.getTime();
    timestamp += intervalMs
  ) {
    if (!available.has(timestamp)) missing.push(new Date(timestamp));
  }
  return { complete: missing.length === 0, expectedStart, missing };
}

logger.info({ workerId }, "Worker started");
await Promise.all([
  heartbeatLoop(),
  marketDataLoop(),
  candleDataLoop(),
  instrumentMetadataLoop(),
  marketStreamLoop(),
  priceJournalLoop(),
  accountSnapshotLoop(),
  validationJobLoop(),
  exchangeVerificationLoop(),
  runtimeLoop(),
  runtimeQuoteLoop(),
  riskGuardLoop(),
  watchdogLoop(),
]);
