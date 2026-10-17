import {
  readExecutionPositionExitPolicy,
  executionSignalExitEnabled,
  executionHoldingDeadline,
} from "@cryptoanal/application";
import { runRuntimeLane, type RuntimeLaneTiming } from "./runtime-lane";
import { RuntimeTaskProgress } from "./runtime-task-progress";
import { selectPriorityExit } from "./runtime-priority-exit";
import { RuntimeLatency } from "./runtime-latency";
import { RuntimeProtectionWatch, RuntimeProtectionPreempted } from "./runtime-protection-watch";
import { RuntimeLockBusyError } from "@cryptoanal/persistence";
import { executionPolicySettingsFromConfig } from "./execution-policy-settings";
import {
  recoverCausalRuntimeGap,
  selectRecoveryTrades,
  type RecoveryTradeSnapshot,
} from "./causal-recovery";
import { causalRecoveryModel, readExecutionRecoveryModel } from "@cryptoanal/application";
import { ExecutionPolicyRepository, readPinnedExecutionPolicy } from "@cryptoanal/persistence";
import { enabledFundingPolicy, type ExecutionFundingDataset } from "@cryptoanal/application";
import { FundingRepository, hashTracePayload } from "@cryptoanal/persistence";
import { runtimeErrorMessage } from "./runtime-error";
import { runtimeTraceInputs, type RuntimeTraceRecovery } from "./runtime-trace";
import { replayPendingEntryEvents } from "./runtime-pending-entry";
import {
  positionIndicatorCheckpoint,
  replayPositionIndicators,
} from "./runtime-position-indicators";
import {
  storeExecutionMarketData,
  entryLiquidityVersion,
  entryLiquidityBookFailure,
  evaluateExecutionEntryOrder,
  openExecutionPositionAtFill,
  readEntryExecutionMarker,
  readExecutionExitPolicy,
  defaultLiquidityExitPolicy,
  isLiquidityExitPolicy,
  type ExecutionEntryOrder,
  readExecutionProfitProtectionState,
  buildDecisionMarketFrame,
  createDecisionContextSnapshot,
  decisionContextSchemaVersion,
  decisionFeatureSetVersion,
  advanceExecutionIndicators,
  readExecutionIndicatorCheckpoint,
  executionIndicatorVersion,
  executionEngineVersion,
  evaluateHealth,
  settleExecutionPosition,
  limitExecutionPositionRisk,
  executionUnrealizedPnl,
  getExecutionSignal,
  getExecutionMarketRegime,
  getExecutionTradingSession,
  metricProvenanceSchemaVersion,
  minimumExecutionCandleCount,
  runValidationEngine,
  validationEngineVersion,
  type ExecutionStrategyConfig,
  type ExecutionIndicatorCheckpoint,
  type EnrichedExecutionCandle,
  type ExecutionMarketRegime,
  type ExecutionPosition,
  type ExecutionQuote,
  type ExecutionSettlement,
  type DecisionCandidate,
  type PendingExecutionSignal,
  type ValidationCandle,
  readExecutionInstrumentRules,
  executionLimitPrice,
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
  captureInstrumentRules,
  type RuntimeEntryWaitReason,
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
  runtimeEntryExpiresAt,
  runtimeEntryQuoteWaitReason,
  runtimeMarketEntryFailure,
  RuntimeRiskRepository,
  PriceEventRepository,
  PriceArchiveRepository,
  type PriceEventInput,
  RuntimeStateConflictError,
  ValidationDatasetConflictError,
  ValidationInstrumentRulesError,
  ValidationRepository,
  WorkspaceRepository,
  type ClaimedValidationJob,
  type ValidationDatasetCandlePersistenceInput,
} from "@cryptoanal/persistence";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { OrderedPriceJournal } from "./price-journal";
import {
  forEachConcurrent,
  processRuntimePriceEvents,
  type RuntimeSignalEvent,
} from "./runtime-price-processor";
import { RecoveryRequestCache } from "./recovery-request-cache";
import { processRuntimeSymbols } from "./runtime-symbol-loop";
import {
  loadValidationIndicatorSeed,
  validationIndicatorSource,
  type ValidationIndicatorSource,
} from "./runtime-indicator-seed";
import { restoreRevisedIndicators } from "./runtime-indicator-revision";
import { signalAvailabilityTimes } from "./runtime-signal-order";
import { runtimeRecoveryMinuteRange, RuntimeRecoveryIncompleteError } from "./runtime-recovery";

const heartbeatIntervalMs = 15_000;
const workerId = `worker-${randomUUID()}`;
const watchdogId = `${workerId}:watchdog`;
const config = loadServerConfig();
const prisma = createPrismaClient(config.DATABASE_URL, {
  maxConnections: 4,
  applicationName: "cryptoanal-background",
  statementTimeoutMs: 20000,
});
const tradingPrisma = createPrismaClient(config.DATABASE_URL, {
  maxConnections: 6,
  applicationName: "cryptoanal-trading",
  statementTimeoutMs: 4000,
});
const entryPrisma = createPrismaClient(config.DATABASE_URL, {
  maxConnections: 2,
  applicationName: "cryptoanal-entry",
  statementTimeoutMs: 4000,
});
const protectionPrisma = createPrismaClient(config.DATABASE_URL, {
  maxConnections: 2,
  applicationName: "cryptoanal-protection",
  statementTimeoutMs: 4000,
});
const journalPrisma = createPrismaClient(config.DATABASE_URL, {
  maxConnections: 2,
  applicationName: "cryptoanal-journal",
  statementTimeoutMs: 4000,
});
const latency = new RuntimeLatency();
const taskProgress = new RuntimeTaskProgress();
const protectionWatch = new RuntimeProtectionWatch();
const indicatorSeedCache = new RecoveryRequestCache<
  Record<string, { checkpoint: ExecutionIndicatorCheckpoint; candle: EnrichedExecutionCandle }>
>(Date.now, 64, 86400_000);
const marketDataRepository = new MarketDataRepository(prisma);
const marketUniverseRepository = new MarketUniverseRepository(prisma);
const accountSnapshotRepository = new AccountSnapshotRepository(prisma);
const validationRepository = new ValidationRepository(prisma);
const executionPolicyRepository = new ExecutionPolicyRepository(prisma);
const executionPolicySettings = executionPolicySettingsFromConfig(config);
const runtimeRiskPolicy = {
  initialBalance: config.DRY_RUN_INITIAL_BALANCE,
  maxDailyLossPercent: config.RUNTIME_MAX_DAILY_LOSS_PERCENT,
  maxAccountExposurePercent: config.RUNTIME_MAX_ACCOUNT_EXPOSURE_PERCENT,
  maxOpenPositions: config.RUNTIME_MAX_OPEN_POSITIONS,
  maxQuoteAgeMs: config.RUNTIME_QUOTE_MAX_AGE_MS,
};
const runtimeProfitProtectionPolicy = config.RUNTIME_PROFIT_PROTECTION_ENABLED_AT
  ? {
      enabledAt: config.RUNTIME_PROFIT_PROTECTION_ENABLED_AT,
      breakEvenActivationR: config.RUNTIME_PROFIT_BREAK_EVEN_ACTIVATION_R,
      trailingActivationR: config.RUNTIME_PROFIT_TRAILING_ACTIVATION_R,
      trailingDistanceR: config.RUNTIME_PROFIT_TRAILING_DISTANCE_R,
    }
  : null;
const runtimeMarketEntryPolicy = {
  ttlMs: config.RUNTIME_MARKET_ENTRY_TTL_MS,
  maxDeviationBps: config.RUNTIME_MARKET_ENTRY_MAX_DEVIATION_BPS,
};
const runtimeEntryLiquidityPolicy = {
  maximumSpreadBps: config.RUNTIME_ENTRY_MAX_SPREAD_BPS,
  maximumSlippageBps: config.RUNTIME_ENTRY_MAX_SLIPPAGE_BPS,
  maximumBookAgeMs: config.RUNTIME_ENTRY_BOOK_MAX_AGE_MS,
  makerParticipationBps: config.RUNTIME_ENTRY_MAKER_PARTICIPATION_BPS,
};
const fundingRepository = new FundingRepository(prisma);
function makeRuntimeRepository(client: typeof prisma) {
  return new RuntimeRepository(
    client,
    runtimeRiskPolicy,
    runtimeMarketEntryPolicy,
    {
      retentionDays: config.RUNTIME_TRACE_RETENTION_DAYS,
      profitProtectionPolicy: runtimeProfitProtectionPolicy,
    },
    {
      ...defaultLiquidityExitPolicy,
      triggerSource: config.RUNTIME_EXIT_TRIGGER_SOURCE,
      maximumSpreadBps: config.RUNTIME_EXIT_MAX_SPREAD_BPS,
      maximumSlippageBps: config.RUNTIME_EXIT_MAX_SLIPPAGE_BPS,
      maximumBookAgeMs: config.RUNTIME_EXIT_BOOK_MAX_AGE_MS,
      orderTtlMs: config.RUNTIME_EXIT_ORDER_TTL_MS,
    },
    enabledFundingPolicy,
    causalRecoveryModel,
    true,
  );
}
const runtimeRepository = makeRuntimeRepository(tradingPrisma);
const entryRuntimeRepository = makeRuntimeRepository(entryPrisma);
const protectionRuntimeRepository = makeRuntimeRepository(protectionPrisma);
const runtimeRiskRepository = new RuntimeRiskRepository(protectionPrisma, runtimeRiskPolicy, true);
const entryRiskRepository = new RuntimeRiskRepository(entryPrisma, runtimeRiskPolicy, true);
const decisionRepository = new DecisionRepository(prisma);
const priceEventRepository = new PriceEventRepository(tradingPrisma);
const priceWriterRepository = new PriceEventRepository(journalPrisma, true);
const priorityPriceRepository = new PriceEventRepository(protectionPrisma);
const priorityScans = new Map<string, { version: number; cursor: bigint }>();
const writerClaims = new Set<Promise<boolean>>();
async function claimMarketWriter() {
  if (stopping) return false;
  const pending = priceWriterRepository.claimWriter(workerId);
  writerClaims.add(pending);
  try {
    return await pending;
  } finally {
    writerClaims.delete(pending);
  }
}
const priceArchiveRepository = new PriceArchiveRepository(prisma);
const tradingPriceArchiveRepository = new PriceArchiveRepository(tradingPrisma);
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
type JournalQuote = ExecutionQuote & { id: bigint; streamId: string; receivedAt: Date };
const latestQuotes = new Map<string, JournalQuote>();
const recoveryRequests = new RecoveryRequestCache<
  Awaited<ReturnType<BybitPublicMarketClient["getLinearKlinesRange"]>>
>();
let streamSession = randomUUID();
let streamConnected = false;
let streamContext = {
  id: streamSession,
  writerId: workerId,
  cause: "worker-start",
  startedAt: new Date(),
} as Parameters<PriceEventRepository["recordStream"]>[0];
let streamRecord = Promise.resolve<unknown>(null);
let everConnected = false;
let lastDisconnect: { at: Date; code?: number; reason: string } | null = null;
let nextStreamCause = "worker-start";
function beginStream(cause: string) {
  const previousStreamId = streamSession;
  streamSession = randomUUID();
  streamContext = {
    id: streamSession,
    writerId: workerId,
    cause,
    ...(everConnected ? { previousStreamId } : {}),
    startedAt: new Date(),
    ...(lastDisconnect
      ? {
          interruptedAt: lastDisconnect.at,
          ...(lastDisconnect.code === undefined ? {} : { disconnectCode: lastDisconnect.code }),
          disconnectReason: lastDisconnect.reason.slice(0, 500),
        }
      : {}),
  };
  streamRecord = priceWriterRepository
    .recordStream(streamContext)
    .catch((err) => logger.warn({ err }, "Stream segment metadata unavailable"));
}
const recentRecoveryCache = new RecoveryRequestCache<RecoveryTradeSnapshot>();
const priceJournal = new OrderedPriceJournal<PriceEventInput>(
  async (events) => {
    const startedAt = Date.now();
    for (const event of events)
      if (event.receivedAt) latency.observe("journal.queueMs", startedAt - +event.receivedAt);
    const started = performance.now();
    const saved = await priceWriterRepository.append(events, workerId);
    latency.observe("journal.writeMs", performance.now() - started);
    for (const event of saved) {
      latency.observe("journal.eventToCommitMs", Date.now() - +event.receivedAt);
      const current = latestQuotes.get(event.symbol);
      if (!current || event.observedAt >= current.observedAt) {
        latestQuotes.set(event.symbol, {
          id: event.id,
          symbol: event.symbol,
          price: Number(event.price),
          observedAt: event.observedAt,
          receivedAt: event.receivedAt,
          streamId: event.streamId,
        });
      }
    }
  },
  20000,
  config.RUNTIME_JOURNAL_BATCH_SIZE,
  handleJournalOverflow,
);
function handleJournalOverflow() {
  const overflowStream = streamSession,
    overflowAt = new Date();
  void streamRecord
    .then(() =>
      priceWriterRepository.closeStream(overflowStream, overflowAt, undefined, "journal-overflow"),
    )
    .catch((err) => logger.warn({ err }, "Stream overflow metadata unavailable"));
  lastDisconnect = { at: overflowAt, reason: "journal-overflow" };
  beginStream("journal-overflow");
  latestQuotes.clear();
  logger.error("Market price journal overflow; recovery required");
}

let stopping = false;

async function writeHeartbeat() {
  const workspaceIds = await workspaceRepository.listOperationalIds();
  const metadata = {
    workspaceIds,
    executionEngineVersion,
    validationEngineVersion,
    latency: latency.snapshot(),
    taskProgress: taskProgress.snapshot(),
    queues: {
      journal: priceJournal.size,
      journalOldestAgeMs: priceJournal.oldest?.receivedAt
        ? Date.now() - +priceJournal.oldest.receivedAt
        : 0,
      protectedWaits: protectionWatch.size,
    },
  };
  await prisma.workerHeartbeat.upsert({
    where: { workerId },
    update: {
      lastSeenAt: new Date(),
      metadata,
    },
    create: {
      workerId,
      service: "worker",
      version: "0.1.0",
      lastSeenAt: new Date(),
      metadata,
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

async function fundingLoop() {
  while (!stopping) {
    try {
      const [tickers, positions, series] = await taskProgress.during("funding", "load", () =>
        Promise.all([
          marketClient.getLinearTickers(),
          fundingRepository.listOpen(),
          listRequiredMarketSeries(),
        ]),
      );
      const symbols = [
        ...new Set([...series.map((s) => s.symbol), ...positions.map((p) => p.symbol)]),
      ].filter((s) => s.endsWith("USDT"));
      for (const symbol of symbols) {
        if (stopping) break;
        try {
          await taskProgress.during("funding", symbol, async () => {
            const ticker = tickers.find((t) => t.symbol === symbol);
            if (!ticker?.nextFundingAt || ticker.nextFundingAt <= ticker.observedAt)
              throw new Error("Funding schedule unavailable");
            const held = positions.filter((p) => p.symbol === symbol),
              throughAt = new Date(Math.min(Date.now(), +ticker.observedAt));
            const startsAt = new Date(
              held.reduce((min, p) => Math.min(min, +p.openedAt), +throughAt),
            );
            const prior = await prisma.fundingMarketState.findUnique({
              where: { symbol },
              include: { snapshot: true },
            });
            if (prior && hashTracePayload(prior.snapshot.payload) !== prior.snapshot.payloadHash)
              throw new Error("Funding cache checksum mismatch");
            const reusable =
              prior &&
              prior.checkedFrom <= startsAt &&
              +prior.nextFundingAt === +ticker.nextFundingAt &&
              prior.nextFundingAt > throughAt &&
              !held.some(
                (p) => (p.fundingState as { status?: string } | null)?.status === "pending",
              );
            const data: ExecutionFundingDataset = reusable
              ? (prior.snapshot.payload as unknown as ExecutionFundingDataset)
              : {
                  version: 1,
                  policy: enabledFundingPolicy,
                  symbols: [symbol],
                  startsAt: startsAt.toISOString(),
                  throughAt: throughAt.toISOString(),
                  coverage: "complete",
                  events: await marketClient.getLinearFundingHistory(symbol, startsAt, throughAt),
                };
            await fundingRepository.saveMarket({
              data,
              nextFundingAt: ticker.nextFundingAt,
              observedAt: ticker.observedAt,
            });
            for (const p of held) await fundingRepository.synchronizePosition(p.id);
          });
        } catch (error) {
          await fundingRepository.markUnavailable(symbol, "FUNDING_SOURCE_UNAVAILABLE");
          logger.warn(
            { err: error, symbol },
            "Funding source unavailable; protective price processing continues",
          );
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Funding synchronization failed");
    }
    await delay(15000);
  }
}

async function marketStreamLoop() {
  while (!stopping) {
    const leaseAbort = new AbortController();
    let renewal: ReturnType<typeof setInterval> | undefined;
    try {
      if (!(await claimMarketWriter())) {
        await delay(5000);
        continue;
      }
      if (stopping) break;
      renewal = setInterval(() => {
        if (stopping) return;
        void claimMarketWriter()
          .then((owned) => {
            if (!owned) {
              nextStreamCause = "writer-lease-lost";
              leaseAbort.abort();
            }
          })
          .catch(() => {
            nextStreamCause = "writer-lease-unavailable";
            leaseAbort.abort();
          });
      }, 5000);
      await marketStreamClient.run(
        {
          getSubscriptions: async () => {
            const symbols = await marketDataRepository.listEnabledSymbols();
            const series = await listRequiredMarketSeries();
            const tradeSymbols = [...new Set([...symbols, ...series.map(({ symbol }) => symbol)])];
            return {
              tickerSymbols: [],
              tradeSymbols,
              orderbookSymbols: tradeSymbols,
              klines: series.map(({ symbol, interval }) => ({ symbol, interval })),
            };
          },
          onQuote: () => {},
          onOrderbookUnavailable: ({ symbol, error, continuity }) => {
            logger.warn(
              { symbol, err: error, continuity },
              "Orderbook unavailable; public trade stream continues",
            );
          },
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
            latency.observe("market.deliveryMs", +quote.receivedAt - +quote.observedAt);
            if (
              !priceJournal.enqueue({
                eventKey: `bybit-trade:${quote.symbol}:${quote.tradeId}`,
                symbol: quote.symbol,
                price: quote.price,
                observedAt: quote.observedAt,
                receivedAt: quote.receivedAt,
                executionData: storeExecutionMarketData({
                  source: "bybit-public",
                  depth: 1,
                  trade: {
                    quantity: quote.quantity,
                    takerSide: quote.takerSide,
                    blockTrade: quote.blockTrade,
                    rpiTrade: quote.rpiTrade,
                  },
                  book: quote.book
                    ? {
                        bid: quote.book.bid,
                        ask: quote.book.ask,
                        observedAt: +quote.book.observedAt,
                        receivedAt: +quote.book.receivedAt,
                        updateId: quote.book.updateId,
                        sequence: quote.book.sequence,
                      }
                    : null,
                }),
                streamId: streamSession,
                streamContext,
              })
            ) {
              latency.increment("journal.overflowDropped");
            }
          },
          onClosedCandle: async (candle) => {
            await marketDataRepository.saveCandles([candle]);
          },
          onConnected: () => {
            beginStream(everConnected ? nextStreamCause : "worker-start");
            nextStreamCause = "reconnect";
            everConnected = true;
            streamConnected = true;
            latestQuotes.clear();
            logger.info("Bybit public market stream connected");
          },
          onDisconnected: (code, reason) => {
            streamConnected = false;
            const interruptedAt = new Date();
            lastDisconnect = { at: interruptedAt, code, reason };
            const closedStream = streamSession;
            void streamRecord
              .then(() =>
                priceWriterRepository.closeStream(closedStream, interruptedAt, code, reason),
              )
              .catch((err) => logger.warn({ err }, "Disconnect metadata unavailable"));
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
  let retryMs = 50;
  while (!stopping) {
    try {
      await priceJournal.flush();
      retryMs = 50;
    } catch (error) {
      latency.increment("journal.writeFailure");
      if (!runtimeDeferred(error))
        logger.error({ err: error }, "Market price journal write failed; entries blocked");
      await delay(retryMs);
      retryMs = Math.min(1000, retryMs * 2);
      continue;
    }
    await delay(priceJournal.size ? 1 : 25);
  }
}

async function priceArchiveLoop() {
  while (!stopping) {
    try {
      const result = await priceArchiveRepository.archiveAndPrune(
        new Date(Date.now() - config.RUNTIME_EVENT_RETENTION_HOURS * 3600_000),
      );
      if (result.count === 10_000) {
        await delay(50);
        continue;
      }
      const cleanup = await priceArchiveRepository.cleanup();
      logger.info({ ...result, cleanup }, "Price archive maintenance completed");
    } catch (error) {
      logger.error({ err: error }, "Price archive maintenance failed; hot history retained");
    }
    await delay(60_000);
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
            if (runtimeDeferred(error)) continue;
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

function runtimeDeferred(error: unknown) {
  if (error instanceof RuntimeProtectionPreempted) {
    latency.increment("protection.preempted");
    return true;
  }
  if (error instanceof RuntimeLockBusyError) {
    latency.increment("database.lockBusy");
    return true;
  }
  return false;
}
async function runtimeQuoteLoop() {
  await runRuntimeLane({
    stopping: () => stopping,
    intervalMs: config.RUNTIME_QUOTE_INTERVAL_MS,
    concurrency: config.RUNTIME_POSITION_CONCURRENCY,
    wait: delay,
    load: async () => {
      const positions = [];
      for (const workspaceId of await listOperationalWorkspaceIds("runtime quote"))
        positions.push(...(await runtimeRepository.listRealtimePositions(workspaceId)));
      return positions.sort(
        (a, b) =>
          Number(!a.exitState) - Number(!b.exitState) ||
          +(a.managedThroughAt ?? a.openedAt) - +(b.managedThroughAt ?? b.openedAt),
      );
    },
    process: async (position, laneTiming) => {
      const start = performance.now();
      try {
        await taskProgress.during("position", position.id, () =>
          processRealtimePosition(position, laneTiming),
        );
      } finally {
        latency.observe("position.workMs", performance.now() - start);
      }
    },
    onError: async (error, position) => {
      if (runtimeDeferred(error)) return;
      if (position)
        await runtimeRepository.recordFailure({
          workspaceId: position.workspaceId,
          executionRunId: position.executionRunId,
          symbol: position.symbol,
          code: "RUNTIME_RECOVERY_REQUIRED",
          message: errorMessage(error).slice(0, 500),
        });
      latency.increment("position.failure");
      logger.error({ err: error, positionId: position?.id }, "Realtime position update failed");
    },
  });
}
async function runtimeEntryLoop() {
  await runRuntimeLane({
    stopping: () => stopping,
    intervalMs: config.RUNTIME_ENTRY_INTERVAL_MS,
    concurrency: config.RUNTIME_ENTRY_CONCURRENCY,
    wait: delay,
    load: async () => {
      const entries = [];
      for (const workspaceId of await listOperationalWorkspaceIds("runtime entry")) {
        try {
          await entryRuntimeRepository.cancelInactiveEntryOrders(workspaceId);
        } catch (error) {
          if (!runtimeDeferred(error))
            logger.error({ err: error, workspaceId }, "Entry cancellation failed");
        }
        entries.push(...(await entryRuntimeRepository.listRealtimePendingEntries(workspaceId)));
      }
      return entries;
    },
    process: async (pending) => {
      const start = performance.now();
      try {
        await taskProgress.during("entry", `${pending.executionRun.id}:${pending.symbol}`, () =>
          processRealtimeEntry(pending),
        );
      } finally {
        latency.observe("entry.workMs", performance.now() - start);
      }
    },
    onError: (error, pending) => {
      if (runtimeDeferred(error)) return;
      latency.increment("entry.failure");
      logger.error({ err: error, symbol: pending?.symbol }, "Realtime pending entry failed");
    },
  });
}
async function runtimeProtectionLoop() {
  let candidates: Awaited<ReturnType<RuntimeRepository["listRealtimePositions"]>> = [];
  let refreshedAt = 0;
  while (!stopping) {
    try {
      await protectionWatch.poll(2, (error) => {
        if (!runtimeDeferred(error)) logger.error({ err: error }, "Priority protection failed");
      });
      if (Date.now() - refreshedAt >= 500) {
        candidates = [];
        for (const workspaceId of await listOperationalWorkspaceIds("runtime protection"))
          candidates.push(
            ...(await protectionRuntimeRepository.listRealtimePositions(workspaceId)),
          );
        refreshedAt = Date.now();
        const active = new Set(candidates.map((position) => position.id));
        for (const id of priorityScans.keys()) if (!active.has(id)) priorityScans.delete(id);
      }
      await forEachConcurrent(candidates, 2, async (position) => {
        try {
          if (position.exitState)
            await protectionRuntimeRepository.advanceLiquidityPosition({
              workspaceId: position.workspaceId,
              executionRunId: position.executionRunId,
              positionId: position.id,
              expectedPositionVersion: position.runtimeVersion,
            });
          else if (
            (executionHoldingDeadline(deserializeExecutionPosition(position))?.getTime() ??
              Infinity) <= Date.now() ||
            protectionWatch.size > 0 ||
            latestQuotes.get(position.symbol)?.streamId !== position.priceStreamId
          )
            await protectWaitingPosition(
              position,
              deserializeExecutionPosition(position),
              position.managedThroughAt ?? position.openedAt,
              position.runtimeVersion,
            );
        } catch (error) {
          if (!runtimeDeferred(error))
            logger.error({ err: error, positionId: position.id }, "Priority exit failed");
        }
      });
    } catch (error) {
      if (!runtimeDeferred(error)) logger.error({ err: error }, "Priority protection cycle failed");
    }
    await delay(config.RUNTIME_PROTECTION_INTERVAL_MS);
  }
}
async function protectWaitingPosition(
  target: Awaited<ReturnType<RuntimeRepository["listRealtimePositions"]>>[number],
  position: ExecutionPosition,
  through: Date,
  expectedVersion: number,
) {
  const latest = latestQuotes.get(target.symbol),
    policy = readPinnedExecutionPolicy(target.executionPolicy);
  const age =
    policy?.payload.settings.accountSafety.maxQuoteAgeMs ?? config.RUNTIME_QUOTE_MAX_AGE_MS;
  if (
    !latest ||
    latest.id <= (target.priceEventId ?? 0n) ||
    latest.observedAt < through ||
    latest.observedAt < position.openedAt ||
    Date.now() - +latest.receivedAt > age ||
    Date.now() - +latest.observedAt > age ||
    +latest.observedAt > Date.now() + 1000
  )
    return false;
  const previous = priorityScans.get(target.id);
  if (previous && previous.version > expectedVersion) return false;
  const cursor = previous?.version === expectedVersion ? previous.cursor : target.priceEventId;
  if (cursor !== null && cursor !== undefined && cursor >= latest.id) return false;
  const events = (await priorityPriceRepository.after(target.symbol, cursor ?? null, through))
    .filter((event) => event.id <= latest.id)
    .map((event) => ({ ...event, price: Number(event.price) }));
  const selected = selectPriorityExit({
    position,
    through,
    events,
    latest,
    config: strategyConfigSchema.parse(target.strategyVersion.config),
  });
  if (!selected) {
    priorityScans.set(target.id, {
      version: expectedVersion,
      cursor: events.at(-1)?.id ?? cursor ?? 0n,
    });
    return false;
  }
  const { event: quote, settlement } = selected;
  const recovery = {
    reason:
      target.priceStreamId === null
        ? "unconfirmed-stream"
        : target.priceStreamId !== quote.streamId
          ? "stream-change"
          : "history-wait",
    fromAt: through.toISOString(),
    toAt: quote.observedAt.toISOString(),
    source: "journal-protection",
    quality: "incomplete",
    ambiguity: "unreconstructed-gap",
  };
  const result = await protectionRuntimeRepository.persistRealtimeQuote({
    workspaceId: target.workspaceId,
    deploymentId: target.executionRun.deployment.id,
    executionRunId: target.executionRunId,
    strategyVersionId: target.strategyVersionId,
    positionId: target.id,
    expectedPositionVersion: expectedVersion,
    symbol: target.symbol,
    quotePrice: String(quote.price),
    quoteAt: quote.observedAt,
    processedPrice: { eventId: quote.id, streamId: quote.streamId, throughAt: quote.observedAt },
    traceInputs: runtimeTraceInputs({
      protectBeforeRecovery: true,
      firstEventId: quote.id,
      latestProtectiveEvent: quote,
      policy: policy ? policy.payload.settings.profitProtection : runtimeProfitProtectionPolicy,
      signals: [],
      recoveries: [],
    }),
    recoveryEvidence: recovery,
    factors: { source: "current-quote-protection", recovery, priority: "waiting-history" },
    action: {
      kind: "close",
      settlement: serializeSettlement(settlement),
      protection: {
        bestPrice: String(position.bestPrice),
        stopPrice: String(position.stopPrice),
        trailingPrice: position.trailingPrice === null ? null : String(position.trailingPrice),
      },
    },
  });
  if (result.applied) {
    latency.increment("protection.priorityExit");
    latency.observe("protection.eventToCheckpointMs", Date.now() - +quote.receivedAt);
  }
  return result.applied;
}

async function loadRecoveryCandles(
  symbol: string,
  interval: string,
  start: Date,
  end: Date,
  signal: AbortSignal,
) {
  const intervalMs = Number(interval) * 60_000;
  const lastOpen = new Date(Math.floor(end.getTime() / intervalMs) * intervalMs);
  const count = Math.floor((lastOpen.getTime() - start.getTime()) / intervalMs) + 1;
  const key = `${symbol}:${interval}:${start.toISOString()}:${end.toISOString()}`;
  return recoveryRequests.get(key, async () => {
    const stored = await marketDataRepository.listRecoveryCandles(symbol, interval, start, end);
    if (assessCandleContinuity(stored, intervalMs, lastOpen, count).complete) {
      return stored.map((candle) => ({
        ...candle,
        open: String(candle.open),
        high: String(candle.high),
        low: String(candle.low),
        close: String(candle.close),
        volume: String(candle.volume),
        turnover: String(candle.turnover),
      }));
    }
    const downloaded = await marketClient.getLinearKlinesRange(
      symbol,
      interval,
      start,
      end,
      signal,
    );
    await marketDataRepository.saveCandles(downloaded);
    return downloaded;
  });
}

async function pinnedIndicatorSeed(
  workspaceId: string,
  source: ValidationIndicatorSource,
  configHash: string,
  strategyConfig: ExecutionStrategyConfig,
  symbol: string,
) {
  const seeds = await indicatorSeedCache.get(
    `${workspaceId}:${source.datasetSnapshotId}:${source.contentHash}:${source.validationRunId}:${configHash}`,
    async () => {
      const snapshot = await validationRepository.getDatasetSnapshot(
        workspaceId,
        source.datasetSnapshotId,
      );
      if (!snapshot)
        throw new RuntimeWorkerError(
          "RUNTIME_INDICATOR_SEED_MISSING",
          "Validation seed snapshot is missing",
        );
      const availableAt = new Date();
      const dataset = { ...snapshot, candles: snapshot.candles.map(toExecutionCandle) };
      const result: Record<
        string,
        { checkpoint: ExecutionIndicatorCheckpoint; candle: EnrichedExecutionCandle }
      > = {};
      for (const seedSymbol of [...new Set(dataset.candles.map((candle) => candle.symbol))]) {
        result[seedSymbol] = await loadValidationIndicatorSeed({
          source,
          symbol: seedSymbol,
          config: strategyConfig,
          availableAt,
          loadSnapshot: async () => dataset,
        });
      }
      return result;
    },
  );
  const seed = seeds[symbol];
  if (!seed)
    throw new RuntimeWorkerError(
      "RUNTIME_INDICATOR_SYMBOL_NOT_VALIDATED",
      `${symbol} is missing from the validation seed`,
    );
  return seed;
}

async function restoreRuntimeIndicators(
  checkpoint: ExecutionIndicatorCheckpoint,
  history: ReturnType<typeof toExecutionCandle>[],
  workspaceId: string,
  configHash: string,
  strategyConfig: ExecutionStrategyConfig,
  symbol: string,
  interval: string,
) {
  const anchor = checkpoint.anchor;
  const revisionAt = await marketDataRepository.indicatorRevisionAt(
    symbol,
    interval,
    new Date(anchor?.seededThroughAt ?? checkpoint.tail[0]!.openTime),
    new Date(checkpoint.lastCandleAt),
  );
  const result = await restoreRevisedIndicators({
    checkpoint,
    history,
    revisionAt,
    availableAt: new Date(),
    config: strategyConfig,
    loadSeed: async () => {
      if (!anchor) throw new Error("Revised indicators require a validation anchor");
      return (await pinnedIndicatorSeed(workspaceId, anchor, configHash, strategyConfig, symbol))
        .checkpoint;
    },
    loadHistory: async (start, end) =>
      (await marketDataRepository.listRecoveryCandles(symbol, interval, start, end)).map(
        toExecutionCandle,
      ),
  });
  if (result.restored)
    logger.info(
      { symbol, interval, through: checkpoint.lastCandleAt, revisionAt },
      "Indicator history restored from pinned validation snapshot",
    );
  return result.checkpoint;
}

async function processRealtimePosition(
  target: Awaited<ReturnType<RuntimeRepository["listRealtimePositions"]>>[number],
  laneTiming: RuntimeLaneTiming,
) {
  const workStartedAt = new Date(),
    workStarted = performance.now();
  if (isLiquidityExitPolicy(target.exitPolicy) && target.exitState) {
    await runtimeRepository.advanceLiquidityPosition({
      workspaceId: target.workspaceId,
      executionRunId: target.executionRunId,
      positionId: target.id,
      expectedPositionVersion: target.runtimeVersion,
    });
    return;
  }
  const pinnedPolicy = readPinnedExecutionPolicy(target.executionPolicy);
  const protectionPolicy = pinnedPolicy
    ? pinnedPolicy.payload.settings.profitProtection
    : runtimeProfitProtectionPolicy;
  const strategyConfig = strategyConfigSchema.parse(target.strategyVersion.config);
  const signalIntervalMs = timeframeMinutes[strategyConfig.universe.timeframe] * 60_000;
  const events = await priceEventRepository.afterWithArchive(
    target.symbol,
    target.priceEventId,
    target.managedThroughAt ?? target.openedAt,
  );
  const latestProtection = await priceEventRepository.latest(target.symbol);
  const eventsLoadedAt = new Date(),
    eventReadMs = performance.now() - workStarted;
  let historyWaitMs = 0,
    priorCheckpointMs = 0;
  const quoteAgeLimit =
    pinnedPolicy?.payload.settings.accountSafety.maxQuoteAgeMs ?? config.RUNTIME_QUOTE_MAX_AGE_MS;
  const latestProtectiveEvent =
    latestProtection &&
    Date.now() - +latestProtection.receivedAt <= quoteAgeLimit &&
    Date.now() - +latestProtection.observedAt <= quoteAgeLimit &&
    +latestProtection.observedAt <= Date.now() + 1000
      ? { ...latestProtection, price: Number(latestProtection.price) }
      : undefined;
  let signalReplay: ReturnType<typeof replayPositionIndicators> | null = null;
  let traceSignals: RuntimeSignalEvent[] = [];
  const traceRecoveries: RuntimeTraceRecovery[] = [];
  const loadPositionSignals = async (lastOpen: Date, deadline: AbortSignal) => {
    let checkpoint = positionIndicatorCheckpoint(
      target.indicatorState,
      target.indicatorState == null
        ? await runtimeRepository.getIndicatorState(target.executionRunId, target.symbol)
        : null,
      target.signalCandleAt,
      strategyConfig,
      target.symbol,
    );
    const start = checkpoint
      ? new Date(checkpoint.tail[0]!.openTime)
      : new Date(
          Math.floor(+target.openedAt / signalIntervalMs) * signalIntervalMs -
            minimumExecutionCandleCount(strategyConfig) * signalIntervalMs,
        );
    if (+lastOpen < +start || (checkpoint && +lastOpen <= Date.parse(checkpoint.lastCandleAt)))
      return [];
    const count = Math.floor((+lastOpen - +start) / signalIntervalMs) + 1;
    if (count > 50_000)
      throw new RuntimeRecoveryIncompleteError("Signal replay exceeds 50000 candles");
    const interval = bybitIntervals[strategyConfig.universe.timeframe];
    await loadRecoveryCandles(target.symbol, interval, start, lastOpen, deadline);
    let history = await marketDataRepository.listRecoveryCandles(
      target.symbol,
      interval,
      start,
      lastOpen,
    );
    if (!assessCandleContinuity(history, signalIntervalMs, lastOpen, count).complete)
      throw new RuntimeRecoveryIncompleteError(
        "Signal history is incomplete after indicator checkpoint",
      );
    const unconfirmed = history.filter((candle) => !candle.finalizedAt);
    if (unconfirmed.length) {
      await marketDataRepository.saveCandles(
        unconfirmed.map((candle) => ({
          ...candle,
          open: String(candle.open),
          high: String(candle.high),
          low: String(candle.low),
          close: String(candle.close),
          volume: String(candle.volume),
          turnover: String(candle.turnover),
        })),
      );
      history = await marketDataRepository.listRecoveryCandles(
        target.symbol,
        interval,
        start,
        lastOpen,
      );
    }
    if (checkpoint)
      checkpoint = await restoreRuntimeIndicators(
        checkpoint,
        history.map(toExecutionCandle),
        target.workspaceId,
        target.strategyVersion.configHash,
        strategyConfig,
        target.symbol,
        interval,
      );
    const newHistory = checkpoint
      ? history.filter((candle) => +candle.openTime > Date.parse(checkpoint.lastCandleAt))
      : history;
    const availability = signalAvailabilityTimes(newHistory, signalIntervalMs, new Date());
    signalReplay = replayPositionIndicators(
      newHistory.map(toExecutionCandle),
      availability,
      signalIntervalMs,
      strategyConfig,
      checkpoint,
    );
    traceSignals = signalReplay.signals;
    for (const signal of traceSignals)
      latency.observe("signal.finalityDelayMs", +signal.availableAt - +signal.closedAt);
    return traceSignals;
  };
  let version = target.runtimeVersion;
  let confirmedPosition = deserializeExecutionPosition(target);
  let confirmedThrough = target.managedThroughAt ?? target.openedAt;
  function protectDuringWait<T>(work: (signal: AbortSignal) => Promise<T>) {
    const expectedVersion = version,
      working = { ...confirmedPosition },
      through = new Date(confirmedThrough);
    const started = performance.now();
    return protectionWatch
      .during(
        target.id,
        () => protectWaitingPosition(target, working, through, expectedVersion),
        work,
      )
      .finally(() => {
        const duration = performance.now() - started;
        historyWaitMs += duration;
        latency.observe("history.waitMs", duration);
      });
  }
  let traceEventCursor = target.priceEventId ?? 0n;
  await processRuntimePriceEvents({
    protectBeforeRecovery: true,
    cursorEventId: target.priceEventId,
    ...(latestProtectiveEvent ? { latestProtectiveEvent } : {}),
    position: deserializeExecutionPosition(target),
    profitProtection: {
      policy: protectionPolicy,
      state: readExecutionProfitProtectionState(target.profitProtection),
    },
    through: target.managedThroughAt ?? target.openedAt,
    streamId: target.priceStreamId,
    markPrice: Number(target.markPrice ?? target.entryPrice),
    events: events.map((event) => ({ ...event, price: Number(event.price) })),
    signalCandleAt: target.signalCandleAt,
    signalIntervalMs,
    ...(executionSignalExitEnabled(deserializeExecutionPosition(target), strategyConfig)
      ? {
          loadSignals: async () =>
            protectDuringWait(async (historySignal) => {
              const lastEventAt = Math.max(
                +(target.managedThroughAt ?? target.openedAt),
                ...events.map((event) => +event.observedAt),
              );
              const lastOpen = new Date(
                Math.floor(lastEventAt / signalIntervalMs) * signalIntervalMs - signalIntervalMs,
              );
              const baseline =
                target.signalCandleAt ??
                new Date(
                  Math.floor(+target.openedAt / signalIntervalMs) * signalIntervalMs -
                    signalIntervalMs,
                );
              if (+lastOpen - +baseline > config.RUNTIME_RECOVERY_MAX_HOURS * 3600_000)
                throw new RuntimeRecoveryIncompleteError(
                  "Signal backlog exceeds configured recovery window",
                );
              const deadline = AbortSignal.any([
                marketStreamAbortController.signal,
                AbortSignal.timeout(config.RUNTIME_RECOVERY_TIMEOUT_MS),
              ]);
              return loadPositionSignals(lastOpen, AbortSignal.any([deadline, historySignal]));
            }),
        }
      : {}),
    config: strategyConfig,
    recover: async (position, through, quote, protection) =>
      protectDuringWait(async (historySignal) => {
        if (+quote.observedAt - +through > config.RUNTIME_RECOVERY_MAX_HOURS * 3600_000) {
          throw new RuntimeRecoveryIncompleteError(
            "Recovery window exceeds configured limit; manual position review required",
          );
        }
        const deadline = AbortSignal.any([
          marketStreamAbortController.signal,
          historySignal,
          AbortSignal.timeout(config.RUNTIME_RECOVERY_TIMEOUT_MS),
        ]);
        const strictMinutes = readExecutionRecoveryModel(target.recoveryModel) !== null;
        let recent: RecoveryTradeSnapshot | undefined,
          anchorTradeId: string | undefined,
          anchorPrice: string | undefined,
          quoteTradeId: string | undefined,
          fallbackReason: string | undefined;
        if (protection.anchorEventId && quote.eventKey) {
          const [anchor] = await tradingPriceArchiveRepository.after(
            target.symbol,
            protection.anchorEventId - 1n,
            protection.anchorEventId,
            1,
          );
          const prefix = `bybit-trade:${target.symbol}:`;
          if (anchor?.eventKey.startsWith(prefix) && quote.eventKey.startsWith(prefix)) {
            anchorTradeId = anchor.eventKey.slice(prefix.length);
            anchorPrice = anchor.price;
            quoteTradeId = quote.eventKey.slice(prefix.length);
            try {
              const loaded = await recentRecoveryCache.get(`${target.symbol}:${quote.id}`, () =>
                marketClient.getLinearRecentTrades(
                  target.symbol,
                  AbortSignal.any([deadline, AbortSignal.timeout(1500)]),
                ),
              );
              recent = {
                sampledAt: loaded.sampledAt,
                trades: loaded.trades.filter(
                  (t) =>
                    Date.parse(t.observedAt) >= +through &&
                    Date.parse(t.observedAt) <= +quote.observedAt,
                ),
              };
            } catch {
              fallbackReason = "RECENT_TRADES_UNAVAILABLE";
            }
          }
        }
        const causal = {
          strictMinutes,
          ...(recent ? { recent } : {}),
          ...(anchorTradeId ? { anchorTradeId } : {}),
          ...(anchorPrice ? { anchorPrice } : {}),
          ...(quoteTradeId ? { quoteTradeId } : {}),
          ...(fallbackReason ? { fallbackReason } : {}),
        };
        const base = {
          position,
          since: through,
          quote,
          config: strategyConfig,
          protection,
          ...causal,
          minutes: [],
        };
        const covered = selectRecoveryTrades(base) !== null;
        if (!covered && !causal.fallbackReason)
          causal.fallbackReason = "RECENT_TRADES_BOUNDARIES_NOT_COVERED";
        const minuteRange = runtimeRecoveryMinuteRange(through, quote.observedAt);
        if (strictMinutes)
          minuteRange.end = new Date(Math.floor(+quote.observedAt / 60000) * 60000 - 1);
        const minutes =
          covered || +quote.observedAt === +through || +minuteRange.end < +minuteRange.start
            ? []
            : await loadRecoveryCandles(
                target.symbol,
                "1",
                minuteRange.start,
                minuteRange.end,
                deadline,
              );
        const recoveryMinutes = minutes.map(toExecutionCandle);
        traceRecoveries.push({
          eventId: quote.id,
          since: through,
          quote,
          minutes: recoveryMinutes,
          causal,
        });
        historySignal.throwIfAborted();
        const recovered = recoverCausalRuntimeGap({ ...base, minutes: recoveryMinutes });
        const segment = await priceEventRepository.streamSegment(quote.streamId);
        recovered.evidence = {
          ...recovered.evidence,
          ...(segment
            ? {
                streamCause: segment.cause,
                ...(segment.interruptedAt
                  ? { interruptedAt: segment.interruptedAt.toISOString() }
                  : {}),
              }
            : {}),
          ...(causal.fallbackReason ? { sourceFailure: causal.fallbackReason } : {}),
        };
        return recovered;
      }),
    checkpoint: async ({
      historyIncomplete,
      profitProtectionState,
      position,
      event,
      through,
      streamId,
      markPrice,
      settlement,
      recovered,
      recovery,
      signalCandleAt,
      signalExit,
    }) => {
      const decidedAt = new Date();
      const checkpointStarted = performance.now();
      const indicatorState = signalCandleAt
        ? signalReplay?.checkpointThrough(signalCandleAt)
        : null;
      const result = await runtimeRepository.persistRealtimeQuote({
        ...(historyIncomplete
          ? {}
          : {
              processedEventCount: events.filter(
                (price) => price.id > traceEventCursor && price.id <= event.id,
              ).length,
            }),
        traceInputs: runtimeTraceInputs({
          protectBeforeRecovery: true,
          ...(latestProtectiveEvent ? { latestProtectiveEvent } : {}),
          firstEventId: events[0]!.id,
          policy: protectionPolicy,
          signals: traceSignals,
          recoveries: traceRecoveries,
        }),
        workspaceId: target.workspaceId,
        deploymentId: target.executionRun.deployment.id,
        executionRunId: target.executionRunId,
        strategyVersionId: target.strategyVersionId,
        positionId: target.id,
        ...(profitProtectionState ? { profitProtection: profitProtectionState } : {}),
        expectedPositionVersion: version,
        symbol: target.symbol,
        quotePrice: String(markPrice),
        quoteAt: through,
        processedPrice: { eventId: event.id, streamId, throughAt: through },
        signalCandleAt,
        ...(indicatorState ? { indicatorState } : {}),
        decidedAt,
        ...(recovery ? { recoveryEvidence: recovery } : {}),
        factors: {
          source:
            recovery?.source === "recent-public-trades"
              ? "public-trade-recovery"
              : recovery?.source === "journal-protection"
                ? "current-quote-protection"
                : recovered
                  ? "ohlc-recovery"
                  : "durable-price-events",
          lastEventId: String(event.id),
          recovered,
          ...(profitProtectionState
            ? {
                profitProtection: {
                  ...profitProtectionState,
                  policy: protectionPolicy,
                },
              }
            : {}),
          ...(signalExit
            ? {
                signalExit: {
                  ...signalExit,
                  quoteObservedAt: event.observedAt.toISOString(),
                  decidedAt: decidedAt.toISOString(),
                  mode:
                    +decidedAt - +event.receivedAt > config.RUNTIME_QUOTE_MAX_AGE_MS
                      ? "journal-replay"
                      : "realtime",
                },
              }
            : {}),
          ...(settlement?.exitReason === "holding-timeout"
            ? {
                holdingExit: {
                  deadlineAt: executionHoldingDeadline(position)!.toISOString(),
                  quoteAt: event.observedAt.toISOString(),
                  delayMs: +event.observedAt - +executionHoldingDeadline(position)!,
                },
              }
            : {}),
          ...(recovery ? { recovery } : {}),
        },
        action: settlement
          ? {
              kind: "close",
              settlement: serializeSettlement(settlement),
              protection: {
                bestPrice: String(position.bestPrice),
                stopPrice: String(position.stopPrice),
                trailingPrice:
                  position.trailingPrice === null ? null : String(position.trailingPrice),
              },
            }
          : {
              kind: "update",
              markPrice: String(markPrice),
              unrealizedPnl: String(executionUnrealizedPnl(position, markPrice)),
              bestPrice: String(position.bestPrice),
              stopPrice: String(position.stopPrice),
              trailingPrice:
                position.trailingPrice === null ? null : String(position.trailingPrice),
            },
      });
      const committedAt = new Date(),
        checkpointMs = performance.now() - checkpointStarted;
      if (result.applied) {
        const mode =
          +committedAt - +event.receivedAt > config.RUNTIME_QUOTE_MAX_AGE_MS
            ? "replay"
            : recovered
              ? "recovery"
              : "realtime";
        latency.observe(`position.${mode}.eventToCheckpointMs`, +committedAt - +event.receivedAt, {
          positionId: target.id,
          executionRunId: target.executionRunId,
          symbol: target.symbol,
          eventId: String(event.id),
          streamId: event.streamId,
          receivedAt: event.receivedAt.toISOString(),
          workStartedAt: workStartedAt.toISOString(),
          eventsLoadedAt: eventsLoadedAt.toISOString(),
          decidedAt: decidedAt.toISOString(),
          committedAt: committedAt.toISOString(),
          stages: {
            laneLoadMs: laneTiming.loadMs,
            laneQueueMs: laneTiming.queueMs,
            eventReadMs,
            historyWaitMs,
            priorCheckpointMs,
            processingMs: Math.max(
              0,
              checkpointStarted - workStarted - eventReadMs - historyWaitMs - priorCheckpointMs,
            ),
            checkpointMs,
            receiveToReadEndMs: +eventsLoadedAt - +event.receivedAt,
          },
        });
        latency.observe(
          `position.${strategyConfig.signal.family}.workToCheckpointMs`,
          Date.now() - +decidedAt,
        );
        version += 1;
        confirmedPosition = { ...position };
        confirmedThrough = new Date(through);
        traceEventCursor = event.id;
      }
      priorCheckpointMs += checkpointMs;
      if (result.closed)
        logger.info(
          { positionId: target.id, symbol: target.symbol, reason: settlement?.exitReason },
          "Position closed from price journal",
        );
      return result.applied;
    },
  });
}

function toExecutionCandle(candle: {
  symbol: string;
  openTime: Date;
  open: string | { toString(): string };
  high: string | { toString(): string };
  low: string | { toString(): string };
  close: string | { toString(): string };
  turnover: string | { toString(): string };
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
        if (!runtimeDeferred(error))
          logger.error({ err: error, workspaceId }, "Independent risk guard failed");
      }
    }
    await delay(config.RUNTIME_QUOTE_INTERVAL_MS);
  }
}

async function enforceRuntimeRisk(workspaceId: string) {
  const positions = await protectionRuntimeRepository.listRealtimePositions(workspaceId);
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
    await protectionRuntimeRepository.persistRealtimeQuote({
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
  if (!target.lastEvaluatedAt) return;
  const pending = parseRealtimePendingSignal(target.pendingSignal);
  const progress = {
    workspaceId: target.executionRun.deployment.workspaceId,
    executionRunId: target.executionRun.id,
    symbol: target.symbol,
    expectedCandleAt: target.lastEvaluatedAt,
    expectedPendingPriceEventId: target.pendingPriceEventId,
  };
  if (!pending) {
    const stored = target.pendingSignal;
    if (
      stored &&
      typeof stored === "object" &&
      !Array.isArray(stored) &&
      stored.mode === "realtime"
    ) {
      await entryRuntimeRepository.advancePendingEntry({
        ...progress,
        throughEventId: target.pendingPriceEventId,
        rejectionReason: "INVALID_PENDING_SIGNAL",
      });
    }
    return;
  }
  const strategyConfig = strategyConfigSchema.parse(target.executionRun.strategyVersion.config);
  const pendingPolicy = readPinnedExecutionPolicy(target.executionRun.executionPolicy);
  const entryMarketPolicy = pendingPolicy?.payload.settings.marketEntry ?? runtimeMarketEntryPolicy;
  const maximumQuoteAgeMs =
    pendingPolicy?.payload.settings.accountSafety.maxQuoteAgeMs ?? config.RUNTIME_QUOTE_MAX_AGE_MS;
  pending.expiresAt = runtimeEntryExpiresAt(
    strategyConfig.entry.orderType === "market" ? "MARKET" : "LIMIT",
    pending.detectedAt,
    pending.expiresAt,
    entryMarketPolicy,
  );
  if (Date.now() >= +pending.expiresAt) {
    const expired = await entryRuntimeRepository.advancePendingEntry({
      ...progress,
      throughEventId: target.pendingPriceEventId,
    });
    if (expired) latency.increment("entry.expiredBeforeProcessing");
    return;
  }
  const deployment = target.executionRun.deployment;
  const rules = captureInstrumentRules(target.instrument);
  if (rules.reason) {
    await entryRuntimeRepository.advancePendingEntry({
      ...progress,
      throughEventId: target.pendingPriceEventId,
      waitingReason: rules.reason as RuntimeEntryWaitReason,
    });
    return;
  }
  const waitingReason =
    deployment.exchangeConnection?.status !== "ACTIVE" ||
    deployment.exchangeConnection.revokedAt !== null
      ? "ENTRY_CONNECTION_UNAVAILABLE"
      : !target.instrument.enabled || target.instrument.status !== "Trading"
        ? "INSTRUMENT_UNAVAILABLE"
        : entryQuoteWaitReason(target.symbol, maximumQuoteAgeMs);
  if (waitingReason) {
    await entryRuntimeRepository.advancePendingEntry({
      ...progress,
      throughEventId: target.pendingPriceEventId,
      waitingReason,
    });
    return;
  }
  const events = await priceEventRepository.after(
    target.symbol,
    target.pendingPriceEventId,
    pending.detectedAt,
  );
  const rawPending = target.pendingSignal as Record<string, unknown>;
  const storedOrder =
    typeof rawPending.executionOrderId === "string"
      ? await entryRuntimeRepository.pendingExecutionOrder({
          workspaceId: progress.workspaceId,
          executionRunId: progress.executionRunId,
          symbol: target.symbol,
          orderId: rawPending.executionOrderId,
        })
      : null;
  if (rawPending.executionOrderId && (!storedOrder || storedOrder.status !== "OPEN")) {
    await entryRuntimeRepository.advancePendingEntry({
      ...progress,
      throughEventId: target.pendingPriceEventId,
      rejectionReason: "ENTRY_ORDER_UNAVAILABLE",
    });
    return;
  }
  const order: ExecutionEntryOrder | null = storedOrder?.snapshot ?? null;
  let entryRisk: Awaited<ReturnType<RuntimeRiskRepository["assess"]>> | null = null;
  const outcome = await replayPendingEntryEvents({
    events: events.map((event) => ({ ...event, price: Number(event.price) })),
    cursor: target.pendingPriceEventId,
    streamId: streamSession,
    detectedAt: pending.detectedAt,
    availableAt: pending.availableAt,
    expiresAt: pending.expiresAt,
    maximumQuoteAgeMs,
    now: Date.now,
    tryFill: async (quote) => {
      if (strategyConfig.entry.orderType === "market") {
        const failure = runtimeMarketEntryFailure(
          {
            detectedAt: pending.detectedAt,
            expiresAt: pending.expiresAt,
            signalPrice: pending.signalPrice,
            quotePrice: quote.price,
            quoteAt: quote.observedAt,
            now: new Date(),
          },
          entryMarketPolicy,
        );
        if (failure) return { status: "rejected", reason: failure };
      }
      const admissionStarted = performance.now();
      const risk = (entryRisk ??= await entryRiskRepository.assess(
        target.executionRun.deployment.workspaceId,
        target.executionRun.deployment.exchangeAccountId,
        target.executionRun.strategyVersion.config,
      ));
      latency.observe("entry.riskAdmissionMs", performance.now() - admissionStarted);
      if (risk.reason) return { status: "rejected", reason: risk.reason };
      const liquidityPolicy =
        order?.policy ??
        pendingPolicy?.payload.settings.entryLiquidity ??
        runtimeEntryLiquidityPolicy;
      if (Date.now() - +quote.receivedAt > liquidityPolicy.maximumBookAgeMs)
        return { status: "no-touch", reason: "ENTRY_BOOK_STALE" };
      const bookFailure = entryLiquidityBookFailure(quote, liquidityPolicy);
      if (!order && bookFailure)
        return { status: "no-touch", reason: bookFailure as RuntimeEntryWaitReason };
      const execution = order ? evaluateExecutionEntryOrder(order, quote) : null;
      if (execution?.kind === "cancel") return { status: "rejected", reason: execution.reason };
      if (execution?.kind === "wait")
        return { status: "no-touch", reason: execution.reason as RuntimeEntryWaitReason };
      const book = quote.executionData
        ? (quote.executionData as ExecutionEntryOrder["placementData"])[5]
        : null;
      const fillPrice =
        execution?.kind === "fill"
          ? Number(execution.price)
          : strategyConfig.entry.orderType === "limit"
            ? executionLimitPrice(pending, strategyConfig, rules.rules!)
            : Number(pending.side === "long" ? book![2] : book![0]);
      const candidate = openExecutionPositionAtFill({
        signal: pending,
        quote,
        entryRegime: pending.entryRegime,
        equity: risk.equity,
        maximumNotional: Math.max(0, risk.equity) / strategyConfig.risk.maxOpenPositions,
        config: strategyConfig,
        instrumentRules: order?.instrumentRules ?? rules.rules!,
        fillPrice,
        ...(order?.exitPolicy ? { exitPolicy: order.exitPolicy } : {}),
        ...(execution?.kind === "fill"
          ? {
              maximumQuantity: Number(execution.quantity),
              entryExecution: {
                version: entryLiquidityVersion,
                orderId: storedOrder!.id,
                requestedQuantity: order!.quantity,
              },
            }
          : {}),
      });
      if (!candidate) return { status: "rejected", reason: "ENTRY_SIZE_BELOW_INSTRUMENT_LIMITS" };
      const position = limitExecutionPositionRisk(
        candidate,
        risk.equity,
        Math.max(0, risk.maximumExposure - risk.exposure),
        strategyConfig,
        risk.remainingStopRisk,
      );
      if (!position) return { status: "rejected", reason: "INVALID_ENTRY_SIZE" };
      if (!order) {
        const submitted = await entryRuntimeRepository.submitRealtimeEntryOrder({
          ...progress,
          entryPriceEventId: quote.id,
          position: serializePosition(position),
          policy: liquidityPolicy,
        });
        if (submitted.applied) return { status: "conflict" };
        if (
          submitted.riskFailure?.startsWith("ENTRY_BOOK") ||
          submitted.riskFailure === "ENTRY_SPREAD_LIMIT" ||
          submitted.riskFailure === "FUNDING_DATA_UNAVAILABLE"
        )
          return { status: "no-touch", reason: submitted.riskFailure as RuntimeEntryWaitReason };
        return submitted.riskFailure
          ? { status: "rejected", reason: submitted.riskFailure }
          : { status: "conflict" };
      }
      if (!streamConnected || !priceJournal.healthy || quote.streamId !== streamSession) {
        await entryRuntimeRepository.advancePendingEntry({
          ...progress,
          throughEventId: target.pendingPriceEventId,
          waitingReason: !streamConnected
            ? "ENTRY_STREAM_UNAVAILABLE"
            : !priceJournal.healthy
              ? "ENTRY_JOURNAL_UNAVAILABLE"
              : "ENTRY_QUOTE_STREAM_MISMATCH",
        });
        return { status: "conflict" };
      }
      const result = await entryRuntimeRepository.persistRealtimeEntry({
        ...progress,
        entryOrderId: storedOrder!.id,
        entryPriceEventId: quote.id,
        signalAvailableAt: pending.availableAt,
        deploymentId: target.executionRun.deployment.id,
        strategyVersionId: target.executionRun.strategyVersionId,
        quoteAt: quote.observedAt,
        quotePrice: String(quote.price),
        unrealizedPnl: String(executionUnrealizedPnl(position, quote.price)),
        maxOpenPositions: strategyConfig.risk.maxOpenPositions,
        entryOrderType: strategyConfig.entry.orderType === "market" ? "MARKET" : "LIMIT",
        position: {
          ...serializePosition(position),
          ...(order.fundingPolicy ? { fundingPolicy: order.fundingPolicy } : {}),
        },
        factors: {
          ...realtimeQuoteFactors(quote),
          source: "durable-price-events",
          eventId: String(quote.id),
        },
      });
      if (result.applied) {
        latency.increment("entry.filled");
        latency.observe("entry.quoteToFillMs", Date.now() - +quote.receivedAt);
        latency.observe(
          `entry.${strategyConfig.signal.family}.${strategyConfig.entry.orderType}.finalityToFillMs`,
          Date.now() - +pending.availableAt,
        );
        logger.info(
          { executionRunId: target.executionRun.id, symbol: target.symbol },
          "Pending signal filled from durable price event",
        );
        return { status: "filled" };
      }
      if (result.waitingReason) {
        await entryRuntimeRepository.advancePendingEntry({
          ...progress,
          throughEventId: target.pendingPriceEventId,
          waitingReason: result.waitingReason,
        });
        return { status: "conflict" };
      }
      if (
        result.riskFailure === "STALE_ENTRY_QUOTE" ||
        result.riskFailure === "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY"
      )
        return { status: "no-touch", reason: result.riskFailure };
      if (result.riskFailure || result.capacityReached)
        return { status: "rejected", reason: result.riskFailure ?? "MAX_OPEN_POSITIONS" };
      return { status: "conflict" };
    },
  });
  if (outcome.status === "filled" || outcome.status === "conflict") return;
  if (outcome.status === "expired") latency.increment("entry.expiredDuringProcessing");
  if (outcome.status === "rejected") latency.increment(`entry.rejected.${outcome.reason}`);
  if ("waitingReason" in outcome && outcome.waitingReason)
    latency.increment(`entry.wait.${outcome.waitingReason}`);
  if (outcome.throughEventId !== target.pendingPriceEventId || outcome.status !== "pending") {
    await entryRuntimeRepository.advancePendingEntry({
      ...progress,
      throughEventId: outcome.throughEventId,
      ...(outcome.status === "rejected" ? { rejectionReason: outcome.reason } : {}),
      ...("waitingReason" in outcome && outcome.waitingReason
        ? { waitingReason: outcome.waitingReason }
        : {}),
    });
  }
}

function entryQuoteWaitReason(symbol: string, maximumQuoteAgeMs = config.RUNTIME_QUOTE_MAX_AGE_MS) {
  return runtimeEntryQuoteWaitReason({
    streamConnected,
    journalHealthy: priceJournal.healthy,
    quote: latestQuotes.get(symbol),
    streamId: streamSession,
    now: Date.now(),
    maximumQuoteAgeMs,
  });
}

function getFreshQuote(symbol: string) {
  return entryQuoteWaitReason(symbol) ? null : latestQuotes.get(symbol)!;
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
  const expectedDeploymentStatus = target.status;
  const executionRun = target.executionRuns[0];
  if (!executionRun) return;
  const activeRunPolicy = await executionPolicyRepository.pinRun(
    executionRun.id,
    executionPolicySettings,
  );
  const runMarketEntryPolicy = activeRunPolicy.payload.settings.marketEntry;
  const strategyConfig = strategyConfigSchema.parse(target.strategyVersion.config);
  const interval = bybitIntervals[strategyConfig.universe.timeframe];
  const intervalMs = timeframeMinutes[strategyConfig.universe.timeframe] * 60_000;
  const lastCompleteCandleAt = new Date(
    Math.floor(Date.now() / intervalMs) * intervalMs - intervalMs,
  );
  const minimumCandles = minimumExecutionCandleCount(strategyConfig);

  await processRuntimeSymbols([...strategyConfig.universe.symbols].sort(), {
    process: async (symbol) => {
      let candleLimit = minimumCandles;
      let state = await runtimeRepository.getCycleState({
        workspaceId: target.workspaceId,
        exchangeAccountId: target.exchangeAccountId,
        executionRunId: executionRun.id,
        symbol,
        interval,
        lastCompleteCandleAt,
        candleLimit,
      });
      if (state.position) return;
      if (!state.instrument?.enabled || state.instrument.status !== "Trading") {
        if (target.status === "PAUSED") return;
        throw new RuntimeWorkerError(
          "RUNTIME_INSTRUMENT_UNAVAILABLE",
          `${symbol} недоступен для новых сигналов: статус ${state.instrument?.status ?? "Unknown"}`,
        );
      }

      if (state.cursor?.lastEvaluatedAt && state.cursor.lastEvaluatedAt >= lastCompleteCandleAt)
        return;
      let initialCheckpoint = readExecutionIndicatorCheckpoint(
        state.cursor?.indicatorState,
        strategyConfig,
        symbol,
      );
      let seedCandle: EnrichedExecutionCandle | null = null;
      if (!initialCheckpoint) {
        const source = validationIndicatorSource(executionRun.context);
        if (source) {
          const seed = await pinnedIndicatorSeed(
            target.workspaceId,
            source,
            target.strategyVersion.configHash,
            strategyConfig,
            symbol,
          );
          initialCheckpoint = seed.checkpoint;
          seedCandle = seed.candle;
          if (Date.parse(initialCheckpoint.lastCandleAt) > +lastCompleteCandleAt)
            throw new RuntimeWorkerError(
              "RUNTIME_INDICATOR_SEED_AHEAD",
              "Validation seed is ahead of runtime evaluation boundary",
            );
        }
      }
      if (initialCheckpoint) {
        const replayCount = Math.floor(
          (+lastCompleteCandleAt - Date.parse(initialCheckpoint.lastCandleAt)) / intervalMs,
        );
        if (replayCount > 50_000)
          throw new RuntimeWorkerError(
            "RUNTIME_INDICATOR_BACKLOG",
            "Indicator replay exceeds 50000 candles",
          );
        candleLimit = Math.max(minimumCandles, replayCount + initialCheckpoint.tail.length);
        if (candleLimit > minimumCandles) {
          state = await runtimeRepository.getCycleState({
            workspaceId: target.workspaceId,
            exchangeAccountId: target.exchangeAccountId,
            executionRunId: executionRun.id,
            symbol,
            interval,
            lastCompleteCandleAt,
            candleLimit,
          });
        }
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
      if (state.position) return;
      const latest = state.candles.at(-1);
      if (!latest || state.candles.length < candleLimit) {
        throw new RuntimeWorkerError(
          "RUNTIME_CANDLES_INSUFFICIENT",
          `Для ${symbol} недостаточно завершённых свечей: ${state.candles.length}/${candleLimit}`,
        );
      }
      if (state.cursor?.lastEvaluatedAt && state.cursor.lastEvaluatedAt >= latest.openTime) return;

      const executionCandles = state.candles.map((candle) => ({
        symbol: candle.symbol,
        openTime: candle.openTime,
        open: candle.open.toNumber(),
        high: candle.high.toNumber(),
        low: candle.low.toNumber(),
        close: candle.close.toNumber(),
        turnover: candle.turnover.toNumber(),
      }));
      const persistedCheckpoint = readExecutionIndicatorCheckpoint(
        state.cursor?.indicatorState,
        strategyConfig,
        symbol,
      );
      let checkpoint = persistedCheckpoint ?? initialCheckpoint;
      if (
        persistedCheckpoint &&
        persistedCheckpoint.lastCandleAt !== state.cursor?.lastEvaluatedAt?.toISOString()
      ) {
        throw new RuntimeWorkerError(
          "RUNTIME_INDICATOR_CURSOR_MISMATCH",
          "Indicator checkpoint does not match decision cursor",
        );
      }
      if (checkpoint)
        checkpoint = await restoreRuntimeIndicators(
          checkpoint,
          executionCandles,
          target.workspaceId,
          target.strategyVersion.configHash,
          strategyConfig,
          symbol,
          interval,
        );
      const newCandles = checkpoint
        ? executionCandles.filter(
            (candle) => +candle.openTime > Date.parse(checkpoint.lastCandleAt),
          )
        : executionCandles;
      if (
        checkpoint &&
        newCandles[0] &&
        +newCandles[0].openTime !== Date.parse(checkpoint.lastCandleAt) + intervalMs
      ) {
        throw new RuntimeWorkerError(
          "RUNTIME_INDICATOR_REPLAY_GAP",
          "Missing candles after indicator checkpoint",
        );
      }
      const indicators = advanceExecutionIndicators(newCandles, strategyConfig, checkpoint);
      const candles = indicators.candles;
      const candle = candles.at(-1) ?? seedCandle;
      if (!candle || +candle.openTime !== +latest.openTime)
        throw new RuntimeWorkerError(
          "RUNTIME_INDICATOR_REPLAY_GAP",
          "Indicator replay did not reach the latest candle",
        );
      const candleClosedAt = new Date(candle.openTime.getTime() + intervalMs);
      const signalAvailableAt = new Date(
        Math.max(
          +signalAvailabilityTimes(state.candles, intervalMs, new Date()).at(-1)!,
          checkpoint?.availableAt ? Date.parse(checkpoint.availableAt) : 0,
        ),
      );
      indicators.checkpoint!.availableAt = signalAvailableAt.toISOString();
      const pendingSignal = parsePendingSignal(state.cursor?.pendingSignal ?? null);
      const realtimePendingSignal = parseRealtimePendingSignal(state.cursor?.pendingSignal ?? null);
      const riskAssessment = await runtimeRiskRepository.assess(
        target.workspaceId,
        target.exchangeAccountId,
        target.strategyVersion.config,
      );
      const equity = riskAssessment.equity;
      const dailyPnl = riskAssessment.strategyDay.realizedPnl;
      const entriesAllowed =
        target.status === "RUNNING" &&
        target.exchangeConnection?.status === "ACTIVE" &&
        target.exchangeConnection.revokedAt === null &&
        !riskAssessment.reason;

      const positionAction: Parameters<RuntimeRepository["persistCycle"]>[0]["positionAction"] = {
        kind: "none",
      };
      let decision: Parameters<RuntimeRepository["persistCycle"]>[0]["decision"] = {
        action: target.status === "PAUSED" ? "SKIP" : "HOLD",
        reasonCode: target.status === "PAUSED" ? "DEPLOYMENT_PAUSED" : "NO_SIGNAL",
        summary:
          target.status === "PAUSED"
            ? "Новые входы отключены: deployment на паузе"
            : "Условий для действия нет",
        factors: runtimeFactors(
          candle,
          dailyPnl,
          equity,
          signalAvailableAt,
          indicators.checkpoint!,
        ),
      };
      let pendingSignalAfter: RuntimePendingSignal | null = null;
      let signalCandidate: PendingExecutionSignal | null = null;

      if (pendingSignal && !realtimePendingSignal) {
        decision = {
          action: "SKIP",
          reasonCode: "LEGACY_SIGNAL_DISCARDED",
          summary: "Устаревший сигнал сброшен; ожидается новый сигнал со свежей котировкой",
          factors: runtimeFactors(
            candle,
            dailyPnl,
            equity,
            signalAvailableAt,
            indicators.checkpoint!,
          ),
        };
      }

      if (target.status === "RUNNING") {
        const signal = getExecutionSignal(candle, strategyConfig);
        signalCandidate = signal;
        if (signal && !entriesAllowed && positionAction.kind === "none") {
          decision = {
            action: "SKIP",
            reasonCode:
              target.exchangeConnection?.status !== "ACTIVE" ||
              target.exchangeConnection.revokedAt !== null
                ? "ENTRY_CONNECTION_UNAVAILABLE"
                : (riskAssessment.reason ?? "ENTRY_GATE_CLOSED"),
            summary:
              riskAssessment.reason === "STRATEGY_DAILY_LOSS_LIMIT"
                ? "Торговый сигнал отклонён: достигнут лимит закрытого убытка за сутки в часовом поясе стратегии"
                : riskAssessment.reason === "MAX_ACCOUNT_STOP_RISK"
                  ? "Торговый сигнал отклонён: общий бюджет риска до стопов занят открытыми позициями"
                  : "Торговый сигнал отклонён до исполнения общим risk gate",
            factors: runtimeFactors(
              candle,
              dailyPnl,
              equity,
              signalAvailableAt,
              indicators.checkpoint!,
            ),
          };
        } else if (signal && positionAction.kind === "none") {
          const expiresAt = runtimeEntryExpiresAt(
            strategyConfig.entry.orderType === "market" ? "MARKET" : "LIMIT",
            candleClosedAt,
            new Date(+candleClosedAt + intervalMs),
            runMarketEntryPolicy,
          );
          const failure =
            strategyConfig.entry.orderType === "market"
              ? runtimeMarketEntryFailure(
                  {
                    detectedAt: candleClosedAt,
                    expiresAt,
                    signalPrice: signal.signalPrice,
                    now: new Date(),
                  },
                  runMarketEntryPolicy,
                )
              : null;
          pendingSignalAfter = failure
            ? null
            : createRealtimePendingSignal(
                signal,
                candleClosedAt,
                expiresAt,
                getExecutionMarketRegime(candle),
                signalAvailableAt,
              );
          decision = {
            action: failure ? "SKIP" : "HOLD",
            reasonCode: failure ?? "ENTRY_SIGNAL_PENDING",
            summary: failure
              ? `Сигнал отклонён: ${failure}`
              : "Сигнал сохранён; ожидается подготовка заявки по свежему стакану",
            factors: runtimeFactors(
              candle,
              dailyPnl,
              equity,
              signalAvailableAt,
              indicators.checkpoint!,
            ),
          };
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
        position: null,
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
        indicatorState: indicators.checkpoint!,
        expectedLastEvaluatedAt: state.cursor?.lastEvaluatedAt ?? null,
        expectedDeploymentStatus,
        expectedPositionId: null,
        expectedPositionVersion: null,
        signalAvailableAt,
        ...(signalCandidate ? { entrySignalPrice: signalCandidate.signalPrice } : {}),
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
        if (signalCandidate) {
          latency.observe(
            `signal.${strategyConfig.signal.family}.finalityDelayMs`,
            +signalAvailableAt - +candleClosedAt,
          );
          latency.observe(
            `signal.${strategyConfig.signal.family}.finalityToDecisionMs`,
            Date.now() - +signalAvailableAt,
          );
          if (decision.reasonCode.includes("EXPIRED"))
            latency.increment("entry.expiredAtSignalDetection");
        }
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
    },
    isConflict: (error) => error instanceof RuntimeStateConflictError,
    onConflict: (symbol, attempt, exhausted) => {
      logger.debug(
        { deploymentId: target.id, executionRunId: executionRun.id, symbol, attempt, exhausted },
        "Runtime candle state conflict",
      );
    },
    onFailure: async (symbol, error) => {
      if (runtimeDeferred(error)) return;
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
    },
  });
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
    const instrumentScenario = await validationRepository.pinInstrumentRules({
      workspaceId: job.workspaceId,
      runId: job.runId,
      jobId: job.jobId,
      workerId,
      symbols: dataset.symbols,
    });
    let fundingScenario = await validationRepository.getFundingSnapshot(job.workspaceId, job.runId);
    if (!fundingScenario) {
      const startsAt = dataset.candles.reduce((min, c) => Math.min(min, +c.openTime), Infinity);
      const throughAt =
        +dataset.endsAt + timeframeMinutes[strategyConfig.universe.timeframe] * 60000;
      const events: ExecutionFundingDataset["events"] = [];
      for (const symbol of dataset.symbols) {
        try {
          events.push(
            ...(await marketClient.getLinearFundingHistory(
              symbol,
              new Date(startsAt),
              new Date(throughAt),
              AbortSignal.timeout(120000),
            )),
          );
        } catch (error) {
          throw new ValidationWorkerError(
            "FUNDING_HISTORY_UNAVAILABLE",
            `${symbol}: ${errorMessage(error)}`,
          );
        }
        if (!(await validationRepository.updateProgress(job.jobId, workerId, 85)))
          throw new Error("Validation funding lease lost");
      }
      fundingScenario = await validationRepository.pinFundingSnapshot({
        workspaceId: job.workspaceId,
        runId: job.runId,
        jobId: job.jobId,
        workerId,
        data: {
          version: 1,
          policy: enabledFundingPolicy,
          symbols: dataset.symbols,
          startsAt: new Date(startsAt).toISOString(),
          throughAt: new Date(throughAt).toISOString(),
          coverage: "complete",
          events,
        },
      });
    }
    const policyScenario = await executionPolicyRepository.pinValidation({
      runId: job.runId,
      jobId: job.jobId,
      workspaceId: job.workspaceId,
      workerId,
      settings: executionPolicySettings,
      initialCapital: Number(executionInput.initialCapital),
    });
    const result = runValidationEngine({
      executionPolicy: policyScenario.payload,
      funding: fundingScenario.payload,
      instrumentRules: instrumentScenario.instruments,
      config: strategyConfig,
      candles: dataset.candles,
      evaluationPeriod: {
        startsAt: new Date(`${executionInput.dataset.startDate}T00:00:00.000Z`),
        endsAt: new Date(
          Math.min(
            +new Date(`${executionInput.dataset.endDate}T23:59:59.999Z`),
            +dataset.endsAt + timeframeMinutes[strategyConfig.universe.timeframe] * 60_000 - 1,
          ),
        ),
      },
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
        fundingPolicy: { ...enabledFundingPolicy, snapshotHash: fundingScenario.hash },
        executionPolicy: {
          hash: policyScenario.hash,
          profileHash: policyScenario.profileHash,
          ...policyScenario.payload,
        },
        instrumentRules: {
          mode: "fixed-snapshot-scenario",
          observedAt: instrumentScenario.capturedAt,
          symbols: dataset.symbols,
        },
        symbols: dataset.symbols,
        timeframe: executionInput.dataset.timeframe,
        startDate: executionInput.dataset.startDate,
        endDate: executionInput.dataset.endDate,
        candleCount: dataset.candles.length,
      },
    });
    await validationRepository.complete({
      engineVersion: validationEngineVersion,
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
        funding: String(trade.funding ?? 0),
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
  const historyStart = new Date(
    +startTime - minimumExecutionCandleCount(strategyConfig) * intervalMs,
  );
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
    Math.ceil((endTime.getTime() - historyStart.getTime()) / intervalMs) * symbols.length;
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
      marketCandles = await marketClient.getLinearKlinesRange(
        symbol,
        interval,
        historyStart,
        endTime,
      );
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
  await Promise.allSettled([...writerClaims]);
  await priceWriterRepository
    .releaseWriter(workerId)
    .catch((error) =>
      logger.warn({ err: error }, "Writer lease release failed; expiry remains in effect"),
    );
  await prisma.workerHeartbeat.deleteMany({ where: { workerId: { in: [workerId, watchdogId] } } });
  await Promise.all(
    [prisma, tradingPrisma, entryPrisma, protectionPrisma, journalPrisma].map((client) =>
      client.$disconnect(),
    ),
  );
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
  positionExitPolicy?: unknown;
  fundingPolicy?: unknown;
  fundingRemaining?: { toNumber(): number } | null;
  remainingQuantity?: { toNumber(): number } | null;
  remainingEntryFee?: { toNumber(): number } | null;
  exitPolicy?: unknown;
  entryExecution?: unknown;
  instrumentRules?: unknown;
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
    ...(position.positionExitPolicy
      ? { positionExitPolicy: readExecutionPositionExitPolicy(position.positionExitPolicy)! }
      : {}),
    ...(position.exitPolicy ? { exitPolicy: readExecutionExitPolicy(position.exitPolicy)! } : {}),
    ...(position.entryExecution
      ? { entryExecution: readEntryExecutionMarker(position.entryExecution)! }
      : {}),
    ...(position.instrumentRules
      ? { instrumentRules: readExecutionInstrumentRules(position.instrumentRules)! }
      : {}),
    symbol: position.symbol ?? "",
    side: position.side === "BUY" ? "long" : "short",
    entryRegime: deserializeMarketRegime(position.entryRegime),
    entrySession: deserializeTradingSession(position.entrySession),
    openedAt: position.openedAt,
    entryPrice: position.entryPrice.toNumber(),
    quantity: (position.remainingQuantity ?? position.quantity).toNumber(),
    stopPrice: position.stopPrice.toNumber(),
    takePrice: position.takePrice.toNumber(),
    trailingPrice: position.trailingPrice?.toNumber() ?? null,
    bestPrice: position.bestPrice.toNumber(),
    ...(position.fundingPolicy ? { fundingPaid: position.fundingRemaining?.toNumber() ?? 0 } : {}),
    entryFee: (position.remainingEntryFee ?? position.entryFee).toNumber(),
    entrySlippage: position.entrySlippage.toNumber(),
  };
}

function serializePosition(position: ExecutionPosition) {
  return {
    ...(position.positionExitPolicy ? { positionExitPolicy: position.positionExitPolicy } : {}),
    ...(position.exitPolicy ? { exitPolicy: position.exitPolicy } : {}),
    ...(position.entryExecution ? { entryExecution: position.entryExecution } : {}),
    ...(position.instrumentRules ? { instrumentRules: position.instrumentRules } : {}),
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
  if (
    "breakoutLevel" in value &&
    (typeof value.breakoutLevel !== "number" ||
      !Number.isFinite(value.breakoutLevel) ||
      value.breakoutLevel <= 0)
  )
    return null;
  return {
    side,
    signalPrice,
    ...("breakoutLevel" in value ? { breakoutLevel: value.breakoutLevel as number } : {}),
  };
}

type RuntimePendingSignal = PendingExecutionSignal & {
  availableAt: string;
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
  availableAt: Date,
): RuntimePendingSignal {
  return {
    ...signal,
    mode: "realtime",
    detectedAt: detectedAt.toISOString(),
    availableAt: availableAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    entryRegime,
  };
}

function parseRealtimePendingSignal(value: unknown):
  | (PendingExecutionSignal & {
      detectedAt: Date;
      availableAt: Date;
      expiresAt: Date;
      entryRegime: ExecutionMarketRegime;
    })
  | null {
  const signal = parsePendingSignal(value);
  if (!signal || !value || Array.isArray(value) || typeof value !== "object") return null;
  if (
    !("mode" in value) ||
    value.mode !== "realtime" ||
    !("availableAt" in value) ||
    typeof value.availableAt !== "string" ||
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
  const availableAt = new Date(value.availableAt);
  const expiresAt = new Date(value.expiresAt);
  if (
    !Number.isFinite(detectedAt.getTime()) ||
    !Number.isFinite(availableAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= detectedAt
  ) {
    return null;
  }
  return { ...signal, detectedAt, availableAt, expiresAt, entryRegime: value.entryRegime };
}

function realtimeQuoteFactors(quote: JournalQuote) {
  return {
    source: "bybit-public-websocket",
    eventId: String(quote.id),
    streamId: quote.streamId,
    receivedAt: quote.receivedAt.toISOString(),
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
    volume24h: number | null;
    breakoutHigh: number | null;
    breakoutLow: number | null;
    meanReversionZScore: number | null;
    momentumPercent: number | null;
  },
  dailyPnl: number,
  equity: number,
  signalAvailableAt: Date,
  indicatorState: ExecutionIndicatorCheckpoint,
) {
  return {
    indicatorAnchor: indicatorState.anchor ?? { mode: "legacy-window" },
    signalAvailableAt: signalAvailableAt.toISOString(),
    candle: { open: candle.open, high: candle.high, low: candle.low, close: candle.close },
    market: {
      regime: getExecutionMarketRegime(candle),
      session: getExecutionTradingSession(candle.openTime),
    },
    indicators: {
      version: executionIndicatorVersion,
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
  if (error instanceof ValidationInstrumentRulesError)
    return { code: error.code, message: error.message };
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
  return runtimeErrorMessage(error, config.BYBIT_PROXY_URL);
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
    runtimeLagMs: config.RUNTIME_QUOTE_MAX_AGE_MS,
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
  fundingLoop(),
  candleDataLoop(),
  instrumentMetadataLoop(),
  marketStreamLoop(),
  priceJournalLoop(),
  priceArchiveLoop(),
  accountSnapshotLoop(),
  validationJobLoop(),
  exchangeVerificationLoop(),
  runtimeLoop(),
  runtimeQuoteLoop(),
  runtimeEntryLoop(),
  runtimeProtectionLoop(),
  riskGuardLoop(),
  watchdogLoop(),
]);
