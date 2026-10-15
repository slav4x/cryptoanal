import {
  enabledFundingPolicy,
  type ExecutionFundingDataset,
} from "../packages/application/src/execution-funding";
import {
  FundingRepository,
  initialPositionFundingState,
} from "../packages/persistence/src/funding-repository";
import assert from "node:assert/strict";
import { Prisma } from "../packages/persistence/src/generated/prisma/client";
import { createHash, createHmac, randomUUID } from "node:crypto";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { test } from "node:test";
import { createPrismaClient } from "../packages/persistence/src/client";
import {
  validationIndicatorSource,
  loadValidationIndicatorSeed,
} from "../apps/worker/src/runtime-indicator-seed";
import { DeploymentRepository } from "../packages/persistence/src/deployment-repository";
import {
  ValidationRepository,
  ValidationDatasetConflictError,
} from "../packages/persistence/src/validation-repository";
import {
  advanceExecutionIndicators,
  getTradingDateKey,
  executionStopRisk,
} from "../packages/application/src/index";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import { MarketDataRepository } from "../packages/persistence/src/market-data-repository";
import { AccountSnapshotRepository } from "../packages/persistence/src/account-snapshot-repository";
import { DecisionRepository } from "../packages/persistence/src/decision-repository";
import { HealthRepository } from "../packages/persistence/src/health-repository";
import {
  RuntimeRepository,
  RuntimeStateConflictError,
  type PersistRuntimeCycleInput,
  type PersistRuntimeQuoteInput,
  type PersistRealtimeEntryInput,
} from "../packages/persistence/src/runtime-repository";

import {
  assessRuntimeRisk,
  RuntimeRiskRepository,
  RuntimeRiskControlConflictError,
  defaultRuntimeRiskPolicy,
  checkRuntimeEntry,
} from "../packages/persistence/src/runtime-risk";
import { PriceEventRepository } from "../packages/persistence/src/price-event-repository";
import { PriceArchiveRepository } from "../packages/persistence/src/price-archive-repository";
import {
  defaultEntryLiquidityPolicy,
  entryLiquidityVersion,
  readExecutionEntryOrder,
} from "../packages/application/src/execution-entry-liquidity";
import { openExecutionPositionAtFill } from "../packages/application/src/execution-engine";
import { verifyEntryExecutionProof } from "../packages/persistence/src/entry-execution-proof";
import { verifyExitTriggerProof } from "../packages/persistence/src/exit-trigger-proof";
import {
  evaluateExecutionPriceExit,
  type ExecutionPosition,
} from "../packages/application/src/execution-engine";
import {
  defaultLiquidityExitPolicy,
  defaultExecutionExitPolicy,
} from "../packages/application/src/execution-exit-policy";
import {
  readLiquidityExitState,
  remainingExitQuantity,
} from "../packages/persistence/src/liquidity-exit-model";
import {
  type LiquidityExitStep,
  verifyLiquidityExitFill,
} from "../packages/persistence/src/liquidity-exit-proof";
import { liquidityExitBasis } from "../packages/persistence/src/liquidity-exit-repository";
import { realizedCashPnl } from "../packages/persistence/src/realized-cash";
import { DashboardRepository } from "../packages/persistence/src/dashboard-repository";
import {
  archivePriceEvent,
  encodePriceArchive,
} from "../packages/persistence/src/price-archive-codec";
import { type StoredExecutionMarketData } from "../packages/application/src/execution-market-data";
import { hashTracePayload } from "../packages/persistence/src/position-trace";
import { processRuntimePriceEvents } from "../apps/worker/src/runtime-price-processor";
import { runtimeTraceInputs } from "../apps/worker/src/runtime-trace";
import { replayRuntimeTrace } from "../apps/worker/src/runtime-trace-replay";
import { createApp } from "../apps/api/src/app";
import { loadServerConfig } from "../packages/config/src/index";

const databaseUrl = process.env.RUNTIME_TEST_DATABASE_URL;
if (databaseUrl && !/^\/cryptoanal_runtime_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname)) {
  throw new Error("Use a dedicated cryptoanal_runtime_test_* database");
}

test("runtime persistence against isolated PostgreSQL", { skip: !databaseUrl }, async (t) => {
  const prisma = createPrismaClient(databaseUrl!);
  const runtime = new RuntimeRepository(prisma);
  const candles = new MarketDataRepository(prisma);
  const snapshots = new AccountSnapshotRepository(prisma);
  const decisions = new DecisionRepository(prisma);
  const candleAt = new Date("2026-01-01T12:00:00Z");
  let quoteAt = new Date();
  t.beforeEach(() => {
    quoteAt = new Date();
  });
  async function setup(shared?: { workspace: { id: string }; account: string }) {
    const suffix = randomUUID();
    const workspace =
      shared?.workspace ??
      (await prisma.workspace.create({
        data: { slug: suffix, name: "Runtime test" },
      }));
    const strategy = await prisma.strategy.create({
      data: {
        workspaceId: workspace.id,
        name: `Test ${suffix}`,
        createdByActorId: "test",
        updatedByActorId: "test",
      },
    });
    const version = await prisma.strategyVersion.create({
      data: {
        workspaceId: workspace.id,
        strategyId: strategy.id,
        version: 1,
        config: fixture.config,
        configHash: suffix,
        createdByActorId: "test",
      },
    });
    const connection = await prisma.exchangeConnection.create({
      data: {
        workspaceId: workspace.id,
        label: `Test ${suffix}`,
        environment: "DEMO",
        status: "ACTIVE",
        apiKeyHint: "test",
        createdByActorId: "test",
      },
    });
    const deployment = await prisma.deployment.create({
      data: {
        workspaceId: workspace.id,
        strategyId: strategy.id,
        strategyVersionId: version.id,
        exchangeConnectionId: connection.id,
        environment: "DRY_RUN",
        exchangeAccountId: shared?.account ?? suffix,
        status: "RUNNING",
        createdByActorId: "test",
      },
    });
    const run = await prisma.executionRun.create({
      data: {
        workspaceId: workspace.id,
        deploymentId: deployment.id,
        strategyVersionId: version.id,
        environment: "DRY_RUN",
        configHash: suffix,
        contextHash: suffix,
        context: {},
        engineVersion: "test",
        status: "RUNNING",
        createdByActorId: "test",
      },
    });
    const symbol = `TEST${suffix}`;
    const instrumentRules = {
      version: 1 as const,
      symbol,
      observedAt: quoteAt.toISOString(),
      tickSize: "0.00000001",
      qtyStep: "0.00000001",
      minOrderQty: "0.00000001",
      minNotional: "0",
      minPrice: "0.00000001",
      maxPrice: "100000000",
      maxOrderQty: "100000000",
      maxMarketOrderQty: "100000000",
    };
    await prisma.marketInstrument.create({
      data: {
        symbol,
        baseAsset: "TEST",
        quoteAsset: "USDT",
        exchange: "bybit",
        instrumentType: "linear-perpetual",
        status: "Trading",
        ...Object.fromEntries(
          Object.entries(instrumentRules).filter(
            ([key]) => !["version", "symbol", "observedAt"].includes(key),
          ),
        ),
        metadataSyncedAt: quoteAt,
      },
    });
    const pendingSignal = {
      mode: "realtime",
      side: "long",
      signalPrice: 100,
      detectedAt: quoteAt.toISOString(),
      availableAt: quoteAt.toISOString(),
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      entryRegime: "neutral",
    };
    await prisma.runtimeCursor.create({
      data: {
        workspaceId: workspace.id,
        executionRunId: run.id,
        symbol,
        lastEvaluatedAt: candleAt,
        pendingSignal,
      },
    });
    const priceEvent = await prisma.marketPriceEvent.create({
      data: { eventKey: suffix, symbol, price: "100", observedAt: quoteAt, streamId: suffix },
    });
    const entry: PersistRealtimeEntryInput = {
      entryPriceEventId: priceEvent.id,
      workspaceId: workspace.id,
      deploymentId: deployment.id,
      executionRunId: run.id,
      strategyVersionId: version.id,
      symbol,
      expectedCandleAt: candleAt,
      quoteAt,
      quotePrice: "100",
      unrealizedPnl: "0",
      maxOpenPositions: 1,
      entryOrderType: "MARKET",
      factors: {},
      position: {
        instrumentRules,
        symbol,
        side: "BUY",
        entryRegime: "NEUTRAL",
        entrySession: "EUROPE",
        openedAt: quoteAt,
        entryPrice: "100",
        quantity: "1",
        stopPrice: "98",
        takePrice: "104",
        trailingPrice: null,
        bestPrice: "100",
        entryFee: "0.06",
        entrySlippage: "0",
      },
    };
    return { workspace, connection, deployment, run, symbol, entry };
  }
  async function open() {
    const context = await setup();
    assert.equal((await runtime.persistRealtimeEntry(context.entry)).applied, true);
    const position = await prisma.position.findFirstOrThrow({
      where: { executionRunId: context.run.id },
    });
    const nextEvent = await prisma.marketPriceEvent.create({
      data: {
        eventKey: randomUUID(),
        symbol: context.symbol,
        price: "103",
        observedAt: new Date(quoteAt.getTime() + 1),
        streamId: context.deployment.exchangeAccountId,
      },
    });
    const quote: PersistRuntimeQuoteInput = {
      workspaceId: context.workspace.id,
      deploymentId: context.deployment.id,
      executionRunId: context.run.id,
      strategyVersionId: position.strategyVersionId,
      positionId: position.id,
      expectedPositionVersion: position.runtimeVersion,
      symbol: context.symbol,
      quotePrice: "103",
      quoteAt: nextEvent.observedAt,
      processedPrice: {
        eventId: nextEvent.id,
        streamId: nextEvent.streamId,
        throughAt: nextEvent.observedAt,
      },
      factors: {},
      action: {
        kind: "update",
        markPrice: "103",
        unrealizedPnl: "3",
        bestPrice: "103",
        stopPrice: "100.12",
        trailingPrice: "102",
      },
    };
    return { ...context, position, quote };
  }
  function decisionEngineFields(context: Awaited<ReturnType<typeof setup>>) {
    const availableAt = new Date();
    const snapshot = {
      schemaVersion: 1,
      featureSetVersion: "test-features@1",
      engineVersion: "test",
      availableAt: availableAt.toISOString(),
    };
    return {
      providerVersion: "test",
      candidate: {
        action: "BUY",
        side: "long",
        tradable: true,
        confidence: 1,
        reasonCodes: ["TEST"],
        summary: "Test",
        generatedAt: availableAt.toISOString(),
        validUntil: new Date(availableAt.getTime() + 60_000).toISOString(),
      },
      contextSnapshot: {
        workspaceId: context.workspace.id,
        executionRunId: context.run.id,
        strategyVersionId: context.entry.strategyVersionId,
        symbol: context.symbol,
        schemaVersion: 1,
        featureSetVersion: "test-features@1",
        contentHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
        availableAt,
        context: snapshot,
      },
    } satisfies Pick<PersistRuntimeCycleInput, "providerVersion" | "candidate" | "contextSnapshot">;
  }
  try {
    await t.test("ticker funding fields never leak into market snapshot storage", async () => {
      const c = await setup();
      const ticker = {
        symbol: c.symbol,
        price: "100",
        change24hPercent: "1",
        volume24h: "10",
        observedAt: new Date(),
        markPrice: "101",
        nextFundingAt: new Date(Date.now() + 3600000),
      };
      assert.equal(await candles.saveSnapshots([ticker]), 1);
      const stored = await prisma.marketSnapshot.findFirstOrThrow({ where: { symbol: c.symbol } });
      assert.equal(stored.price.toFixed(), "100");
      assert.equal(stored.regime, "unknown");
    });
    await t.test(
      "archive cleanup retains a pending entry cursor without open positions",
      async () => {
        const context = await setup();
        const pending = await prisma.marketPriceEvent.create({
          data: {
            eventKey: randomUUID(),
            symbol: context.symbol,
            price: "100",
            observedAt: new Date(0),
            streamId: "same",
          },
        });
        await prisma.runtimeCursor.update({
          where: {
            executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
          },
          data: { pendingPriceEventId: pending.id },
        });
        await new PriceArchiveRepository(prisma).archiveAndPrune(new Date(Date.now() + 10000));
        assert.ok(await prisma.marketPriceEvent.findUnique({ where: { id: pending.id } }));
        await prisma.runtimeCursor.update({
          where: {
            executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
          },
          data: { pendingPriceEventId: null, pendingSignal: Prisma.DbNull },
        });
      },
    );
    await t.test(
      "complete entry-to-stop trace survives hot cleanup, repository restart and checksum verification",
      async () => {
        const context = await open();
        const config = strategyConfigSchema.parse(fixture.config);
        const initial = await prisma.positionExecutionTrace.findUniqueOrThrow({
          where: { positionId: context.position.id },
        });
        assert.equal(initial.fullFromEntry, true);
        assert.equal(hashTracePayload(initial.snapshot), initial.snapshotHash);
        const extra = await prisma.marketPriceEvent.create({
          data: {
            eventKey: randomUUID(),
            symbol: context.symbol,
            price: "97",
            observedAt: new Date(+context.quote.quoteAt + 1),
            streamId: context.quote.processedPrice.streamId,
            receivedAt: new Date(+context.quote.quoteAt + 100),
            executionData: [
              1,
              "0.123456789012345678",
              "Sell",
              false,
              null,
              ["96", "1", "98", "2", +context.quote.quoteAt, +context.quote.quoteAt, "1", "2"],
            ],
          },
        });
        const first = await prisma.marketPriceEvent.findUniqueOrThrow({
          where: { id: context.quote.processedPrice.eventId },
        });
        const events = [first, extra].map((event) => ({ ...event, price: Number(event.price) }));
        await processRuntimePriceEvents({
          position: {
            ...context.entry.position,
            symbol: context.symbol,
            side: "long",
            entryRegime: "neutral",
            entrySession: "europe",
            entryPrice: 100,
            quantity: 1,
            stopPrice: 98,
            takePrice: 104,
            bestPrice: 100,
            trailingPrice: null,
            entryFee: 0.06,
            entrySlippage: 0,
          },
          through: context.entry.quoteAt,
          streamId: first.streamId,
          events,
          config,
          recover: async () => {
            throw new Error("unexpected gap");
          },
          checkpoint: async (checkpoint) => {
            assert.ok(checkpoint.settlement);
            const settlement = checkpoint.settlement;
            const result = await runtime.persistRealtimeQuote({
              ...context.quote,
              processedEventCount: events.length,
              quoteAt: checkpoint.through,
              quotePrice: String(checkpoint.markPrice),
              processedPrice: {
                eventId: checkpoint.event.id,
                streamId: checkpoint.streamId,
                throughAt: checkpoint.through,
              },
              traceInputs: runtimeTraceInputs({
                firstEventId: first.id,
                policy: null,
                signals: [],
                recoveries: [],
              }),
              action: {
                kind: "close",
                protection: {
                  stopPrice: String(checkpoint.position.stopPrice),
                  bestPrice: String(checkpoint.position.bestPrice),
                  trailingPrice: null,
                },
                settlement: {
                  exitPrice: String(settlement.exitPrice),
                  grossPnl: String(settlement.grossPnl),
                  netPnl: String(settlement.netPnl),
                  fees: String(settlement.fees),
                  slippage: String(settlement.slippage),
                  exitReason: settlement.exitReason,
                  closedAt: new Date(settlement.closedAt),
                },
              },
            });
            return result.applied;
          },
        });
        const trace = await prisma.positionExecutionTrace.findUniqueOrThrow({
          where: { positionId: initial.positionId },
          include: { records: true, position: { include: { trade: true } } },
        });
        assert.equal(trace.snapshotHash, initial.snapshotHash);
        assert.equal(trace.endEventId, extra.id);
        assert.ok(trace.retainUntil && +trace.retainUntil > +trace.closedAt!);
        const archive = new PriceArchiveRepository(prisma);
        const result = await archive.archiveAndPrune(new Date(Date.now() + 10000));
        assert.equal(result.archived, 3);
        assert.equal(await prisma.marketPriceEvent.count({ where: { symbol: context.symbol } }), 0);
        const restarted = new PriceArchiveRepository(prisma),
          trade = trace.position.trade!;
        assert.deepEqual(
          (await restarted.after(context.symbol, first.id, extra.id))[0]!.executionData,
          extra.executionData,
        );
        const replay = await replayRuntimeTrace({
          snapshot: trace.snapshot,
          snapshotHash: trace.snapshotHash,
          fullFromEntry: trace.fullFromEntry,
          startEventId: trace.startEventId,
          endEventId: trace.endEventId!,
          expectedEventCount: trace.eventCount,
          records: trace.records,
          loadEvents: (cursor, through) => restarted.after(context.symbol, cursor, through),
          trade: {
            exitReason: trade.exitReason,
            closedAt: trade.closedAt,
            averageExitPrice: trade.averageExitPrice.toFixed(),
            grossPnl: trade.grossPnl.toFixed(),
            netPnl: trade.netPnl.toFixed(),
            fees: trade.fees.toFixed(),
            slippage: trade.slippage.toFixed(),
          },
        });
        assert.equal(replay.status, "matched");
        assert.equal(replay.events, 2);
        assert.equal(replay.coverage, "from-entry");
        await archive.cleanup();
        assert.equal(
          await prisma.marketPriceArchiveChunk.count({ where: { symbol: context.symbol } }),
          1,
        );
        await prisma.positionExecutionTrace.update({
          where: { positionId: trace.positionId },
          data: { retainUntil: new Date(0) },
        });
        await archive.cleanup();
        assert.equal(
          await prisma.marketPriceArchiveChunk.count({ where: { symbol: context.symbol } }),
          0,
        );
      },
    );
    await t.test(
      "archive insertion failure preserves hot events and does not release the unprocessed cursor",
      async () => {
        const context = await open(),
          archive = new PriceArchiveRepository(prisma);
        const candidate = await prisma.marketPriceEvent.create({
          data: {
            eventKey: randomUUID(),
            symbol: context.symbol,
            price: "99",
            observedAt: new Date(Date.now() - 2 * 86400_000),
            streamId: "old",
          },
        });
        await prisma.position.update({
          where: { id: context.position.id },
          data: { priceEventId: candidate.id },
        });
        assert.equal((await archive.archiveAndPrune(new Date())).count, 2);
        assert.ok(await prisma.marketPriceEvent.findUnique({ where: { id: candidate.id } }));
        await prisma.position.update({
          where: { id: context.position.id },
          data: { priceEventId: candidate.id + 1n },
        });
        await prisma.$executeRawUnsafe(
          `CREATE FUNCTION fail_trace_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'archive unavailable'; END $$`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER fail_trace_archive BEFORE INSERT ON "MarketPriceArchiveChunk" FOR EACH ROW EXECUTE FUNCTION fail_trace_archive()`,
        );
        try {
          await assert.rejects(archive.archiveAndPrune(new Date()), /archive unavailable/);
          assert.ok(await prisma.marketPriceEvent.findUnique({ where: { id: candidate.id } }));
        } finally {
          await prisma.$executeRawUnsafe(
            `DROP TRIGGER fail_trace_archive ON "MarketPriceArchiveChunk"`,
          );
          await prisma.$executeRawUnsafe(`DROP FUNCTION fail_trace_archive()`);
          await prisma.position.update({
            where: { id: context.position.id },
            data: { priceEventId: null },
          });
          await prisma.positionExecutionTrace.update({
            where: { positionId: context.position.id },
            data: { retainUntil: new Date(0) },
          });
        }
      },
    );
    await t.test(
      "archive pagination never jumps over quiet-symbol chunks to newer hot prices",
      async () => {
        const symbol = randomUUID(),
          at = new Date();
        for (let index = 0; index < 9; index++) {
          const encoded = await encodePriceArchive([
            {
              id: 1000000000n + BigInt(index * 2),
              symbol,
              eventKey: randomUUID(),
              price: "100",
              observedAt: at,
              receivedAt: at,
              streamId: "same",
            },
          ]);
          const { rawBytes, ...data } = encoded;
          assert.ok(rawBytes > data.payload.byteLength);
          await prisma.marketPriceArchiveChunk.create({ data });
        }
        await prisma.marketPriceEvent.create({
          data: {
            id: 1000000030n,
            symbol,
            eventKey: randomUUID(),
            price: "101",
            observedAt: at,
            streamId: "same",
          },
        });
        const archive = new PriceArchiveRepository(prisma);
        const first = await archive.after(symbol, 999999999n, 1000000030n);
        assert.equal(first.length, 8);
        assert.equal(first.at(-1)!.id, 1000000014n);
        const next = await archive.after(symbol, first.at(-1)!.id, 1000000030n);
        assert.deepEqual(
          next.map((event) => event.id),
          [1000000016n, 1000000030n],
        );
      },
    );
    await t.test(
      "trace records policy enable/disable without a protective-level move and rejects stale writes",
      async () => {
        const context = await open();
        const policy = {
          enabledAt: new Date(Date.now() + 86400_000).toISOString(),
          breakEvenActivationR: 0.5,
          trailingActivationR: 1,
          trailingDistanceR: 0.5,
        };
        const first = {
          ...context.quote,
          processedEventCount: 1,
          traceInputs: runtimeTraceInputs({
            firstEventId: context.quote.processedPrice.eventId,
            policy,
            signals: [],
            recoveries: [],
          }),
          action: {
            kind: "update" as const,
            markPrice: "103",
            unrealizedPnl: "2.94",
            bestPrice: "103",
            stopPrice: "98",
            trailingPrice: null,
          },
        };
        assert.equal((await runtime.persistRealtimeQuote(first)).applied, true);
        const event = await prisma.marketPriceEvent.create({
          data: {
            eventKey: randomUUID(),
            symbol: context.symbol,
            price: "100",
            streamId: context.quote.processedPrice.streamId,
            observedAt: new Date(+context.quote.quoteAt + 1),
          },
        });
        assert.equal(
          (
            await runtime.persistRealtimeQuote({
              ...first,
              expectedPositionVersion: 1,
              quotePrice: "100",
              quoteAt: event.observedAt,
              action: { ...first.action, markPrice: "100", unrealizedPnl: "-0.06" },
              processedPrice: {
                eventId: event.id,
                streamId: event.streamId,
                throughAt: event.observedAt,
              },
              traceInputs: runtimeTraceInputs({
                firstEventId: event.id,
                policy: null,
                signals: [],
                recoveries: [],
              }),
            })
          ).applied,
          true,
        );
        assert.equal((await runtime.persistRealtimeQuote(first)).applied, false);
        const trace = await prisma.positionExecutionTrace.findUniqueOrThrow({
          where: { positionId: context.position.id },
          include: { records: true },
        });
        assert.equal(trace.records.length, 2);
        assert.equal(trace.eventCount, 2n);
        assert.equal(trace.policyHash, hashTracePayload(null));
        assert.equal(trace.snapshotHash, hashTracePayload(trace.snapshot));
      },
    );
    await t.test(
      "admitted entry holds instrument metadata stable until transaction completion",
      async () => {
        const context = await setup();
        let ready!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const proceed = new Promise<void>((resolve) => {
          release = resolve;
        });
        const admission = prisma.$transaction(async (tx) => {
          assert.equal(
            await checkRuntimeEntry(tx, {
              workspaceId: context.workspace.id,
              exchangeAccountId: context.deployment.exchangeAccountId,
              strategyConfig: fixture.config,
              policy: defaultRuntimeRiskPolicy,
              eventId: context.entry.entryPriceEventId,
              position: context.entry.position,
            }),
            null,
          );
          ready();
          await proceed;
        });
        let update: Promise<unknown> | undefined;
        try {
          await Promise.race([started, admission]);
          update = prisma.marketInstrument
            .update({ where: { symbol: context.symbol }, data: { qtyStep: "0.1" } })
            .then((value) => value);
          let blocked = false;
          const deadline = Date.now() + 2000;
          while (!blocked && Date.now() < deadline) {
            const rows = await prisma.$queryRaw<
              Array<{ blocked: boolean }>
            >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%MarketInstrument%') AS blocked`;
            blocked = rows[0]!.blocked;
            if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(blocked, true, "metadata update must wait for the admitted entry");
        } finally {
          release();
          await admission;
          await update;
        }
        assert.equal(
          (
            await prisma.marketInstrument.findUniqueOrThrow({ where: { symbol: context.symbol } })
          ).qtyStep!.toFixed(),
          "0.1",
        );
      },
    );
    await t.test(
      "entry admission rejects missing/stale/changed rules, off-step size and minimum violations",
      async () => {
        for (const kind of [
          "missing",
          "stale",
          "changed",
          "step",
          "notional",
          "max",
          "price",
        ] as const) {
          const context = await setup();
          const input = {
            ...context.entry,
            position: {
              ...context.entry.position,
              instrumentRules: { ...context.entry.position.instrumentRules! },
            },
          };
          let expected: string;
          if (kind === "missing") {
            delete (input.position as typeof context.entry.position).instrumentRules;
            expected = "INSTRUMENT_RULES_MISSING";
          } else if (kind === "stale") {
            await prisma.marketInstrument.update({
              where: { symbol: context.symbol },
              data: { metadataSyncedAt: new Date(Date.now() - 3600001) },
            });
            expected = "INSTRUMENT_RULES_STALE";
          } else if (kind === "changed") {
            await prisma.marketInstrument.update({
              where: { symbol: context.symbol },
              data: { qtyStep: "0.1" },
            });
            expected = "INSTRUMENT_RULES_CHANGED";
          } else if (kind === "step") {
            input.position.quantity = "1.000000001";
            expected = "INVALID_QUANTITY_STEP";
          } else if (kind === "notional") {
            input.position.instrumentRules.minNotional = "200";
            await prisma.marketInstrument.update({
              where: { symbol: context.symbol },
              data: { minNotional: "200" },
            });
            expected = "ENTRY_BELOW_MIN_NOTIONAL";
          } else if (kind === "max") {
            input.position.instrumentRules.maxMarketOrderQty = "0.5";
            await prisma.marketInstrument.update({
              where: { symbol: context.symbol },
              data: { maxMarketOrderQty: "0.5" },
            });
            expected = "ENTRY_ABOVE_MAX_QUANTITY";
          } else {
            input.position.entryPrice = "100.000000001";
            expected = "INVALID_PRICE_STEP_OR_RANGE";
          }
          const result = await runtime.persistRealtimeEntry(input);
          assert.equal("riskFailure" in result && result.riskFailure, expected, kind);
          assert.equal(
            await prisma.position.count({ where: { executionRunId: context.run.id } }),
            0,
          );
          assert.equal(
            await prisma.fill.count({ where: { order: { executionRunId: context.run.id } } }),
            0,
          );
        }
      },
    );
    await t.test(
      "position and trace pin the same rules; later metadata cannot rewrite them",
      async () => {
        const context = await open();
        const position = await prisma.position.findUniqueOrThrow({
          where: { id: context.position.id },
        });
        const trace = await prisma.positionExecutionTrace.findUniqueOrThrow({
          where: { positionId: context.position.id },
        });
        assert.equal(
          hashTracePayload(position.instrumentRules),
          hashTracePayload(context.entry.position.instrumentRules),
        );
        assert.equal(
          hashTracePayload(
            (trace.snapshot as { position: { instrumentRules: unknown } }).position.instrumentRules,
          ),
          hashTracePayload(position.instrumentRules),
        );
        await prisma.marketInstrument.update({
          where: { symbol: context.symbol },
          data: { qtyStep: "1", tickSize: "1" },
        });
        assert.equal(
          (
            await prisma.positionExecutionTrace.findUniqueOrThrow({
              where: { positionId: context.position.id },
            })
          ).snapshotHash,
          trace.snapshotHash,
        );
      },
    );
    await t.test(
      "entry trace starts from stored decimal precision rather than discarded fee digits",
      async () => {
        const context = await setup();
        assert.equal(
          (
            await runtime.persistRealtimeEntry({
              ...context.entry,
              position: { ...context.entry.position, entryFee: "0.0600000000000000001" },
            })
          ).applied,
          true,
        );
        const position = await prisma.position.findFirstOrThrow({
          where: { executionRunId: context.run.id },
        });
        const trace = await prisma.positionExecutionTrace.findUniqueOrThrow({
          where: { positionId: position.id },
        });
        assert.equal(
          (trace.snapshot as { position: { entryFee: string } }).position.entryFee,
          position.entryFee.toFixed(),
        );
      },
    );
    await t.test(
      "validation retries reuse the original instrument scenario and reject corrupted snapshots",
      async () => {
        const context = await setup();
        const run = await prisma.validationRun.create({
          data: {
            workspaceId: context.workspace.id,
            strategyId: context.deployment.strategyId,
            strategyVersionId: context.entry.strategyVersionId,
            kind: "BACKTEST",
            status: "RUNNING",
            datasetId: "rule-snapshot",
            datasetAsOf: quoteAt,
            engineVersion: "test",
            configHash: context.run.configHash,
            input: {},
            createdByActorId: "test",
          },
        });
        const job = await prisma.job.create({
          data: {
            workspaceId: context.workspace.id,
            kind: "BACKTEST",
            status: "RUNNING",
            lockedBy: "rules-test",
            lockedAt: quoteAt,
            input: {},
            idempotencyKey: randomUUID(),
            createdByActorId: "test",
          },
        });
        const repository = new ValidationRepository(prisma);
        const input = {
          workspaceId: context.workspace.id,
          runId: run.id,
          jobId: job.id,
          workerId: "rules-test",
          symbols: [context.symbol],
        };
        const original = await repository.pinInstrumentRules(input);
        await prisma.marketInstrument.update({
          where: { symbol: context.symbol },
          data: { tickSize: "1", metadataSyncedAt: new Date(0) },
        });
        assert.deepEqual(await repository.pinInstrumentRules(input), original);
        const saved = await prisma.validationRun.findUniqueOrThrow({ where: { id: run.id } });
        const corrupted = JSON.parse(JSON.stringify(saved.executionRules));
        corrupted.payload.instruments[context.symbol].tickSize = "1";
        await prisma.validationRun.update({
          where: { id: run.id },
          data: { executionRules: corrupted },
        });
        await assert.rejects(repository.pinInstrumentRules(input), /снимок/);
        await prisma.validationRun.update({
          where: { id: run.id },
          data: {
            status: "COMPLETED",
            executionRules: saved.executionRules as Prisma.InputJsonValue,
          },
        });
        await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED" } });
      },
    );
    await t.test(
      "deployment pins its immutable validation seed and changed snapshot data is rejected",
      async () => {
        const context = await setup();
        const version = await prisma.strategyVersion.findUniqueOrThrow({
          where: { id: context.entry.strategyVersionId },
        });
        const validations = new ValidationRepository(prisma);
        const validation = await prisma.validationRun.create({
          data: {
            workspaceId: context.workspace.id,
            strategyId: version.strategyId,
            strategyVersionId: version.id,
            kind: "BACKTEST",
            status: "RUNNING",
            datasetId: "seed-test",
            datasetAsOf: quoteAt,
            engineVersion: "current",
            configHash: version.configHash,
            input: {},
            createdByActorId: "test",
          },
        });
        const job = await prisma.job.create({
          data: {
            workspaceId: context.workspace.id,
            kind: "BACKTEST",
            status: "RUNNING",
            lockedBy: "seed-test",
            lockedAt: quoteAt,
            input: {},
            idempotencyKey: randomUUID(),
            createdByActorId: "test",
          },
        });
        const materialized = await validations.materializeDataset({
          workspaceId: context.workspace.id,
          runId: validation.id,
          jobId: job.id,
          workerId: "seed-test",
          source: "bybit-public-linear-klines",
          exchange: "bybit",
          instrumentType: "linear-perpetual",
          timeframe: "15m",
          symbols: [context.symbol],
          candles: fixture.candles.map((candle) => ({
            ...candle,
            symbol: context.symbol,
            openTime: new Date(candle.openTime),
            open: String(candle.open),
            high: String(candle.high),
            low: String(candle.low),
            close: String(candle.close),
            turnover: String(candle.turnover),
            volume: "1",
          })),
        });
        await prisma.validationRun.update({
          where: { id: validation.id },
          data: { status: "COMPLETED", verdict: "PASSED", completedAt: quoteAt },
        });
        await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED" } });
        await prisma.executionRun.update({
          where: { id: context.run.id },
          data: { status: "COMPLETED" },
        });
        await prisma.deployment.update({
          where: { id: context.deployment.id },
          data: { status: "READY" },
        });
        await prisma.exchangeConnection.update({
          where: { id: context.connection.id },
          data: { lastVerifiedAt: quoteAt },
        });
        const deployments = new DeploymentRepository(prisma);
        await deployments.applyCommand({
          workspaceId: context.workspace.id,
          deploymentId: context.deployment.id,
          command: "START",
          expectedStatus: "READY",
          actorId: "test",
          requestId: "seed-test",
          reason: "Seed test",
          idempotencyKey: randomUUID(),
          engineVersion: "current",
        });
        const started = await prisma.executionRun.findFirstOrThrow({
          where: { deploymentId: context.deployment.id, status: "RUNNING" },
        });
        const source = validationIndicatorSource(started.context)!;
        assert.equal(source.datasetSnapshotId, materialized.id);
        const snapshot = await validations.getDatasetSnapshot(
          context.workspace.id,
          source.datasetSnapshotId,
        );
        assert.ok(snapshot);
        assert.equal(source.contentHash, snapshot.contentHash);
        const loadSnapshot = async (id: string) => {
          const value = await validations.getDatasetSnapshot(context.workspace.id, id);
          return (
            value && {
              ...value,
              candles: value.candles.map((candle) => ({
                ...candle,
                open: candle.open.toNumber(),
                high: candle.high.toNumber(),
                low: candle.low.toNumber(),
                close: candle.close.toNumber(),
                turnover: candle.turnover.toNumber(),
              })),
            }
          );
        };
        const seed = await loadValidationIndicatorSeed({
          source,
          symbol: context.symbol,
          config: strategyConfigSchema.parse(fixture.config),
          availableAt: quoteAt,
          loadSnapshot,
        });
        assert.equal(seed.checkpoint.anchor?.contentHash, snapshot.contentHash);
        assert.equal(seed.checkpoint.anchor?.validationRunId, validation.id);
        const target = (await runtime.listActiveTargets(context.workspace.id))[0]!;
        assert.deepEqual(validationIndicatorSource(target.executionRuns[0]!.context), source);
        await prisma.datasetSnapshotCandle.update({
          where: {
            datasetSnapshotId_symbol_openTime: {
              datasetSnapshotId: snapshot.id,
              symbol: context.symbol,
              openTime: snapshot.candles[0]!.openTime,
            },
          },
          data: { close: "99" },
        });
        await assert.rejects(
          loadValidationIndicatorSeed({
            source,
            symbol: context.symbol,
            config: strategyConfigSchema.parse(fixture.config),
            availableAt: quoteAt,
            loadSnapshot,
          }),
          ValidationDatasetConflictError,
        );
      },
    );
    await t.test(
      "indicator checkpoint commits with its decision and stale writers cannot replace it",
      async () => {
        const context = await setup();
        const config = strategyConfigSchema.parse(fixture.config);
        const candles = fixture.candles.map((candle, index) => ({
          ...candle,
          symbol: context.symbol,
          openTime: new Date(+quoteAt - (fixture.candles.length - 1 - index) * 900_000),
        }));
        const checkpoint = advanceExecutionIndicators(candles, config).checkpoint!;
        const cycle: PersistRuntimeCycleInput = {
          ...context.entry,
          ...decisionEngineFields(context),
          interval: "15",
          candleAt: quoteAt,
          indicatorState: checkpoint,
          expectedLastEvaluatedAt: candleAt,
          expectedDeploymentStatus: "RUNNING",
          expectedPositionId: null,
          expectedPositionVersion: null,
          pendingSignal: null,
          decision: { action: "HOLD", reasonCode: "TEST", summary: "Test", factors: {} },
          positionAction: { kind: "none" },
        };
        assert.equal((await runtime.persistCycle(cycle)).applied, true);
        assert.deepEqual(
          await runtime.getIndicatorState(context.run.id, context.symbol),
          checkpoint,
        );
        const stored = await prisma.runtimeCursor.findUniqueOrThrow({
          where: {
            executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
          },
        });
        assert.equal(+stored.lastEvaluatedAt!, +quoteAt);
        assert.ok(stored.lastDecisionId);
        const nextAt = new Date(+quoteAt + 900_000);
        const nextCheckpoint = advanceExecutionIndicators(
          [{ ...candles.at(-1)!, openTime: nextAt, close: 101 }],
          config,
          checkpoint,
        ).checkpoint!;
        await assert.rejects(
          runtime.persistCycle({ ...cycle, candleAt: nextAt, indicatorState: nextCheckpoint }),
          RuntimeStateConflictError,
        );
        assert.deepEqual(
          await runtime.getIndicatorState(context.run.id, context.symbol),
          checkpoint,
        );
        assert.equal(
          await prisma.decision.count({
            where: { executionRunId: context.run.id, contextSnapshotId: { not: null } },
          }),
          1,
        );
        assert.equal(
          (
            await runtime.persistCycle({
              ...cycle,
              candleAt: nextAt,
              expectedLastEvaluatedAt: quoteAt,
              indicatorState: nextCheckpoint,
            })
          ).applied,
          true,
        );
        assert.deepEqual(
          await runtime.getIndicatorState(context.run.id, context.symbol),
          nextCheckpoint,
        );
        assert.equal((await runtime.persistCycle(cycle)).applied, false);
        assert.deepEqual(
          await runtime.getIndicatorState(context.run.id, context.symbol),
          nextCheckpoint,
        );
      },
    );
    await t.test(
      "profit protection checkpoint is atomic with price progress and stale writers cannot overwrite it",
      async () => {
        const context = await open();
        const profitProtection = {
          version: 1,
          policyKey: "policy-v1",
          activatedAt: quoteAt.toISOString(),
          bestPrice: 103,
        };
        const input = { ...context.quote, profitProtection };
        assert.equal((await runtime.persistRealtimeQuote(input)).applied, true);
        assert.equal(
          (
            await runtime.persistRealtimeQuote({
              ...input,
              profitProtection: { ...profitProtection, bestPrice: 999 },
            })
          ).applied,
          false,
        );
        const stored = await prisma.position.findUniqueOrThrow({
          where: { id: context.position.id },
        });
        assert.deepEqual(stored.profitProtection, profitProtection);
        assert.equal(stored.priceEventId, input.processedPrice.eventId);
        assert.equal(stored.runtimeVersion, 1);
        assert.deepEqual(
          (await runtime.listRealtimePositions(context.workspace.id))[0]!.profitProtection,
          profitProtection,
        );
        assert.equal(
          await prisma.auditEvent.count({
            where: {
              resourceId: context.position.id,
              action: "position.profit-protection.activate",
            },
          }),
          1,
        );
      },
    );
    await t.test(
      "recovery remains unresolved after a prefix or candle cycle and clears only at the journal tail",
      async () => {
        const context = await open();
        const tail = await prisma.marketPriceEvent.create({
          data: {
            eventKey: randomUUID(),
            symbol: context.symbol,
            price: "103",
            observedAt: new Date(+context.quote.quoteAt + 1),
            receivedAt: new Date(Date.now() - 60000),
            streamId: context.quote.processedPrice.streamId,
          },
        });
        await runtime.recordFailure({
          workspaceId: context.workspace.id,
          executionRunId: context.run.id,
          symbol: context.symbol,
          code: "RUNTIME_RECOVERY_REQUIRED",
          message: "missing range",
        });
        assert.equal((await runtime.persistRealtimeQuote(context.quote)).applied, true);
        const cursorKey = {
          executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
        };
        assert.equal(
          (await prisma.runtimeCursor.findUniqueOrThrow({ where: cursorKey })).lastFailureCode,
          "RUNTIME_RECOVERY_REQUIRED",
        );
        assert.equal(
          (
            await new RuntimeRiskRepository(prisma).assess(
              context.workspace.id,
              context.deployment.exchangeAccountId,
              fixture.config,
            )
          ).reason,
          "MARKET_RECOVERY_REQUIRED",
        );
        const health = new HealthRepository(prisma);
        const progress = await health.getRuntimeProgress(context.workspace.id);
        assert.equal(progress.length, 1);
        assert.equal(progress[0]!.pendingEvents, 1);
        assert.equal(progress[0]!.latestEventId, String(tail.id));
        assert.equal(progress[0]!.streamMatches, true);
        assert.ok(+progress[0]!.oldestPendingReceivedAt! < Date.now() - 30000);
        await runtime.persistCycle({
          ...context.entry,
          ...decisionEngineFields(context),
          interval: "15",
          candleAt: quoteAt,
          expectedDeploymentStatus: "RUNNING",
          expectedPositionId: context.position.id,
          expectedPositionVersion: 1,
          pendingSignal: null,
          decision: { action: "HOLD", reasonCode: "TEST", summary: "Test", factors: {} },
          positionAction: { kind: "none" },
        });
        assert.equal(
          (await prisma.runtimeCursor.findUniqueOrThrow({ where: cursorKey })).lastFailureCode,
          "RUNTIME_RECOVERY_REQUIRED",
        );
        assert.equal(
          (
            await runtime.persistRealtimeQuote({
              ...context.quote,
              expectedPositionVersion: 1,
              quoteAt: tail.observedAt,
              processedPrice: {
                eventId: tail.id,
                streamId: tail.streamId,
                throughAt: tail.observedAt,
              },
            })
          ).applied,
          true,
        );
        assert.equal(
          (await prisma.runtimeCursor.findUniqueOrThrow({ where: cursorKey })).lastFailureCode,
          null,
        );
        assert.equal((await health.getRuntimeProgress(context.workspace.id))[0]!.pendingEvents, 0);
        const other = await setup();
        assert.deepEqual(await health.getRuntimeProgress(other.workspace.id), []);
      },
    );
    await t.test(
      "closed candle replaces partial history and resists delayed partial snapshots",
      async () => {
        const context = await setup();
        const first = {
          symbol: context.symbol,
          interval: "15",
          openTime: candleAt,
          open: "100",
          high: "101",
          low: "99",
          close: "100",
          volume: "1",
          turnover: "100",
          isClosed: false,
        };
        await candles.saveCandles([first]);
        assert.equal(
          (
            await prisma.marketCandle.findUniqueOrThrow({
              where: {
                symbol_interval_openTime: {
                  symbol: context.symbol,
                  interval: "15",
                  openTime: candleAt,
                },
              },
            })
          ).finalizedAt,
          null,
        );
        const second = { ...first, openTime: quoteAt };
        await candles.saveCandles([{ ...first, close: "101", isClosed: true }, second]);
        await candles.saveCandles([first]);
        const rows = await prisma.marketCandle.findMany({
          where: { symbol: context.symbol },
          orderBy: { openTime: "asc" },
        });
        assert.equal(rows[0]!.close.toNumber(), 101);
        assert.equal(rows[0]!.isClosed, true);
        assert.ok(rows[0]!.finalizedAt);
        const finalizedAt = rows[0]!.finalizedAt;
        await candles.saveCandles([{ ...first, close: "101", isClosed: true }]);
        assert.equal(
          +(
            await prisma.marketCandle.findUniqueOrThrow({
              where: {
                symbol_interval_openTime: {
                  symbol: context.symbol,
                  interval: "15",
                  openTime: candleAt,
                },
              },
            })
          ).finalizedAt!,
          +finalizedAt!,
        );
        const key = {
          symbol_interval_openTime: { symbol: context.symbol, interval: "15", openTime: candleAt },
        };
        assert.equal((await prisma.marketCandle.findUniqueOrThrow({ where: key })).revisedAt, null);
        await candles.saveCandles([{ ...first, close: "101", volume: "2", isClosed: true }]);
        assert.equal((await prisma.marketCandle.findUniqueOrThrow({ where: key })).revisedAt, null);
        await candles.saveCandles([{ ...first, close: "100.99", turnover: "101", isClosed: true }]);
        const revised = await prisma.marketCandle.findUniqueOrThrow({ where: key });
        assert.ok(revised.revisedAt);
        assert.equal(+revised.finalizedAt!, +finalizedAt!);
        assert.equal(
          +(await candles.indicatorRevisionAt(
            context.symbol,
            "15",
            new Date(+candleAt - 1),
            quoteAt,
          ))!,
          +revised.revisedAt,
        );
        assert.equal(
          await candles.indicatorRevisionAt(context.symbol, "15", candleAt, quoteAt),
          null,
        );
        assert.equal(
          await candles.indicatorRevisionAt(context.symbol, "1", new Date(+candleAt - 1), quoteAt),
          null,
        );
        assert.equal(
          await candles.indicatorRevisionAt("OTHERUSDT", "15", new Date(+candleAt - 1), quoteAt),
          null,
        );
        await candles.saveCandles([{ ...first, close: "100.99", turnover: "101", isClosed: true }]);
        await candles.saveCandles([first]);
        assert.equal(
          +(await prisma.marketCandle.findUniqueOrThrow({ where: key })).revisedAt!,
          +revised.revisedAt,
        );
        const recoveryHistory = await candles.listRecoveryCandles(
          context.symbol,
          "15",
          candleAt,
          quoteAt,
        );
        assert.equal(recoveryHistory.length, 1);
        assert.equal(recoveryHistory[0]!.isClosed, true);
        const state = await runtime.getCycleState({
          workspaceId: context.workspace.id,
          exchangeAccountId: context.deployment.exchangeAccountId,
          executionRunId: context.run.id,
          symbol: context.symbol,
          interval: "15",
          lastCompleteCandleAt: quoteAt,
          candleLimit: 10,
        });
        assert.equal(state.candles.length, 1);
      },
    );
    await t.test("a completed candle close resolves recovery for the closed position", async () => {
      const context = await open();
      await runtime.recordFailure({
        workspaceId: context.workspace.id,
        executionRunId: context.run.id,
        symbol: context.symbol,
        code: "RUNTIME_RECOVERY_REQUIRED",
        message: "missing range",
      });
      await runtime.persistCycle({
        ...context.entry,
        ...decisionEngineFields(context),
        interval: "15",
        candleAt: quoteAt,
        expectedDeploymentStatus: "RUNNING",
        expectedPositionId: context.position.id,
        expectedPositionVersion: 0,
        pendingSignal: null,
        decision: { action: "CLOSE", reasonCode: "TEST", summary: "Test", factors: {} },
        positionAction: {
          kind: "close",
          positionId: context.position.id,
          settlement: {
            exitPrice: "98",
            grossPnl: "-2",
            netPnl: "-2.1188",
            fees: "0.1188",
            slippage: "0",
            exitReason: "stop-loss",
            closedAt: quoteAt,
          },
        },
      });
      const cursor = await prisma.runtimeCursor.findUniqueOrThrow({
        where: {
          executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
        },
      });
      assert.equal(cursor.lastFailureCode, null);
      assert.equal(await prisma.trade.count({ where: { executionRunId: context.run.id } }), 1);
    });
    await t.test("both entry paths reject prices persisted before signal finality", async () => {
      const context = await setup();
      const event = await prisma.marketPriceEvent.findUniqueOrThrow({
        where: { id: context.entry.entryPriceEventId },
      });
      const unavailable = new Date(+event.receivedAt + 60000);
      const blocked = await runtime.persistRealtimeEntry({
        ...context.entry,
        signalAvailableAt: unavailable,
      });
      assert.equal(blocked.applied, false);
      assert.equal(blocked.riskFailure, "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY");
      assert.equal(
        (
          await runtime.persistRealtimeEntry({
            ...context.entry,
            signalAvailableAt: event.receivedAt,
          })
        ).applied,
        true,
      );
      const candle = await setup();
      await runtime.persistCycle({
        ...candle.entry,
        ...decisionEngineFields(candle),
        signalAvailableAt: unavailable,
        interval: "15",
        candleAt: quoteAt,
        expectedDeploymentStatus: "RUNNING",
        expectedPositionId: null,
        expectedPositionVersion: null,
        pendingSignal: null,
        decision: { action: "OPEN", reasonCode: "TEST", summary: "Test", factors: {} },
        positionAction: {
          kind: "open",
          position: candle.entry.position,
          markPrice: "100",
          unrealizedPnl: "0",
          immediateSettlement: null,
        },
      });
      assert.equal(await prisma.position.count({ where: { executionRunId: candle.run.id } }), 0);
      assert.equal(
        (
          await prisma.decision.findFirstOrThrow({
            where: { executionRunId: candle.run.id, contextSnapshotId: { not: null } },
          })
        ).reasonCode,
        "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY",
      );
    });
    await t.test(
      "signal close preserves decision time independently of the replayed quote time",
      async () => {
        const context = await open();
        const decidedAt = new Date();
        assert.equal(
          (
            await runtime.persistRealtimeQuote({
              ...context.quote,
              decidedAt,
              signalCandleAt: candleAt,
              action: {
                kind: "close",
                settlement: {
                  exitPrice: "103",
                  grossPnl: "3",
                  netPnl: "2.8782",
                  fees: "0.1218",
                  slippage: "0",
                  exitReason: "signal-exit",
                  closedAt: context.quote.quoteAt,
                },
              },
            })
          ).closed,
          true,
        );
        const decision = await prisma.decision.findFirstOrThrow({
          where: { positionId: context.position.id, action: "CLOSE" },
        });
        assert.equal(+decision.decidedAt, +decidedAt);
        const trade = await prisma.trade.findUniqueOrThrow({
          where: { positionId: context.position.id },
        });
        assert.equal(+trade.closedAt, +context.quote.quoteAt);
      },
    );
    await t.test("concurrent entry attempts create one position/order/fill", async () => {
      const context = await setup();
      const results = await Promise.all([
        runtime.persistRealtimeEntry(context.entry),
        runtime.persistRealtimeEntry(context.entry),
      ]);
      assert.equal(results.filter((result) => result.applied).length, 1);
      assert.equal(await prisma.position.count({ where: { executionRunId: context.run.id } }), 1);
      assert.equal(await prisma.order.count({ where: { executionRunId: context.run.id } }), 1);
      assert.equal(
        await prisma.fill.count({ where: { order: { executionRunId: context.run.id } } }),
        1,
      );
    });
    await t.test(
      "shadow decisions share immutable context and deduplicate provider runs",
      async () => {
        const context = await setup();
        const fields = decisionEngineFields(context);
        const input = {
          context: fields.contextSnapshot,
          provider: { id: "shadow-test", version: "1", kind: "LLM" as const },
          status: "accepted" as const,
          candidate: fields.candidate,
          rejectionCode: null,
          latencyMs: 12,
          summary: "Shadow candidate accepted",
        };
        const first = await decisions.persistShadowDecision(input);
        const second = await decisions.persistShadowDecision(input);

        assert.equal(first.created, true);
        assert.equal(second.created, false);
        assert.equal(first.id, second.id);
        assert.equal(
          await prisma.decisionContextSnapshot.count({
            where: { executionRunId: context.run.id, symbol: context.symbol },
          }),
          1,
        );
        const stored = await prisma.decision.findUniqueOrThrow({ where: { id: first.id } });
        assert.equal(stored.mode, "SHADOW");
        assert.equal(stored.providerKind, "LLM");
        assert.equal(stored.providerId, "shadow-test");
      },
    );
    await t.test(
      "connection closure during pending creation rejects the new signal with its actual gate reason",
      async () => {
        const context = await setup();
        await prisma.exchangeConnection.update({
          where: { id: context.connection.id },
          data: { status: "INVALID" },
        });
        await runtime.persistCycle({
          ...context.entry,
          ...decisionEngineFields(context),
          interval: "15",
          candleAt: new Date(+quoteAt - 900000),
          expectedDeploymentStatus: "RUNNING",
          expectedPositionId: null,
          expectedPositionVersion: null,
          pendingSignal: {
            mode: "realtime",
            side: "long",
            signalPrice: 100,
            detectedAt: quoteAt.toISOString(),
            availableAt: quoteAt.toISOString(),
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            entryRegime: "neutral",
          },
          decision: {
            action: "HOLD",
            reasonCode: "ENTRY_QUOTE_MISSING",
            summary: "Pending",
            factors: {},
          },
          positionAction: { kind: "none" },
        });
        const decision = await prisma.decision.findFirstOrThrow({
          where: { executionRunId: context.run.id, contextSnapshotId: { not: null } },
        });
        assert.equal(decision.reasonCode, "ENTRY_CONNECTION_UNAVAILABLE");
        assert.equal(decision.action, "SKIP");
        assert.equal(
          (decision.factors as { runtimeSignal: { status: string } }).runtimeSignal.status,
          "REJECTED",
        );
        const cursor = await prisma.runtimeCursor.findUniqueOrThrow({
          where: {
            executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
          },
        });
        assert.equal(cursor.pendingSignal, null);
      },
    );
    await t.test("invalid connection blocks pending and candle entries", async () => {
      const context = await setup();
      await prisma.exchangeConnection.update({
        where: { id: context.connection.id },
        data: { status: "INVALID" },
      });
      assert.equal((await runtime.persistRealtimeEntry(context.entry)).applied, false);
      assert.equal((await runtime.listRealtimePendingEntries(context.workspace.id)).length, 1);
      const cycle: PersistRuntimeCycleInput = {
        ...context.entry,
        ...decisionEngineFields(context),
        interval: "15",
        candleAt: quoteAt,
        expectedDeploymentStatus: "RUNNING",
        expectedPositionId: null,
        expectedPositionVersion: null,
        pendingSignal: null,
        decision: { action: "OPEN", reasonCode: "TEST", summary: "Test", factors: {} },
        positionAction: {
          kind: "open",
          position: context.entry.position,
          markPrice: "100",
          unrealizedPnl: "0",
          immediateSettlement: null,
        },
      };
      await runtime.persistCycle(cycle);
      assert.equal(await prisma.position.count({ where: { executionRunId: context.run.id } }), 0);
      const storedDecision = await prisma.decision.findFirstOrThrow({
        where: {
          executionRunId: context.run.id,
          mode: "EXECUTION",
          contextSnapshotId: { not: null },
        },
      });
      assert.equal(storedDecision.providerId, "cryptoanal-rule-engine");
      assert.ok(storedDecision.contextSnapshotId);
    });
    await t.test(
      "successful non-closing recovery keeps evidence atomically and ignores a stale retry",
      async () => {
        const context = await open();
        const evidence = {
          reason: "stream-change",
          source: "minute-ohlc",
          quality: "bounded-partial-minutes",
          fromAt: context.position.openedAt.toISOString(),
          toAt: context.quote.quoteAt.toISOString(),
          ambiguity: null,
        };
        const recoveredQuote = { ...context.quote, recoveryEvidence: evidence };
        assert.equal((await runtime.persistRealtimeQuote(recoveredQuote)).applied, true);
        assert.equal((await runtime.persistRealtimeQuote(recoveredQuote)).applied, false);
        const audits = await prisma.auditEvent.findMany({
          where: {
            workspaceId: context.workspace.id,
            resourceId: context.position.id,
            action: "position.recover",
          },
        });
        assert.equal(audits.length, 1);
        assert.deepEqual((audits[0]!.metadata as { recovery: unknown }).recovery, evidence);
        assert.equal(await prisma.trade.count({ where: { positionId: context.position.id } }), 0);
      },
    );
    await t.test(
      "realtime entry copies its indicator seed independently of future deployment cycles",
      async () => {
        const context = await setup();
        const config = strategyConfigSchema.parse(fixture.config);
        const source = fixture.candles.map((candle, index) => ({
          ...candle,
          symbol: context.symbol,
          openTime: new Date(+candleAt - (fixture.candles.length - 1 - index) * 900000),
        }));
        const indicatorState = advanceExecutionIndicators(source, config).checkpoint!;
        await prisma.runtimeCursor.update({
          where: {
            executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
          },
          data: { indicatorState },
        });
        assert.equal((await runtime.persistRealtimeEntry(context.entry)).applied, true);
        await prisma.runtimeCursor.update({
          where: {
            executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
          },
          data: { indicatorState: { overwritten: true } },
        });
        const stored = await prisma.position.findFirstOrThrow({
          where: { executionRunId: context.run.id },
        });
        assert.deepEqual(stored.indicatorState, indicatorState);
        assert.equal(
          stored.indicatorState && indicatorState.lastCandleAt,
          stored.signalCandleAt!.toISOString(),
        );
      },
    );
    await t.test(
      "candle entry stores its own indicator seed and signal close retains the consumed state",
      async () => {
        const context = await setup();
        const config = strategyConfigSchema.parse(fixture.config);
        const source = fixture.candles.map((candle, index) => ({
          ...candle,
          symbol: context.symbol,
          openTime: new Date(+quoteAt - (fixture.candles.length - 1 - index) * 900000),
        }));
        const indicatorState = advanceExecutionIndicators(source, config).checkpoint!;
        const cycle: PersistRuntimeCycleInput = {
          ...context.entry,
          ...decisionEngineFields(context),
          interval: "15",
          candleAt: new Date(+quoteAt - 900_000),
          entrySignalPrice: 100,
          indicatorState,
          expectedDeploymentStatus: "RUNNING",
          expectedPositionId: null,
          expectedPositionVersion: null,
          pendingSignal: null,
          decision: { action: "OPEN", reasonCode: "TEST", summary: "Test", factors: {} },
          positionAction: {
            kind: "open",
            position: context.entry.position,
            markPrice: "100",
            unrealizedPnl: "0",
            immediateSettlement: null,
          },
        };
        assert.equal((await runtime.persistCycle(cycle)).applied, true);
        const stored = await prisma.position.findFirstOrThrow({
          where: { executionRunId: context.run.id },
        });
        assert.deepEqual(stored.indicatorState, indicatorState);
        const nextAt = new Date(+quoteAt + 900000);
        const nextState = advanceExecutionIndicators(
          [{ ...source.at(-1)!, openTime: nextAt }],
          config,
          indicatorState,
        ).checkpoint!;
        const result = await runtime.persistRealtimeQuote({
          ...context.entry,
          positionId: stored.id,
          expectedPositionVersion: stored.runtimeVersion,
          signalCandleAt: nextAt,
          indicatorState: nextState,
          processedPrice: {
            eventId: context.entry.entryPriceEventId,
            streamId: context.deployment.exchangeAccountId,
            throughAt: nextAt,
          },
          action: {
            kind: "close",
            settlement: {
              exitPrice: "103",
              grossPnl: "3",
              netPnl: "2.8782",
              fees: "0.1218",
              slippage: "0",
              exitReason: "signal-exit",
              closedAt: nextAt,
            },
          },
        });
        assert.equal(result.closed, true);
        const closed = await prisma.position.findUniqueOrThrow({ where: { id: stored.id } });
        assert.deepEqual(closed.indicatorState, nextState);
        assert.equal(+closed.signalCandleAt!, +nextAt);
      },
    );
    await t.test(
      "waiting decisions deduplicate across restart, retain signal ID and explain expiry",
      async () => {
        const context = await setup();
        const progress = {
          workspaceId: context.workspace.id,
          executionRunId: context.run.id,
          symbol: context.symbol,
          expectedCandleAt: candleAt,
          expectedPendingPriceEventId: null,
          throughEventId: null,
        };
        await Promise.all([
          runtime.advancePendingEntry({ ...progress, waitingReason: "ENTRY_LIMIT_NOT_TOUCHED" }),
          runtime.advancePendingEntry({ ...progress, waitingReason: "ENTRY_LIMIT_NOT_TOUCHED" }),
        ]);
        await new RuntimeRepository(prisma).advancePendingEntry({
          ...progress,
          waitingReason: "ENTRY_LIMIT_NOT_TOUCHED",
        });
        await runtime.advancePendingEntry({
          ...progress,
          throughEventId: context.entry.entryPriceEventId,
          waitingReason: "ENTRY_LIMIT_NOT_TOUCHED",
        });
        assert.equal(await prisma.decision.count({ where: { executionRunId: context.run.id } }), 1);
        assert.equal(
          await runtime.advancePendingEntry({ ...progress, waitingReason: "STALE_ENTRY_QUOTE" }),
          false,
        );
        const advanced = {
          ...progress,
          expectedPendingPriceEventId: context.entry.entryPriceEventId,
          throughEventId: context.entry.entryPriceEventId,
        };
        await runtime.advancePendingEntry({ ...advanced, waitingReason: "STALE_ENTRY_QUOTE" });
        await runtime.advancePendingEntry({
          ...advanced,
          waitingReason: "ENTRY_LIMIT_NOT_TOUCHED",
        });
        const rows = await prisma.decision.findMany({
          where: { executionRunId: context.run.id },
          orderBy: { createdAt: "asc" },
        });
        assert.deepEqual(
          rows.map((row) => row.reasonCode),
          ["ENTRY_LIMIT_NOT_TOUCHED", "STALE_ENTRY_QUOTE", "ENTRY_LIMIT_NOT_TOUCHED"],
        );
        const states = rows.map(
          (row) => (row.factors as { runtimeSignal: { id: string; status: string } }).runtimeSignal,
        );
        assert.ok(rows.every((row) => row.action === "HOLD"));
        assert.ok(
          states.every((state) => state.status === "PENDING" && state.id === states[0]!.id),
        );
        const where = {
          executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
        };
        const cursor = await prisma.runtimeCursor.findUniqueOrThrow({ where });
        await prisma.runtimeCursor.update({
          where,
          data: {
            pendingSignal: {
              ...(cursor.pendingSignal as object),
              expiresAt: new Date(Date.now() - 1).toISOString(),
            },
          },
        });
        assert.equal(await runtime.advancePendingEntry(advanced), true);
        assert.equal(await runtime.advancePendingEntry(advanced), false);
        const terminal = await prisma.decision.findFirstOrThrow({
          where: { executionRunId: context.run.id, action: "SKIP" },
        });
        assert.equal(terminal.reasonCode, "ENTRY_SIGNAL_EXPIRED");
        assert.equal(
          (terminal.factors as { lastWaitingReason: string }).lastWaitingReason,
          "ENTRY_LIMIT_NOT_TOUCHED",
        );
        assert.equal(
          (terminal.factors as { runtimeSignal: { id: string } }).runtimeSignal.id,
          states[0]!.id,
        );
      },
    );
    await t.test(
      "unavailable connection/instrument leaves events unread and expires without permitting execution",
      async () => {
        for (const reason of ["ENTRY_CONNECTION_UNAVAILABLE", "INSTRUMENT_UNAVAILABLE"] as const) {
          const context = await setup();
          if (reason === "ENTRY_CONNECTION_UNAVAILABLE")
            await prisma.exchangeConnection.update({
              where: { id: context.connection.id },
              data: { status: "INVALID" },
            });
          else
            await prisma.marketInstrument.update({
              where: { symbol: context.symbol },
              data: { enabled: false },
            });
          assert.equal((await runtime.listRealtimePendingEntries(context.workspace.id)).length, 1);
          assert.equal((await runtime.persistRealtimeEntry(context.entry)).waitingReason, reason);
          const progress = {
            workspaceId: context.workspace.id,
            executionRunId: context.run.id,
            symbol: context.symbol,
            expectedCandleAt: candleAt,
            expectedPendingPriceEventId: null,
            throughEventId: context.entry.entryPriceEventId,
            waitingReason: "ENTRY_LIMIT_NOT_TOUCHED" as const,
          };
          await runtime.advancePendingEntry(progress);
          await runtime.advancePendingEntry(progress);
          const where = {
            executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
          };
          const cursor = await prisma.runtimeCursor.findUniqueOrThrow({ where });
          assert.equal(cursor.pendingPriceEventId, null);
          assert.ok(cursor.pendingSignal);
          const rows = await prisma.decision.findMany({
            where: { executionRunId: context.run.id },
          });
          assert.equal(rows.length, 1);
          assert.equal(rows[0]!.reasonCode, reason);
          await prisma.runtimeCursor.update({
            where,
            data: {
              pendingSignal: {
                ...(cursor.pendingSignal as object),
                expiresAt: new Date(Date.now() - 1).toISOString(),
              },
            },
          });
          await runtime.advancePendingEntry(progress);
          assert.equal(
            (await prisma.runtimeCursor.findUniqueOrThrow({ where })).pendingSignal,
            null,
          );
          assert.equal(
            await prisma.decision.count({
              where: { executionRunId: context.run.id, reasonCode: "ENTRY_SIGNAL_EXPIRED" },
            }),
            1,
          );
          assert.equal(
            await prisma.position.count({ where: { executionRunId: context.run.id } }),
            0,
          );
        }
      },
    );
    await t.test(
      "market pending TTL cannot be extended by legacy expiry or spoofed order type",
      async () => {
        const context = await setup();
        const where = {
          executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
        };
        const cursor = await prisma.runtimeCursor.findUniqueOrThrow({ where });
        await prisma.runtimeCursor.update({
          where,
          data: {
            pendingSignal: {
              ...(cursor.pendingSignal as object),
              detectedAt: new Date(Date.now() - 120_000).toISOString(),
            },
          },
        });
        assert.equal(
          (await runtime.persistRealtimeEntry(context.entry)).riskFailure,
          "ENTRY_SIGNAL_EXPIRED",
        );
        assert.equal(
          (await runtime.persistRealtimeEntry({ ...context.entry, entryOrderType: "LIMIT" }))
            .riskFailure,
          "INVALID_ENTRY_ORDER_TYPE",
        );
        assert.equal(
          await runtime.advancePendingEntry({
            workspaceId: context.workspace.id,
            executionRunId: context.run.id,
            symbol: context.symbol,
            expectedCandleAt: candleAt,
            expectedPendingPriceEventId: null,
            throughEventId: null,
          }),
          true,
        );
        const decision = await prisma.decision.findFirstOrThrow({
          where: { executionRunId: context.run.id },
        });
        assert.equal(decision.reasonCode, "ENTRY_SIGNAL_EXPIRED");
        assert.equal(
          (decision.factors as { runtimeSignal: { status: string } }).runtimeSignal.status,
          "EXPIRED",
        );
        assert.equal(await prisma.position.count({ where: { executionRunId: context.run.id } }), 0);
      },
    );
    await t.test(
      "market TTL is rechecked after advisory lock wait with a longer stored expiry",
      async () => {
        const context = await setup();
        const detectedAt = new Date();
        const where = {
          executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
        };
        const cursor = await prisma.runtimeCursor.findUniqueOrThrow({ where });
        await prisma.runtimeCursor.update({
          where,
          data: {
            pendingSignal: {
              ...(cursor.pendingSignal as object),
              detectedAt: detectedAt.toISOString(),
              availableAt: detectedAt.toISOString(),
              expiresAt: new Date(+detectedAt + 900_000).toISOString(),
            },
          },
        });
        await prisma.marketPriceEvent.update({
          where: { id: context.entry.entryPriceEventId },
          data: { observedAt: detectedAt, receivedAt: detectedAt },
        });
        const limited = new RuntimeRepository(prisma, defaultRuntimeRiskPolicy, {
          ttlMs: 1000,
          maxDeviationBps: 50,
        });
        let unlock!: () => void;
        let ready!: () => void;
        const released = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        const locked = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const blocker = prisma.$transaction(async (tx) => {
          await tx.$executeRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${context.run.id}`}))`,
          );
          ready();
          await released;
        });
        await locked;
        const attempt = limited.persistRealtimeEntry({
          ...context.entry,
          quoteAt: detectedAt,
          position: { ...context.entry.position, openedAt: detectedAt },
        });
        try {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, +detectedAt + 1000 - Date.now()) + 100),
          );
        } finally {
          unlock();
        }
        await blocker;
        assert.equal((await attempt).riskFailure, "ENTRY_SIGNAL_EXPIRED");
        assert.equal(await prisma.position.count({ where: { executionRunId: context.run.id } }), 0);
      },
    );
    await t.test(
      "limit pending retains its candle deadline when market TTL has passed",
      async () => {
        const context = await setup();
        await prisma.strategyVersion.update({
          where: { id: context.entry.strategyVersionId },
          data: {
            config: { ...fixture.config, entry: { ...fixture.config.entry, orderType: "limit" } },
          },
        });
        const where = {
          executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
        };
        const cursor = await prisma.runtimeCursor.findUniqueOrThrow({ where });
        await prisma.runtimeCursor.update({
          where,
          data: {
            pendingSignal: {
              ...(cursor.pendingSignal as object),
              detectedAt: new Date(Date.now() - 120_000).toISOString(),
            },
          },
        });
        assert.equal(
          (await runtime.persistRealtimeEntry({ ...context.entry, entryOrderType: "LIMIT" }))
            .applied,
          true,
        );
      },
    );
    await t.test(
      "market pending deviation uses saved signal and durable event instead of caller quote",
      async () => {
        for (const price of ["99", "101"]) {
          const context = await setup();
          await prisma.marketPriceEvent.update({
            where: { id: context.entry.entryPriceEventId },
            data: { price },
          });
          const result = await runtime.persistRealtimeEntry({
            ...context.entry,
            quotePrice: "100",
            factors: { signalPrice: Number(price) },
          });
          assert.equal(result.riskFailure, "ENTRY_PRICE_DEVIATION");
          await runtime.advancePendingEntry({
            workspaceId: context.workspace.id,
            executionRunId: context.run.id,
            symbol: context.symbol,
            expectedCandleAt: candleAt,
            expectedPendingPriceEventId: null,
            throughEventId: context.entry.entryPriceEventId,
            rejectionReason: result.riskFailure,
          });
          const decision = await prisma.decision.findFirstOrThrow({
            where: { executionRunId: context.run.id },
          });
          assert.equal(decision.reasonCode, "ENTRY_PRICE_DEVIATION");
          assert.equal(
            (decision.factors as { runtimeSignal: { status: string } }).runtimeSignal.status,
            "REJECTED",
          );
          assert.equal(
            await prisma.position.count({ where: { executionRunId: context.run.id } }),
            0,
          );
        }
      },
    );
    await t.test(
      "candle market entry rejects downtime signals and execution price deviation",
      async () => {
        for (const reason of ["ENTRY_SIGNAL_EXPIRED", "ENTRY_PRICE_DEVIATION"]) {
          const context = await setup();
          if (reason === "ENTRY_PRICE_DEVIATION")
            await prisma.marketPriceEvent.update({
              where: { id: context.entry.entryPriceEventId },
              data: { price: "101" },
            });
          const cycle: PersistRuntimeCycleInput = {
            ...context.entry,
            ...decisionEngineFields(context),
            entrySignalPrice: 100,
            interval: "15",
            candleAt: new Date(
              +quoteAt - 900_000 - (reason === "ENTRY_SIGNAL_EXPIRED" ? 120_000 : 0),
            ),
            expectedDeploymentStatus: "RUNNING",
            expectedPositionId: null,
            expectedPositionVersion: null,
            pendingSignal: null,
            decision: {
              action: "OPEN",
              reasonCode: "ENTRY_SIGNAL_FILLED_REALTIME",
              summary: "Entry",
              factors: {},
            },
            positionAction: {
              kind: "open",
              position: context.entry.position,
              markPrice: "100",
              unrealizedPnl: "0",
              immediateSettlement: null,
            },
          };
          assert.equal((await runtime.persistCycle(cycle)).applied, true);
          const decision = await prisma.decision.findFirstOrThrow({
            where: { executionRunId: context.run.id, contextSnapshotId: { not: null } },
          });
          assert.equal(decision.reasonCode, reason);
          assert.equal(decision.action, "SKIP");
          assert.equal(
            (decision.factors as { runtimeSignal: { status: string } }).runtimeSignal.status,
            reason === "ENTRY_SIGNAL_EXPIRED" ? "EXPIRED" : "REJECTED",
          );
          assert.equal(
            await prisma.position.count({ where: { executionRunId: context.run.id } }),
            0,
          );
        }
      },
    );
    await t.test(
      "market pending creation caps expiry and rejects expired signals after context waits",
      async () => {
        for (const age of [0, 120_000]) {
          const context = await setup();
          const clock = await prisma.$queryRaw<
            Array<{ now: Date }>
          >`SELECT clock_timestamp() AS now`;
          const detectedAt = new Date(+clock[0]!.now - age);
          await runtime.persistCycle({
            ...context.entry,
            ...decisionEngineFields(context),
            interval: "15",
            candleAt: new Date(+detectedAt - 900_000),
            expectedDeploymentStatus: "RUNNING",
            expectedPositionId: null,
            expectedPositionVersion: null,
            pendingSignal: {
              mode: "realtime",
              side: "long",
              signalPrice: 100,
              detectedAt: detectedAt.toISOString(),
              availableAt: detectedAt.toISOString(),
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              entryRegime: "neutral",
            },
            decision: {
              action: "HOLD",
              reasonCode: "ENTRY_SIGNAL_PENDING",
              summary: "Pending",
              factors: {},
            },
            positionAction: { kind: "none" },
          });
          const cursor = await prisma.runtimeCursor.findUniqueOrThrow({
            where: {
              executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
            },
          });
          if (age === 0)
            assert.equal(
              Date.parse((cursor.pendingSignal as { expiresAt: string }).expiresAt),
              +detectedAt + 60_000,
            );
          else {
            assert.equal(cursor.pendingSignal, null);
            const decision = await prisma.decision.findFirstOrThrow({
              where: { executionRunId: context.run.id, contextSnapshotId: { not: null } },
            });
            assert.equal(decision.reasonCode, "ENTRY_SIGNAL_EXPIRED");
          }
        }
      },
    );
    await t.test(
      "new candle terminates expired or superseded pending with its old signal identity",
      async () => {
        for (const expired of [false, true])
          for (const replacement of [false, true]) {
            const context = await setup();
            const progress = {
              workspaceId: context.workspace.id,
              executionRunId: context.run.id,
              symbol: context.symbol,
              expectedCandleAt: candleAt,
              expectedPendingPriceEventId: null,
              throughEventId: null,
              waitingReason: "ENTRY_QUOTE_MISSING" as const,
            };
            await runtime.advancePendingEntry(progress);
            const where = {
              executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
            };
            const cursor = await prisma.runtimeCursor.findUniqueOrThrow({ where });
            if (expired)
              await prisma.runtimeCursor.update({
                where,
                data: {
                  pendingSignal: {
                    ...(cursor.pendingSignal as object),
                    detectedAt: new Date(+quoteAt - 120000).toISOString(),
                    expiresAt: new Date(+quoteAt - 1).toISOString(),
                  },
                },
              });
            const nextAt = new Date(+quoteAt - 900000);
            const fields = decisionEngineFields(context);
            const pending = {
              mode: "realtime",
              side: "long",
              signalPrice: 100,
              detectedAt: quoteAt.toISOString(),
              availableAt: quoteAt.toISOString(),
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              entryRegime: "neutral",
            };
            const cycle: PersistRuntimeCycleInput = {
              ...context.entry,
              ...fields,
              interval: "15",
              candleAt: nextAt,
              expectedLastEvaluatedAt: candleAt,
              expectedDeploymentStatus: "RUNNING",
              expectedPositionId: null,
              expectedPositionVersion: null,
              pendingSignal: replacement ? pending : null,
              candidate: replacement
                ? fields.candidate
                : { ...fields.candidate, side: null, action: "HOLD" },
              decision: {
                action: "HOLD",
                reasonCode: replacement ? "ENTRY_SIGNAL_PENDING" : "NO_SIGNAL",
                summary: "Next candle",
                factors: {},
              },
              positionAction: { kind: "none" },
            };
            assert.equal((await runtime.persistCycle(cycle)).applied, true);
            assert.equal((await runtime.persistCycle(cycle)).applied, false);
            const terminal = await prisma.decision.findMany({
              where: {
                executionRunId: context.run.id,
                correlationId: `runtime-pending:${context.run.id}:${context.symbol}:${candleAt.toISOString()}:terminal`,
              },
            });
            assert.equal(terminal.length, 1);
            const factors = terminal[0]!.factors as {
              lastWaitingReason: string;
              runtimeSignal: { id: string; status: string };
              replacementCandleAt: string;
            };
            assert.equal(
              terminal[0]!.reasonCode,
              expired ? "ENTRY_SIGNAL_EXPIRED" : "ENTRY_SIGNAL_SUPERSEDED",
            );
            assert.equal(
              factors.runtimeSignal.id,
              `runtime-signal:${context.run.id}:${context.symbol}:${candleAt.toISOString()}`,
            );
            assert.equal(factors.runtimeSignal.status, expired ? "EXPIRED" : "REJECTED");
            assert.equal(factors.lastWaitingReason, "ENTRY_QUOTE_MISSING");
            assert.equal(factors.replacementCandleAt, nextAt.toISOString());
            const updated = await prisma.runtimeCursor.findUniqueOrThrow({ where });
            assert.equal(+updated.lastEvaluatedAt!, +nextAt);
            if (replacement)
              assert.equal(
                (updated.pendingSignal as { signalId: string }).signalId,
                `runtime-signal:${context.run.id}:${context.symbol}:${nextAt.toISOString()}`,
              );
            else assert.equal(updated.pendingSignal, null);
          }
      },
    );
    await t.test(
      "new candle and pending expiry race creates one terminal and preserves the replacement",
      async () => {
        for (const candleFirst of [false, true]) {
          const context = await setup();
          const where = {
            executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
          };
          const cursor = await prisma.runtimeCursor.findUniqueOrThrow({ where });
          await prisma.runtimeCursor.update({
            where,
            data: {
              pendingSignal: {
                ...(cursor.pendingSignal as object),
                detectedAt: new Date(+quoteAt - 120000).toISOString(),
                expiresAt: new Date(+quoteAt - 1).toISOString(),
              },
            },
          });
          const nextAt = new Date(+quoteAt - 900000);
          const cycle: PersistRuntimeCycleInput = {
            ...context.entry,
            ...decisionEngineFields(context),
            interval: "15",
            candleAt: nextAt,
            expectedLastEvaluatedAt: candleAt,
            expectedDeploymentStatus: "RUNNING",
            expectedPositionId: null,
            expectedPositionVersion: null,
            pendingSignal: {
              mode: "realtime",
              side: "long",
              signalPrice: 100,
              detectedAt: quoteAt.toISOString(),
              availableAt: quoteAt.toISOString(),
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              entryRegime: "neutral",
            },
            decision: {
              action: "HOLD",
              reasonCode: "ENTRY_SIGNAL_PENDING",
              summary: "Next",
              factors: {},
            },
            positionAction: { kind: "none" },
          };
          const expire = () =>
            runtime.advancePendingEntry({
              workspaceId: context.workspace.id,
              executionRunId: context.run.id,
              symbol: context.symbol,
              expectedCandleAt: candleAt,
              expectedPendingPriceEventId: null,
              throughEventId: null,
            });
          await Promise.all(
            candleFirst
              ? [runtime.persistCycle(cycle), expire()]
              : [expire(), runtime.persistCycle(cycle)],
          );
          assert.equal(
            await prisma.decision.count({
              where: { executionRunId: context.run.id, reasonCode: "ENTRY_SIGNAL_EXPIRED" },
            }),
            1,
          );
          const updated = await prisma.runtimeCursor.findUniqueOrThrow({ where });
          assert.equal(
            (updated.pendingSignal as { signalId: string }).signalId,
            `runtime-signal:${context.run.id}:${context.symbol}:${nextAt.toISOString()}`,
          );
        }
      },
    );
    await t.test("failed new candle transaction rolls back old signal finalization", async () => {
      const context = await setup();
      const fields = decisionEngineFields(context);
      await assert.rejects(
        runtime.persistCycle({
          ...context.entry,
          ...fields,
          contextSnapshot: { ...fields.contextSnapshot, strategyVersionId: randomUUID() },
          interval: "15",
          candleAt: new Date(+quoteAt - 900000),
          expectedLastEvaluatedAt: candleAt,
          expectedDeploymentStatus: "RUNNING",
          expectedPositionId: null,
          expectedPositionVersion: null,
          pendingSignal: null,
          decision: { action: "HOLD", reasonCode: "NO_SIGNAL", summary: "Next", factors: {} },
          positionAction: { kind: "none" },
        }),
      );
      assert.equal(await prisma.decision.count({ where: { executionRunId: context.run.id } }), 0);
      const cursor = await prisma.runtimeCursor.findUniqueOrThrow({
        where: {
          executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
        },
      });
      assert.equal(+cursor.lastEvaluatedAt!, +candleAt);
      assert.ok(cursor.pendingSignal);
    });
    await t.test(
      "one stable signal identity links observation, pending and fill across retries",
      async () => {
        const context = await setup();
        const signalAt = new Date(+quoteAt - 900000);
        const pendingSignal = {
          mode: "realtime",
          side: "long",
          signalPrice: 100,
          detectedAt: quoteAt.toISOString(),
          availableAt: quoteAt.toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          entryRegime: "neutral",
          signalId: "untrusted-id",
        };
        const cycle: PersistRuntimeCycleInput = {
          ...context.entry,
          ...decisionEngineFields(context),
          interval: "15",
          candleAt: signalAt,
          expectedDeploymentStatus: "RUNNING",
          expectedPositionId: null,
          expectedPositionVersion: null,
          pendingSignal,
          decision: {
            action: "HOLD",
            reasonCode: "ENTRY_SIGNAL_PENDING",
            summary: "Pending",
            factors: { retained: true },
          },
          positionAction: { kind: "none" },
        };
        assert.equal((await runtime.persistCycle(cycle)).applied, true);
        assert.equal((await runtime.persistCycle(cycle)).applied, false);
        const signalId = `runtime-signal:${context.run.id}:${context.symbol}:${signalAt.toISOString()}`;
        const cursor = await prisma.runtimeCursor.findUniqueOrThrow({
          where: {
            executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
          },
        });
        assert.equal((cursor.pendingSignal as { signalId: string }).signalId, signalId);
        const observed = await prisma.auditEvent.findMany({
          where: { resourceId: signalId, action: "runtime.signal.observed" },
        });
        assert.equal(observed.length, 1);
        assert.equal((observed[0]!.metadata as { status: string }).status, "SIGNAL");
        assert.equal(
          (await runtime.persistRealtimeEntry({ ...context.entry, expectedCandleAt: signalAt }))
            .applied,
          true,
        );
        const decisions = await prisma.decision.findMany({
          where: {
            executionRunId: context.run.id,
            factors: { path: ["runtimeSignal", "id"], equals: signalId },
          },
          orderBy: { createdAt: "asc" },
        });
        assert.equal(decisions.length, 2);
        const states = decisions.map(
          (decision) =>
            (decision.factors as { runtimeSignal: { id: string; status: string } }).runtimeSignal,
        );
        assert.deepEqual(
          states.map((state) => state.id),
          [signalId, signalId],
        );
        assert.deepEqual(
          states.map((state) => state.status),
          ["PENDING", "FILLED"],
        );
        assert.deepEqual(
          decisions.map((decision) => decision.action),
          ["HOLD", "OPEN"],
        );
        assert.equal((decisions[0]!.factors as { retained: boolean }).retained, true);
      },
    );
    await t.test(
      "pending finality and direction are verified from stored signal, not trusted caller arguments",
      async () => {
        const context = await setup();
        const where = {
          executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
        };
        const cursor = await prisma.runtimeCursor.findUniqueOrThrow({ where });
        await prisma.runtimeCursor.update({
          where,
          data: {
            pendingSignal: {
              ...(cursor.pendingSignal as object),
              availableAt: new Date(+quoteAt + 60000).toISOString(),
            },
          },
        });
        assert.equal(
          (await runtime.persistRealtimeEntry(context.entry)).riskFailure,
          "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY",
        );
        await prisma.runtimeCursor.update({
          where,
          data: { pendingSignal: { ...(cursor.pendingSignal as object), availableAt: null } },
        });
        assert.equal(
          (await runtime.persistRealtimeEntry(context.entry)).riskFailure,
          "INVALID_PENDING_SIGNAL",
        );
        await prisma.runtimeCursor.update({
          where,
          data: { pendingSignal: { ...(cursor.pendingSignal as object), side: "short" } },
        });
        assert.equal(
          (await runtime.persistRealtimeEntry(context.entry)).riskFailure,
          "INVALID_PENDING_SIGNAL",
        );
        assert.equal(
          await runtime.advancePendingEntry({
            workspaceId: context.workspace.id,
            executionRunId: context.run.id,
            symbol: context.symbol,
            expectedCandleAt: candleAt,
            expectedPendingPriceEventId: null,
            throughEventId: null,
            rejectionReason: "INVALID_PENDING_SIGNAL",
          }),
          true,
        );
        assert.equal(
          (await prisma.decision.findFirstOrThrow({ where: { executionRunId: context.run.id } }))
            .reasonCode,
          "INVALID_PENDING_SIGNAL",
        );
        assert.equal(await prisma.position.count({ where: { executionRunId: context.run.id } }), 0);
      },
    );
    await t.test(
      "pending price progress survives restart and stale batches cannot fill an already consumed event",
      async () => {
        const context = await setup();
        const progress = {
          workspaceId: context.workspace.id,
          executionRunId: context.run.id,
          symbol: context.symbol,
          expectedCandleAt: candleAt,
          expectedPendingPriceEventId: null,
          throughEventId: context.entry.entryPriceEventId,
        };
        assert.equal(await runtime.advancePendingEntry(progress), true);
        assert.equal(await runtime.advancePendingEntry(progress), false);
        assert.equal(
          (
            await runtime.persistRealtimeEntry({
              ...context.entry,
              expectedPendingPriceEventId: null,
            })
          ).applied,
          false,
        );
        const listed = await runtime.listRealtimePendingEntries(context.workspace.id);
        assert.equal(listed[0]!.pendingPriceEventId, context.entry.entryPriceEventId);
        const next = await prisma.marketPriceEvent.create({
          data: {
            symbol: context.symbol,
            eventKey: randomUUID(),
            streamId: context.deployment.exchangeAccountId,
            price: "100",
            observedAt: new Date(),
          },
        });
        const entry = {
          ...context.entry,
          entryPriceEventId: next.id,
          expectedPendingPriceEventId: context.entry.entryPriceEventId,
          quoteAt: next.observedAt,
          position: { ...context.entry.position, openedAt: next.observedAt },
        };
        assert.equal((await runtime.persistRealtimeEntry(entry)).applied, true);
        assert.equal((await runtime.persistRealtimeEntry(entry)).applied, false);
        assert.equal(await prisma.position.count({ where: { executionRunId: context.run.id } }), 1);
        assert.equal(await prisma.order.count({ where: { executionRunId: context.run.id } }), 1);
      },
    );
    await t.test(
      "TTL is checked after a transaction lock wait; expiry is recorded exactly once",
      async () => {
        const context = await setup();
        const expiresAt = new Date(Date.now() + 500);
        const where = {
          executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
        };
        const cursor = await prisma.runtimeCursor.findUniqueOrThrow({ where });
        await prisma.runtimeCursor.update({
          where,
          data: {
            pendingSignal: {
              ...(cursor.pendingSignal as object),
              expiresAt: expiresAt.toISOString(),
            },
          },
        });
        let acquired!: () => void, release!: () => void;
        const locked = new Promise<void>((resolve) => {
          acquired = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const blocker = prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${context.run.id}`}))`;
          acquired();
          await released;
        });
        await locked;
        const attempt = runtime.persistRealtimeEntry(context.entry);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, +expiresAt - Date.now()) + 100),
        );
        release();
        await blocker;
        const result = await attempt;
        assert.equal(result.applied, false);
        assert.equal(result.riskFailure, "ENTRY_SIGNAL_EXPIRED");
        const progress = {
          workspaceId: context.workspace.id,
          executionRunId: context.run.id,
          symbol: context.symbol,
          expectedCandleAt: candleAt,
          expectedPendingPriceEventId: null,
          throughEventId: null,
        };
        assert.equal(await runtime.advancePendingEntry(progress), true);
        assert.equal(await runtime.advancePendingEntry(progress), false);
        assert.equal(await prisma.position.count({ where: { executionRunId: context.run.id } }), 0);
        const decisions = await prisma.decision.findMany({
          where: { executionRunId: context.run.id },
        });
        assert.equal(decisions.length, 1);
        assert.equal(decisions[0]!.reasonCode, "ENTRY_SIGNAL_EXPIRED");
        assert.equal(
          (decisions[0]!.factors as { runtimeSignal: { status: string } }).runtimeSignal.status,
          "EXPIRED",
        );
        assert.equal((await prisma.runtimeCursor.findUniqueOrThrow({ where })).pendingSignal, null);
      },
    );
    await t.test(
      "pause/resume cannot fill an expired pending signal; risk rejection has a durable reason",
      async () => {
        const context = await setup();
        const progress = {
          workspaceId: context.workspace.id,
          executionRunId: context.run.id,
          symbol: context.symbol,
          expectedCandleAt: candleAt,
          expectedPendingPriceEventId: null,
          throughEventId: null,
          rejectionReason: "KILL_SWITCH",
        };
        await prisma.deployment.update({
          where: { id: context.deployment.id },
          data: { status: "PAUSED" },
        });
        assert.equal(await runtime.advancePendingEntry(progress), false);
        assert.equal((await runtime.persistRealtimeEntry(context.entry)).applied, false);
        await prisma.deployment.update({
          where: { id: context.deployment.id },
          data: { status: "RUNNING" },
        });
        assert.equal(await runtime.advancePendingEntry(progress), true);
        assert.equal((await runtime.persistRealtimeEntry(context.entry)).applied, false);
        assert.equal(
          (await prisma.decision.findFirstOrThrow({ where: { executionRunId: context.run.id } }))
            .reasonCode,
          "KILL_SWITCH",
        );
        const expired = await setup();
        const where = {
          executionRunId_symbol: { executionRunId: expired.run.id, symbol: expired.symbol },
        };
        const cursor = await prisma.runtimeCursor.findUniqueOrThrow({ where });
        await prisma.runtimeCursor.update({
          where,
          data: {
            pendingSignal: {
              ...(cursor.pendingSignal as object),
              expiresAt: new Date(Date.now() - 1).toISOString(),
            },
          },
        });
        assert.equal(
          (await runtime.persistRealtimeEntry(expired.entry)).riskFailure,
          "ENTRY_SIGNAL_EXPIRED",
        );
      },
    );
    await t.test(
      "signal progress is atomic with price progress and survives stale writes",
      async () => {
        const context = await open();
        assert.equal(+context.position.signalCandleAt!, +context.entry.expectedCandleAt);
        const signalCandleAt = new Date(+context.entry.expectedCandleAt + 900000);
        const config = strategyConfigSchema.parse(fixture.config);
        const source = fixture.candles.map((candle, index) => ({
          ...candle,
          symbol: context.symbol,
          openTime: new Date(+signalCandleAt - (fixture.candles.length - 1 - index) * 900000),
        }));
        const indicatorState = advanceExecutionIndicators(source, config).checkpoint!;
        const update = { ...context.quote, signalCandleAt, indicatorState };
        assert.equal((await runtime.persistRealtimeQuote(update)).applied, true);
        assert.equal(
          (
            await runtime.persistRealtimeQuote({
              ...update,
              signalCandleAt: context.entry.expectedCandleAt,
              indicatorState: { stale: true },
            })
          ).applied,
          false,
        );
        const stored = await prisma.position.findUniqueOrThrow({
          where: { id: context.position.id },
        });
        assert.equal(+stored.signalCandleAt!, +signalCandleAt);
        assert.equal(stored.priceEventId, update.processedPrice.eventId);
        assert.deepEqual(stored.indicatorState, indicatorState);
        const listed = await runtime.listRealtimePositions(context.workspace.id);
        assert.equal(+listed[0]!.signalCandleAt!, +signalCandleAt);
        assert.deepEqual(listed[0]!.indicatorState, indicatorState);
      },
    );
    await t.test(
      "signal, risk and manual close races leave one trade and one exit fill",
      async () => {
        const context = await open();
        const settlement = {
          exitPrice: "103",
          grossPnl: "3",
          netPnl: "2.8782",
          fees: "0.1218",
          slippage: "0",
          exitReason: "signal-exit",
          closedAt: context.quote.quoteAt,
        };
        const decidedAt = new Date();
        const signal = {
          ...context.quote,
          decidedAt,
          signalCandleAt: candleAt,
          action: { kind: "close" as const, settlement },
        };
        const results = await Promise.allSettled([
          runtime.persistRealtimeQuote(signal),
          runtime.persistRealtimeQuote({
            ...signal,
            action: {
              kind: "close",
              settlement: { ...settlement, exitReason: "daily-loss-limit" },
            },
          }),
          runtime.closeManually({
            workspaceId: context.workspace.id,
            positionId: context.position.id,
            executionRunId: context.run.id,
            actorId: "test",
            requestId: randomUUID(),
            idempotencyKey: randomUUID(),
            reason: "Test close",
            quoteObservedAt: context.quote.quoteAt,
            maximumQuoteAgeMs: 60000,
            settlement: { ...settlement, exitReason: "manual-close" },
          }),
        ]);
        assert.ok(results.some((result) => result.status === "fulfilled"));
        assert.equal(await prisma.trade.count({ where: { positionId: context.position.id } }), 1);
        assert.equal(await prisma.order.count({ where: { positionId: context.position.id } }), 2);
        assert.equal(
          await prisma.fill.count({ where: { order: { positionId: context.position.id } } }),
          2,
        );
        assert.equal(
          await prisma.decision.count({
            where: { positionId: context.position.id, action: "CLOSE" },
          }),
          1,
        );
      },
    );
    await t.test(
      "closing a journal batch persists its final protection and progress atomically",
      async () => {
        const context = await open();
        const input: PersistRuntimeQuoteInput = {
          ...context.quote,
          action: {
            kind: "close",
            protection: { bestPrice: "104", stopPrice: "100.12", trailingPrice: "102.5" },
            settlement: {
              exitPrice: "102",
              grossPnl: "2",
              netPnl: "1.8788",
              fees: "0.1212",
              slippage: "0",
              exitReason: "trailing-stop",
              closedAt: context.quote.quoteAt,
            },
          },
        };
        assert.deepEqual(await runtime.persistRealtimeQuote(input), {
          applied: true,
          closed: true,
        });
        const stored = await prisma.position.findUniqueOrThrow({
          where: { id: context.position.id },
          include: { trade: true },
        });
        assert.equal(stored.status, "CLOSED");
        assert.equal(stored.stopPrice.toFixed(), "100.12");
        assert.equal(stored.trailingPrice!.toFixed(), "102.5");
        assert.equal(stored.bestPrice.toFixed(), "104");
        assert.equal(stored.priceEventId, input.processedPrice.eventId);
        assert.equal(stored.priceStreamId, input.processedPrice.streamId);
        assert.equal(+stored.managedThroughAt!, +input.processedPrice.throughAt);
        assert.equal(stored.runtimeVersion, context.position.runtimeVersion + 1);
        assert.equal(stored.trade!.netPnl.toFixed(), "1.8788");
        assert.deepEqual(await runtime.persistRealtimeQuote(input), {
          applied: false,
          closed: false,
        });
        assert.equal(await prisma.trade.count({ where: { positionId: stored.id } }), 1);
      },
    );

    await t.test("quote protection is durable; stale updates cannot loosen it", async () => {
      const context = await open();
      assert.equal((await runtime.persistRealtimeQuote(context.quote)).applied, true);
      const stored = await prisma.position.findUniqueOrThrow({
        where: { id: context.position.id },
      });
      assert.equal(stored.priceEventId, context.quote.processedPrice.eventId);
      assert.equal(
        stored.managedThroughAt?.getTime(),
        context.quote.processedPrice.throughAt.getTime(),
      );
      assert.deepEqual(
        await new PriceEventRepository(prisma).after(
          context.symbol,
          stored.priceEventId,
          stored.openedAt,
        ),
        [],
      );
      assert.equal(stored.stopPrice.toNumber(), 100.12);
      assert.equal(stored.trailingPrice?.toNumber(), 102);
      assert.equal(
        (
          await runtime.persistRealtimeQuote({
            ...context.quote,
            action: {
              kind: "update",
              markPrice: "100",
              unrealizedPnl: "0",
              bestPrice: "100",
              stopPrice: "98",
              trailingPrice: null,
            },
          })
        ).applied,
        false,
      );
      const staleCycle: PersistRuntimeCycleInput = {
        ...context.entry,
        ...decisionEngineFields(context),
        interval: "15",
        candleAt: quoteAt,
        expectedDeploymentStatus: "RUNNING",
        expectedPositionId: context.position.id,
        expectedPositionVersion: context.position.runtimeVersion,
        pendingSignal: null,
        decision: { action: "HOLD", reasonCode: "TEST", summary: "Test", factors: {} },
        positionAction: {
          kind: "update",
          positionId: context.position.id,
          markPrice: "100",
          unrealizedPnl: "0",
          bestPrice: "100",
          stopPrice: "98",
          trailingPrice: null,
        },
      };
      await assert.rejects(runtime.persistCycle(staleCycle), RuntimeStateConflictError);
    });
    await t.test(
      "paused deployment still manages exits and deduplicates concurrent close",
      async () => {
        const context = await open();
        await prisma.deployment.update({
          where: { id: context.deployment.id },
          data: { status: "PAUSED" },
        });
        const close: PersistRuntimeQuoteInput = {
          ...context.quote,
          action: {
            kind: "close",
            settlement: {
              exitPrice: "98",
              grossPnl: "-2",
              netPnl: "-2.1188",
              fees: "0.1188",
              slippage: "0",
              exitReason: "stop-loss",
              closedAt: context.quote.quoteAt,
            },
          },
        };
        const results = await Promise.all([
          runtime.persistRealtimeQuote(close),
          runtime.persistRealtimeQuote(close),
        ]);
        assert.equal(results.filter((result) => result.closed).length, 1);
        assert.equal(await prisma.trade.count({ where: { executionRunId: context.run.id } }), 1);
        assert.equal(await prisma.order.count({ where: { executionRunId: context.run.id } }), 2);
      },
    );
    await t.test("equity and account snapshot include fees of open positions", async () => {
      const context = await open();
      const equity = await runtime.getDryRunEquity(
        context.workspace.id,
        context.deployment.exchangeAccountId,
        "10000",
      );
      assert.equal(equity, 9999.94);
      const snapshot = await snapshots.captureDryRunSnapshot({
        workspaceId: context.workspace.id,
        exchangeAccountId: context.deployment.exchangeAccountId,
        initialBalance: "10000",
      });
      assert.equal(snapshot.equity.toNumber(), equity);
    });
    await t.test(
      "journal has one writer and idempotent replay across repository restarts",
      async () => {
        const journal = new PriceEventRepository(prisma);
        const owner = randomUUID();
        await prisma.marketStreamLease.deleteMany();
        assert.equal(await journal.claimWriter(owner), true);
        assert.equal(await journal.claimWriter("other"), false);
        const events = [97, 100].map((price) => ({
          eventKey: randomUUID(),
          symbol: owner,
          price: String(price),
          observedAt: quoteAt,
          streamId: owner,
          receivedAt: new Date(+quoteAt + 100),
          executionData: [
            1,
            "0.123456789012345678",
            "Buy",
            false,
            null,
            ["96", "1", "101", "2", +quoteAt, +quoteAt, "1", "2"],
          ] as StoredExecutionMarketData,
        }));
        const first = await journal.append(events, owner);
        const restarted = new PriceEventRepository(prisma);
        assert.deepEqual(
          (await restarted.append(events, owner)).map((row) => row.id),
          first.map((row) => row.id),
        );
        const original = first[0]!;
        const repeated = await restarted.append(
          [
            {
              ...events[0]!,
              streamId: "reconnected",
              receivedAt: new Date(+quoteAt + 500),
              executionData: [1, "0.123456789012345678", "Buy", false, null, null],
            },
          ],
          owner,
        );
        assert.deepEqual(repeated[0]!.executionData, original.executionData);
        assert.equal(+repeated[0]!.receivedAt, +original.receivedAt);
        const unique = { ...events[1]!, eventKey: randomUUID() };
        await assert.rejects(
          restarted.append([unique, { ...events[0]!, price: "98" }], owner),
          /Conflicting duplicate/,
        );
        assert.equal(
          await prisma.marketPriceEvent.count({ where: { eventKey: unique.eventKey } }),
          0,
        );
        await assert.rejects(
          restarted.append(
            [{ ...events[0]!, executionData: [1, "1", "Buy", false, null, null] }],
            owner,
          ),
          /Conflicting duplicate/,
        );
        const noncausal = structuredClone(events[0]!.executionData);
        noncausal[5]![4] = +quoteAt + 1;
        await assert.rejects(
          restarted.append([{ ...unique, executionData: noncausal }], owner),
          /causal/,
        );
        assert.deepEqual(
          (await restarted.after(owner, first[0]!.id, quoteAt)).map((row) => Number(row.price)),
          [100],
        );
        await assert.rejects(journal.append(events, "other"), /lease lost/);
      },
    );
    async function realizedTrade(
      context: Awaited<ReturnType<typeof setup>>,
      closedAt: Date,
      netPnl: number,
    ) {
      const position = await prisma.position.create({
        data: {
          ...context.entry.position,
          workspaceId: context.workspace.id,
          executionRunId: context.run.id,
          strategyVersionId: context.entry.strategyVersionId,
          environment: "DRY_RUN",
          status: "CLOSED",
          closedAt,
        },
      });
      return prisma.trade.create({
        data: {
          workspaceId: context.workspace.id,
          executionRunId: context.run.id,
          strategyVersionId: context.entry.strategyVersionId,
          positionId: position.id,
          symbol: context.symbol,
          environment: "DRY_RUN",
          side: "BUY",
          quantity: "1",
          averageEntryPrice: "100",
          averageExitPrice: "100",
          grossPnl: String(netPnl),
          netPnl: String(netPnl),
          exitReason: "test",
          openedAt: new Date(+closedAt - 60_000),
          closedAt,
        },
      });
    }
    async function assessAt(
      context: Awaited<ReturnType<typeof setup>>,
      now: Date,
      timezone: string,
    ) {
      return prisma.$transaction((tx) =>
        assessRuntimeRisk(tx, {
          workspaceId: context.workspace.id,
          exchangeAccountId: context.deployment.exchangeAccountId,
          strategyConfig: { ...fixture.config, schedule: { ...fixture.config.schedule, timezone } },
          policy: defaultRuntimeRiskPolicy,
          now,
        }),
      );
    }
    await t.test(
      "calendar risk agrees with execution dates at UTC/local midnight and DST",
      async () => {
        const context = await setup();
        const cases = [
          ["UTC", "2026-10-04T23:59:59.999Z", "2026-10-04T00:00:00.000Z"],
          ["UTC", "2026-10-05T00:00:00.000Z", "2026-10-05T00:00:00.000Z"],
          ["Asia/Novosibirsk", "2026-10-04T16:59:59.999Z", "2026-10-03T17:00:00.000Z"],
          ["Asia/Novosibirsk", "2026-10-04T17:00:00.000Z", "2026-10-04T17:00:00.000Z"],
          ["Europe/Berlin", "2026-03-29T12:00:00.000Z", "2026-03-28T23:00:00.000Z"],
          ["Europe/Berlin", "2026-03-30T00:00:00.000Z", "2026-03-29T22:00:00.000Z"],
          ["Europe/Berlin", "2026-10-25T12:00:00.000Z", "2026-10-24T22:00:00.000Z"],
          ["Europe/Berlin", "2026-10-26T00:00:00.000Z", "2026-10-25T23:00:00.000Z"],
        ];
        for (const [timezone, time, start] of cases) {
          const now = new Date(time!);
          const risk = await assessAt(context, now, timezone!);
          assert.equal(risk.strategyDay.day, getTradingDateKey(now, timezone!));
          assert.equal(risk.strategyDay.startsAt.toISOString(), start);
        }
        const boundary = new Date("2026-10-04T17:00:00Z");
        await realizedTrade(context, new Date(+boundary - 1), -10);
        await realizedTrade(context, boundary, -20);
        await realizedTrade(context, new Date(+boundary + 1), -30);
        assert.equal(
          (await assessAt(context, new Date(+boundary - 1), "Asia/Novosibirsk")).strategyDay
            .realizedPnl,
          -10,
        );
        assert.equal(
          (await assessAt(context, boundary, "Asia/Novosibirsk")).strategyDay.realizedPnl,
          -20,
        );
        assert.equal(
          (await assessAt(context, new Date(+boundary + 1), "Asia/Novosibirsk")).strategyDay
            .realizedPnl,
          -50,
        );
      },
    );
    await t.test(
      "both entry transactions enforce the same account calendar loss gate",
      async () => {
        const context = await setup();
        const config = {
          ...fixture.config,
          schedule: { ...fixture.config.schedule, timezone: "Asia/Novosibirsk" },
          risk: { ...fixture.config.risk, maxDailyLossPercent: 1 },
        };
        await prisma.strategyVersion.update({
          where: { id: context.entry.strategyVersionId },
          data: { config },
        });
        const guard = new RuntimeRiskRepository(prisma);
        const initial = await guard.assess(
          context.workspace.id,
          context.deployment.exchangeAccountId,
          config,
        );
        const utcStart = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
        const localStart = initial.strategyDay.startsAt;
        const other = await setup({
          workspace: context.workspace,
          account: context.deployment.exchangeAccountId,
        });
        if (+localStart < +utcStart) {
          await realizedTrade(other, localStart, -100);
        } else {
          await realizedTrade(other, utcStart, 200);
          await realizedTrade(other, localStart, -100);
        }
        const risk = await guard.assess(
          context.workspace.id,
          context.deployment.exchangeAccountId,
          config,
        );
        assert.equal(risk.reason, "STRATEGY_DAILY_LOSS_LIMIT");
        assert.equal(risk.forceCloseReason, null);
        assert.equal(risk.strategyDay.realizedPnl, -100);
        assert.equal(
          await prisma.runtimeRiskDay.count({ where: { workspaceId: context.workspace.id } }),
          0,
        );
        const pending = await runtime.persistRealtimeEntry(context.entry);
        assert.equal(pending.applied, false);
        assert.equal("riskFailure" in pending && pending.riskFailure, "STRATEGY_DAILY_LOSS_LIMIT");
        const cycle = await runtime.persistCycle({
          ...context.entry,
          ...decisionEngineFields(context),
          interval: "15",
          candleAt: quoteAt,
          expectedDeploymentStatus: "RUNNING",
          expectedPositionId: null,
          expectedPositionVersion: null,
          pendingSignal: null,
          decision: { action: "OPEN", reasonCode: "TEST", summary: "Test", factors: {} },
          positionAction: {
            kind: "open",
            position: context.entry.position,
            markPrice: "100",
            unrealizedPnl: "0",
            immediateSettlement: null,
          },
        });
        assert.equal(cycle.applied, true);
        assert.equal(
          await prisma.position.count({
            where: { executionRunId: context.run.id, status: "OPEN" },
          }),
          0,
        );
        const decision = await prisma.decision.findFirstOrThrow({
          where: { executionRunId: context.run.id, contextSnapshotId: { not: null } },
        });
        assert.equal(decision.reasonCode, "STRATEGY_DAILY_LOSS_LIMIT");
        const unrelated = await setup({ workspace: context.workspace, account: randomUUID() });
        assert.equal(
          (await guard.assess(context.workspace.id, unrelated.deployment.exchangeAccountId, config))
            .strategyDay.realizedPnl,
          0,
        );
      },
    );
    await t.test(
      "UTC safety latch survives realized rebound and resets only at UTC midnight",
      async () => {
        const context = await setup();
        const now = new Date("2026-10-04T23:59:59Z");
        const trade = await realizedTrade(context, now, -1000);
        assert.equal(
          (await assessAt(context, now, "Asia/Novosibirsk")).forceCloseReason,
          "daily-loss-limit",
        );
        await prisma.trade.update({ where: { id: trade.id }, data: { netPnl: "1000" } });
        assert.equal(
          (await assessAt(context, now, "Asia/Novosibirsk")).forceCloseReason,
          "daily-loss-limit",
        );
        const next = await assessAt(context, new Date("2026-10-05T00:00:00Z"), "Asia/Novosibirsk");
        assert.equal(next.forceCloseReason, null);
        assert.equal(next.strategyDay.day, "2026-10-05");
        assert.equal(next.strategyDay.realizedPnl, 1000);
      },
    );
    await t.test("invalid strategy timezone fails closed", async () => {
      const context = await setup();
      assert.equal(
        (await assessAt(context, new Date(), "Invalid/Timezone")).reason,
        "INVALID_RISK_CONFIG",
      );
    });
    await t.test(
      "persistent kill switch blocks both entry paths and rejects stale control updates",
      async () => {
        const context = await setup();
        const guard = new RuntimeRiskRepository(prisma);
        await guard.setControl({
          workspaceId: context.workspace.id,
          actorId: "test",
          requestId: randomUUID(),
          enabled: true,
          reason: "Emergency test",
          expectedVersion: 0,
        });
        assert.equal((await runtime.persistRealtimeEntry(context.entry)).applied, false);
        await runtime.persistCycle({
          ...context.entry,
          ...decisionEngineFields(context),
          interval: "15",
          candleAt: quoteAt,
          expectedDeploymentStatus: "RUNNING",
          expectedPositionId: null,
          expectedPositionVersion: null,
          pendingSignal: null,
          decision: { action: "OPEN", reasonCode: "TEST", summary: "Test", factors: {} },
          positionAction: {
            kind: "open",
            position: context.entry.position,
            markPrice: "100",
            unrealizedPnl: "0",
            immediateSettlement: null,
          },
        });
        assert.equal(await prisma.position.count({ where: { executionRunId: context.run.id } }), 0);
        assert.equal(
          (await new RuntimeRiskRepository(prisma).getControl(context.workspace.id)).enabled,
          true,
        );
        await assert.rejects(
          guard.setControl({
            workspaceId: context.workspace.id,
            actorId: "test",
            requestId: randomUUID(),
            enabled: false,
            reason: "Stale control",
            expectedVersion: 0,
          }),
          RuntimeRiskControlConflictError,
        );
      },
    );
    await t.test(
      "unrealized loss trips a daily latch that survives rebound and kill-switch reset",
      async () => {
        const context = await open();
        const guard = new RuntimeRiskRepository(prisma, {
          ...defaultRuntimeRiskPolicy,
          maxDailyLossPercent: 0.01,
        });
        await prisma.marketPriceEvent.create({
          data: {
            eventKey: randomUUID(),
            symbol: context.symbol,
            price: "98",
            observedAt: quoteAt,
            streamId: context.deployment.exchangeAccountId,
          },
        });
        assert.equal(
          (
            await guard.assess(
              context.workspace.id,
              context.deployment.exchangeAccountId,
              fixture.config,
            )
          ).forceCloseReason,
          "daily-loss-limit",
        );
        await prisma.marketPriceEvent.create({
          data: {
            eventKey: randomUUID(),
            symbol: context.symbol,
            price: "110",
            observedAt: quoteAt,
            streamId: context.deployment.exchangeAccountId,
          },
        });
        await guard.setControl({
          workspaceId: context.workspace.id,
          actorId: "test",
          requestId: randomUUID(),
          enabled: false,
          reason: "Reset control",
          expectedVersion: 0,
        });
        assert.equal(
          (
            await guard.assess(
              context.workspace.id,
              context.deployment.exchangeAccountId,
              fixture.config,
            )
          ).forceCloseReason,
          "daily-loss-limit",
        );
      },
    );
    await t.test(
      "shared stop budget serializes concurrent pending/candle entries without force closing",
      async () => {
        for (const reverse of [false, true]) {
          const first = await setup();
          const second = await setup({
            workspace: first.workspace,
            account: first.deployment.exchangeAccountId,
          });
          const config = {
            ...fixture.config,
            risk: { ...fixture.config.risk, maxOpenPositions: 10 },
          };
          for (const context of [first, second])
            await prisma.strategyVersion.update({
              where: { id: context.entry.strategyVersionId },
              data: { config },
            });
          const policy = { ...defaultRuntimeRiskPolicy, maxDailyLossPercent: 0.03 };
          const limited = new RuntimeRepository(prisma, policy);
          const cycle = {
            ...second.entry,
            ...decisionEngineFields(second),
            interval: "15",
            candleAt: new Date(+quoteAt - 900_000),
            entrySignalPrice: 100,
            expectedDeploymentStatus: "RUNNING" as const,
            expectedPositionId: null,
            expectedPositionVersion: null,
            pendingSignal: null,
            decision: { action: "OPEN" as const, reasonCode: "TEST", summary: "Test", factors: {} },
            positionAction: {
              kind: "open" as const,
              position: second.entry.position,
              markPrice: "100",
              unrealizedPnl: "0",
              immediateSettlement: null,
            },
          };
          const calls = reverse
            ? [() => limited.persistCycle(cycle), () => limited.persistRealtimeEntry(first.entry)]
            : [() => limited.persistRealtimeEntry(first.entry), () => limited.persistCycle(cycle)];
          const results = await Promise.all(calls.map((call) => call()));
          assert.equal(
            await prisma.position.count({
              where: { workspaceId: first.workspace.id, status: "OPEN" },
            }),
            1,
          );
          const rejection = await prisma.decision.findFirst({
            where: { workspaceId: first.workspace.id, reasonCode: "MAX_ACCOUNT_STOP_RISK" },
          });
          assert.ok(
            rejection ||
              results.some((r) => "riskFailure" in r && r.riskFailure === "MAX_ACCOUNT_STOP_RISK"),
            "one concurrent entry must be rejected by the account stop budget",
          );
          const guard = new RuntimeRiskRepository(prisma, policy);
          const risk = await guard.assess(
            first.workspace.id,
            first.deployment.exchangeAccountId,
            config,
          );
          const loss = executionStopRisk({
            side: "long",
            entryPrice: 100,
            stopPrice: 98,
            quantity: 1,
            entryFee: 0.06,
            ...fixture.config.costs,
          })!;
          assert.equal(risk.forceCloseReason, null);
          assert.ok(
            Math.abs(risk.remainingStopRisk - (3 - loss)) < 1e-8,
            `remaining=${risk.remainingStopRisk}, expected=${3 - loss}`,
          );
          assert.equal(
            await prisma.runtimeRiskDay.count({ where: { workspaceId: first.workspace.id } }),
            0,
          );
          const opened = await prisma.position.findFirstOrThrow({
            where: { workspaceId: first.workspace.id, status: "OPEN" },
          });
          await prisma.position.update({
            where: { id: opened.id },
            data: { trailingPrice: "100" },
          });
          const protectedRisk = await guard.assess(
            first.workspace.id,
            first.deployment.exchangeAccountId,
            config,
          );
          assert.ok(
            protectedRisk.remainingStopRisk > risk.remainingStopRisk,
            "tightening protection must release reserved risk",
          );
          assert.equal(protectedRisk.forceCloseReason, null);
        }
      },
    );
    await t.test(
      "mark losses are consumed once and profitable marks cannot finance the stop budget",
      async () => {
        for (const side of ["BUY", "SELL"] as const) {
          const context = await setup();
          const config = {
            ...fixture.config,
            costs: { makerFeeBps: 0, takerFeeBps: 0, slippageBps: 0 },
          };
          await prisma.strategyVersion.update({
            where: { id: context.entry.strategyVersionId },
            data: { config },
          });
          const policy = { ...defaultRuntimeRiskPolicy, maxDailyLossPercent: 0.03 };
          const limited = new RuntimeRepository(prisma, policy);
          const direction = side === "BUY" ? 1 : -1;
          const input = {
            ...context.entry,
            position: {
              ...context.entry.position,
              side,
              entryFee: "0",
              stopPrice: String(100 - 2 * direction),
              takePrice: String(100 + 4 * direction),
            },
          };
          await prisma.runtimeCursor.update({
            where: {
              executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
            },
            data: {
              pendingSignal: {
                mode: "realtime",
                side: side === "BUY" ? "long" : "short",
                signalPrice: 100,
                detectedAt: quoteAt.toISOString(),
                availableAt: quoteAt.toISOString(),
                expiresAt: new Date(Date.now() + 900000).toISOString(),
                entryRegime: "neutral",
              },
            },
          });
          assert.equal((await limited.persistRealtimeEntry(input)).applied, true);
          const guard = new RuntimeRiskRepository(prisma, policy);
          for (const move of [-1, 5]) {
            await prisma.marketPriceEvent.create({
              data: {
                eventKey: randomUUID(),
                symbol: context.symbol,
                price: String(100 + move * direction),
                observedAt: quoteAt,
                streamId: context.deployment.exchangeAccountId,
              },
            });
            const risk = await guard.assess(
              context.workspace.id,
              context.deployment.exchangeAccountId,
              config,
            );
            assert.equal(risk.dailyPnl, Math.min(0, move));
            assert.equal(risk.reservedStopRisk, move < 0 ? 1 : 2);
            assert.equal(risk.remainingStopRisk, 1);
            assert.equal(risk.forceCloseReason, null);
          }
        }
      },
    );
    await t.test(
      "account exposure is admitted atomically across different deployments",
      async () => {
        const first = await setup();
        const second = await setup({
          workspace: first.workspace,
          account: first.deployment.exchangeAccountId,
        });
        for (const context of [first, second])
          await prisma.strategyVersion.update({
            where: { id: context.entry.strategyVersionId },
            data: {
              config: { ...fixture.config, risk: { ...fixture.config.risk, maxOpenPositions: 10 } },
            },
          });
        const limited = new RuntimeRepository(prisma, {
          ...defaultRuntimeRiskPolicy,
          maxAccountExposurePercent: 1.5,
        });
        const results = await Promise.all([
          limited.persistRealtimeEntry(first.entry),
          limited.persistRealtimeEntry(second.entry),
        ]);
        assert.equal(results.filter((result) => result.applied).length, 1);
        assert.ok(
          results.some(
            (result) => "riskFailure" in result && result.riskFailure === "MAX_ACCOUNT_EXPOSURE",
          ),
        );
      },
    );
    await t.test("shared account rejects opposite directions on the same symbol", async () => {
      const first = await setup();
      const second = await setup({
        workspace: first.workspace,
        account: first.deployment.exchangeAccountId,
      });
      assert.equal((await runtime.persistRealtimeEntry(first.entry)).applied, true);
      await prisma.runtimeCursor.create({
        data: {
          workspaceId: second.workspace.id,
          executionRunId: second.run.id,
          symbol: first.symbol,
          lastEvaluatedAt: candleAt,
          pendingSignal: {
            mode: "realtime",
            side: "short",
            signalPrice: 100,
            detectedAt: quoteAt.toISOString(),
            availableAt: quoteAt.toISOString(),
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            entryRegime: "neutral",
          },
        },
      });
      const event = await prisma.marketPriceEvent.create({
        data: {
          eventKey: randomUUID(),
          symbol: first.symbol,
          price: "100",
          observedAt: quoteAt,
          streamId: second.deployment.exchangeAccountId,
        },
      });
      const result = await runtime.persistRealtimeEntry({
        ...second.entry,
        entryPriceEventId: event.id,
        symbol: first.symbol,
        position: {
          ...second.entry.position,
          symbol: first.symbol,
          side: "SELL",
          stopPrice: "102",
          takePrice: "96",
          instrumentRules: first.entry.position.instrumentRules!,
        },
      });
      assert.equal("riskFailure" in result && result.riskFailure, "PORTFOLIO_DIRECTION_CONFLICT");
    });
    await t.test("stale entry quotes and oversized stop risk fail closed", async () => {
      const stale = await setup();
      const old = new Date(Date.now() - 60_000);
      await prisma.marketPriceEvent.update({
        where: { id: stale.entry.entryPriceEventId },
        data: { observedAt: old },
      });
      assert.equal(
        (
          await runtime.persistRealtimeEntry({
            ...stale.entry,
            quoteAt: old,
            position: { ...stale.entry.position, openedAt: old },
          })
        ).applied,
        false,
      );
      const oversized = await setup();
      const result = await runtime.persistRealtimeEntry({
        ...oversized.entry,
        position: { ...oversized.entry.position, quantity: "60", entryFee: "3.6" },
      });
      assert.equal("riskFailure" in result && result.riskFailure, "MAX_TRADE_RISK");
    });
    await t.test("kill-switch API enforces owner, CSRF and optimistic version", async () => {
      const context = await setup();
      const config = loadServerConfig({
        DATABASE_URL: databaseUrl!,
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
      });
      const app = await createApp({ config, prisma });
      try {
        const token = randomUUID();
        const user = await prisma.user.create({
          data: {
            email: `${randomUUID()}@example.test`,
            passwordHash: "unused",
            displayName: "Test",
          },
        });
        const membership = await prisma.workspaceMembership.create({
          data: { workspaceId: context.workspace.id, userId: user.id, role: "MEMBER" },
        });
        await prisma.session.create({
          data: {
            userId: user.id,
            activeWorkspaceId: context.workspace.id,
            tokenHash: createHash("sha256").update(token).digest("hex"),
            expiresAt: new Date(Date.now() + 60000),
          },
        });
        const url = "/api/v1/settings/runtime-safety";
        const payload = { enabled: true, reason: "Emergency stop test", expectedVersion: 0 };
        const headers = {
          cookie: `cryptoanal_session=${token}`,
          "x-csrf-token": createHmac("sha256", config.AUTH_SECRET)
            .update(token)
            .digest("base64url"),
        };
        assert.equal((await app.inject({ method: "PUT", url, headers, payload })).statusCode, 403);
        await prisma.workspaceMembership.update({
          where: { id: membership.id },
          data: { role: "OWNER" },
        });
        assert.equal(
          (await app.inject({ method: "PUT", url, headers: { cookie: headers.cookie }, payload }))
            .statusCode,
          403,
        );
        assert.equal((await app.inject({ method: "PUT", url, headers, payload })).statusCode, 200);
        assert.equal((await app.inject({ method: "PUT", url, headers, payload })).statusCode, 409);
        assert.equal(
          await prisma.auditEvent.count({
            where: { workspaceId: context.workspace.id, action: "runtime.kill-switch" },
          }),
          1,
        );
      } finally {
        await app.close();
      }
    });
    async function liquiditySetup(
      limit = false,
      passive = false,
      minimumNotional = "0",
      repository = runtime,
    ) {
      const context = await setup();
      if (limit)
        await prisma.strategyVersion.update({
          where: { id: context.entry.strategyVersionId },
          data: { config: { ...fixture.config, entry: { orderType: "limit", limitOffsetBps: 0 } } },
        });
      if (minimumNotional !== "0") {
        await prisma.marketInstrument.update({
          where: { symbol: context.symbol },
          data: { minNotional: minimumNotional },
        });
        context.entry.position.instrumentRules = {
          ...context.entry.position.instrumentRules!,
          minNotional: minimumNotional,
        };
      }
      const source = await prisma.marketPriceEvent.findUniqueOrThrow({
        where: { id: context.entry.entryPriceEventId },
      });
      const data: StoredExecutionMarketData = [
        1,
        "0.01",
        "Sell",
        false,
        false,
        ["99.9", "5", passive ? "100.1" : "100", "0.4", +quoteAt, +quoteAt, "100", "200"],
      ];
      await prisma.marketPriceEvent.update({
        where: { id: source.id },
        data: { receivedAt: quoteAt, executionData: data },
      });
      if (repository !== runtime) {
        const now = new Date();
        await new FundingRepository(prisma).saveMarket({
          data: {
            version: 1,
            policy: enabledFundingPolicy,
            symbols: [context.symbol],
            startsAt: now.toISOString(),
            throughAt: now.toISOString(),
            coverage: "complete",
            events: [],
          },
          nextFundingAt: new Date(+now + 3600000),
          observedAt: now,
        });
      }
      const submitted = await repository.submitRealtimeEntryOrder({
        workspaceId: context.workspace.id,
        executionRunId: context.run.id,
        symbol: context.symbol,
        expectedCandleAt: candleAt,
        expectedPendingPriceEventId: null,
        entryPriceEventId: source.id,
        position: context.entry.position,
        policy: defaultEntryLiquidityPolicy,
      });
      assert.equal(submitted.applied, true);
      assert.ok(submitted.orderId);
      const stored = await prisma.order.findUniqueOrThrow({ where: { id: submitted.orderId } });
      const snapshot = readExecutionEntryOrder(
        (stored.execution as { snapshot: unknown }).snapshot,
      );
      return { ...context, source, stored, snapshot };
    }
    async function liquidityFill(
      context: Awaited<ReturnType<typeof liquiditySetup>>,
      price = "100",
      quantity = "0.4",
    ) {
      const time = new Date(Math.max(Date.now(), Date.parse(context.snapshot.submittedAt) + 1));
      const data: StoredExecutionMarketData = [
        1,
        "4",
        "Sell",
        false,
        false,
        ["99.9", "5", "100", "0.4", +time, +time, "101", "201"],
      ];
      const event = await prisma.marketPriceEvent.create({
        data: {
          eventKey: randomUUID(),
          symbol: context.symbol,
          price,
          observedAt: time,
          receivedAt: time,
          streamId: context.source.streamId,
          executionData: data,
        },
      });
      const config = strategyConfigSchema.parse(
        (
          await prisma.strategyVersion.findUniqueOrThrow({
            where: { id: context.entry.strategyVersionId },
          })
        ).config,
      );
      const p = openExecutionPositionAtFill({
        signal: { side: "long", signalPrice: 100 },
        quote: { symbol: context.symbol, price: Number(price), observedAt: time },
        entryRegime: "neutral",
        equity: 10000,
        maximumNotional: 10000,
        config,
        instrumentRules: context.snapshot.instrumentRules,
        fillPrice: 100,
        maximumQuantity: Number(quantity),
        entryExecution: {
          version: entryLiquidityVersion,
          orderId: context.stored.id,
          requestedQuantity: "1",
        },
      })!;
      assert.ok(p);
      const input: PersistRealtimeEntryInput = {
        ...context.entry,
        entryOrderId: context.stored.id,
        entryPriceEventId: event.id,
        expectedPendingPriceEventId: context.source.id,
        quoteAt: time,
        quotePrice: price,
        position: {
          ...context.entry.position,
          ...(context.snapshot.exitPolicy ? { exitPolicy: context.snapshot.exitPolicy } : {}),
          ...(context.snapshot.fundingPolicy
            ? { fundingPolicy: context.snapshot.fundingPolicy }
            : {}),
          entryExecution: p.entryExecution!,
          openedAt: time,
          quantity: String(p.quantity),
          entryFee: String(p.entryFee),
          entrySlippage: String(p.entrySlippage),
        },
      };
      return { event, input };
    }
    await t.test(
      "liquidity IOC atomically persists a partial fill, cancels remainder and deduplicates concurrent writers",
      async () => {
        const context = await liquiditySetup();
        const { input } = await liquidityFill(context);
        const outcomes = await Promise.all([
          runtime.persistRealtimeEntry(input),
          runtime.persistRealtimeEntry(input),
        ]);
        assert.equal(outcomes.filter((x) => x.applied).length, 1);
        const order = await prisma.order.findUniqueOrThrow({
          where: { id: context.stored.id },
          include: { fills: true, position: true },
        });
        assert.equal(order.status, "CANCELLED");
        assert.equal(order.quantity.toFixed(), "1");
        assert.equal(order.fills.length, 1);
        assert.equal(order.fills[0]!.quantity.toFixed(), "0.4");
        assert.equal(order.fills[0]!.fee.toFixed(), "0.024");
        assert.equal(order.position!.quantity.toFixed(), "0.4");
        assert.equal(order.position!.stopPrice.toFixed(), "98");
        assert.equal(order.position!.status, "OPEN");
        assert.ok(order.fills[0]!.execution);
      },
    );
    await t.test(
      "IOC with sufficient liquidity finishes the entire requested quantity",
      async () => {
        const context = await liquiditySetup();
        const { input, event } = await liquidityFill(context, "100", "1");
        const data = structuredClone(event.executionData) as StoredExecutionMarketData;
        data[5]![3] = "2";
        await prisma.marketPriceEvent.update({
          where: { id: event.id },
          data: { executionData: data },
        });
        assert.equal((await runtime.persistRealtimeEntry(input)).applied, true);
        const stored = await prisma.order.findUniqueOrThrow({
          where: { id: context.stored.id },
          include: { fills: true, position: true },
        });
        assert.equal(stored.status, "FILLED");
        assert.equal(stored.position!.quantity.toFixed(), "1");
        assert.equal(stored.fills[0]!.fee.toFixed(), "0.06");
        assert.equal(
          verifyEntryExecutionProof(stored, strategyConfigSchema.parse(fixture.config)).outcome,
          "full",
        );
        assert.equal((await runtime.persistRealtimeEntry(input)).applied, false);
      },
    );
    await t.test(
      "passive partial fill protects immediately on the same price event and replays from entry",
      async () => {
        const context = await liquiditySetup(true, true);
        assert.equal(context.stored.status, "OPEN");
        const { input } = await liquidityFill(context, "97");
        input.entryOrderType = "LIMIT";
        assert.equal((await runtime.persistRealtimeEntry(input)).applied, true);
        const stored = await prisma.order.findUniqueOrThrow({
          where: { id: context.stored.id },
          include: {
            fills: true,
            position: { include: { trade: true, executionTrace: { include: { records: true } } } },
          },
        });
        const config = strategyConfigSchema.parse({
          ...fixture.config,
          entry: { orderType: "limit", limitOffsetBps: 0 },
        });
        assert.equal(verifyEntryExecutionProof(stored, config).outcome, "partial");
        assert.equal(stored.fills[0]!.fee.toFixed(), "0.008");
        assert.equal(stored.position!.status, "CLOSED");
        assert.equal(stored.position!.trade!.exitReason, "stop-loss");
        const exitFill = await prisma.fill.findFirstOrThrow({
          where: { order: { positionId: stored.position!.id, side: "SELL" } },
        });
        assert.equal(
          verifyExitTriggerProof(exitFill, config, stored.position!.exitPolicy).reason,
          "stop-loss",
        );
        const trace = stored.position!.executionTrace!,
          trade = stored.position!.trade!;
        const replay = await replayRuntimeTrace({
          snapshot: trace.snapshot,
          snapshotHash: trace.snapshotHash,
          fullFromEntry: true,
          startEventId: trace.startEventId,
          endEventId: trace.endEventId!,
          expectedEventCount: trace.eventCount,
          records: trace.records,
          loadEvents: (cursor, through) =>
            new PriceArchiveRepository(prisma).after(context.symbol, cursor, through),
          trade: {
            exitReason: trade.exitReason,
            closedAt: trade.closedAt,
            averageExitPrice: trade.averageExitPrice.toFixed(),
            grossPnl: trade.grossPnl.toFixed(),
            netPnl: trade.netPnl.toFixed(),
            fees: trade.fees.toFixed(),
            slippage: trade.slippage.toFixed(),
          },
        });
        assert.equal(replay.status, "matched");
        assert.equal(replay.events, 0);
        const corrupted = structuredClone(stored.fills[0]!.execution) as {
          payload: Record<string, unknown>;
          hash: string;
        };
        corrupted.payload.role = "taker";
        assert.throws(
          () =>
            verifyEntryExecutionProof(
              { ...stored, fills: [{ ...stored.fills[0]!, execution: corrupted }] },
              config,
            ),
          /checksum/,
        );
      },
    );
    await t.test(
      "liquidity admission rejects fabricated price, fee and volume before a valid fill",
      async () => {
        const context = await liquiditySetup();
        const { input } = await liquidityFill(context);
        assert.equal(
          (
            await runtime.persistRealtimeEntry({
              ...input,
              position: { ...input.position, exitPolicy: undefined },
            } as unknown as PersistRealtimeEntryInput)
          ).applied,
          false,
        );
        for (const change of [{ entryPrice: "99" }, { entryFee: "0" }, { quantity: "0.5" }]) {
          assert.equal(
            (
              await runtime.persistRealtimeEntry({
                ...input,
                position: { ...input.position, ...change },
              })
            ).applied,
            false,
          );
        }
        assert.equal(await prisma.fill.count({ where: { orderId: context.stored.id } }), 0);
        assert.equal((await runtime.persistRealtimeEntry(input)).applied, true);
      },
    );
    await t.test(
      "PostOnly that would take liquidity cancels without charging or creating a position",
      async () => {
        const context = await liquiditySetup(true);
        assert.equal(context.stored.status, "CANCELLED");
        assert.equal(await prisma.fill.count({ where: { orderId: context.stored.id } }), 0);
        assert.equal(await prisma.position.count({ where: { executionRunId: context.run.id } }), 0);
      },
    );
    await t.test(
      "inactive and expired entry orders cancel without needing another market event",
      async () => {
        for (const mode of ["pause", "expire"]) {
          const context = await liquiditySetup();
          if (mode === "pause")
            await prisma.deployment.update({
              where: { id: context.deployment.id },
              data: { status: "PAUSED" },
            });
          else
            await prisma.order.update({
              where: { id: context.stored.id },
              data: { expiresAt: new Date(0) },
            });
          await runtime.cancelInactiveEntryOrders(context.workspace.id);
          assert.equal(
            (await prisma.order.findUniqueOrThrow({ where: { id: context.stored.id } })).status,
            "CANCELLED",
          );
          assert.equal(
            (
              await prisma.runtimeCursor.findUniqueOrThrow({
                where: {
                  executionRunId_symbol: { executionRunId: context.run.id, symbol: context.symbol },
                },
              })
            ).pendingSignal,
            null,
          );
        }
      },
    );
    await t.test(
      "fill transaction rollback preserves the order and can retry without duplicate quantity",
      async () => {
        const context = await liquiditySetup();
        const { input } = await liquidityFill(context);
        await prisma.$executeRawUnsafe(
          `CREATE FUNCTION reject_liquidity_fill() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.execution IS NOT NULL THEN RAISE EXCEPTION 'fill write unavailable'; END IF; RETURN NEW; END $$`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER reject_liquidity_fill BEFORE INSERT ON "Fill" FOR EACH ROW EXECUTE FUNCTION reject_liquidity_fill()`,
        );
        try {
          await assert.rejects(runtime.persistRealtimeEntry(input), /fill write unavailable/);
          assert.equal(
            (await prisma.order.findUniqueOrThrow({ where: { id: context.stored.id } })).status,
            "OPEN",
          );
          assert.equal(
            await prisma.position.count({ where: { executionRunId: context.run.id } }),
            0,
          );
        } finally {
          await prisma.$executeRawUnsafe(`DROP TRIGGER reject_liquidity_fill ON "Fill"`);
          await prisma.$executeRawUnsafe(`DROP FUNCTION reject_liquidity_fill()`);
        }
        assert.equal((await runtime.persistRealtimeEntry(input)).applied, true);
        assert.equal(await prisma.fill.count({ where: { orderId: context.stored.id } }), 1);
      },
    );
    await t.test(
      "partial fill below request minimum is admitted only with verified order provenance",
      async () => {
        const context = await liquiditySetup(false, false, "5");
        const { input, event } = await liquidityFill(context, "100", "0.01");
        const data = structuredClone(event.executionData) as StoredExecutionMarketData;
        data[5]![3] = "0.01";
        await prisma.marketPriceEvent.update({
          where: { id: event.id },
          data: { executionData: data },
        });
        assert.equal(
          (
            await runtime.persistRealtimeEntry({
              ...input,
              entryOrderId: undefined,
              position: { ...input.position, entryExecution: undefined },
            } as unknown as PersistRealtimeEntryInput)
          ).applied,
          false,
        );
        assert.equal((await runtime.persistRealtimeEntry(input)).applied, true);
        const position = await prisma.position.findFirstOrThrow({
          where: { executionRunId: context.run.id },
        });
        assert.equal(position.quantity.toFixed(), "0.01");
        assert.equal(position.stopPrice.toFixed(), "98");
      },
    );
    await t.test(
      "earlier public trades reduce the same book snapshot's remaining liquidity",
      async () => {
        const context = await liquiditySetup();
        const firstAt = new Date(
          Math.max(Date.now(), Date.parse(context.snapshot.submittedAt) + 1),
        );
        await prisma.marketPriceEvent.create({
          data: {
            eventKey: randomUUID(),
            symbol: context.symbol,
            price: "100",
            observedAt: firstAt,
            receivedAt: firstAt,
            streamId: context.source.streamId,
            executionData: [
              1,
              "0.3",
              "Buy",
              false,
              false,
              ["99.9", "5", "100", "0.4", +firstAt, +firstAt, "101", "201"],
            ],
          },
        });
        const { input, event } = await liquidityFill(context);
        const data = structuredClone(event.executionData) as StoredExecutionMarketData;
        data[5]![4] = +firstAt;
        data[5]![5] = +firstAt;
        await prisma.marketPriceEvent.update({
          where: { id: event.id },
          data: { executionData: data },
        });
        assert.equal((await runtime.persistRealtimeEntry(input)).applied, false);
        assert.equal(
          (
            await runtime.persistRealtimeEntry({
              ...input,
              position: { ...input.position, quantity: "0.1", entryFee: "0.006" },
            })
          ).applied,
          true,
        );
        const stored = await prisma.order.findUniqueOrThrow({
          where: { id: context.stored.id },
          include: { fills: true },
        });
        assert.equal(
          verifyEntryExecutionProof(stored, strategyConfigSchema.parse(fixture.config)).outcome,
          "partial",
        );
      },
    );
    await t.test(
      "retained pre-policy entry order keeps legacy exits after the worker update",
      async () => {
        const context = await liquiditySetup();
        const { input } = await liquidityFill(context);
        const legacySnapshot = { ...context.snapshot };
        delete legacySnapshot.exitPolicy;
        await prisma.order.update({
          where: { id: context.stored.id },
          data: { execution: { snapshot: legacySnapshot, hash: hashTracePayload(legacySnapshot) } },
        });
        const legacyInput = {
          ...input,
          position: { ...input.position, exitPolicy: undefined },
        } as unknown as PersistRealtimeEntryInput;
        assert.equal((await runtime.persistRealtimeEntry(legacyInput)).applied, true);
        const position = await prisma.position.findFirstOrThrow({
          where: { executionRunId: context.run.id },
        });
        assert.equal(position.exitPolicy, null);
      },
    );
    await t.test(
      "pinned market TP validates the durable quote atomically and replays with a receipt",
      async () => {
        const context = await liquiditySetup();
        const { input: entry } = await liquidityFill(context);
        assert.equal((await runtime.persistRealtimeEntry(entry)).applied, true);
        const stored = await prisma.position.findFirstOrThrow({
          where: { executionRunId: context.run.id },
        });
        assert.deepEqual(stored.exitPolicy, defaultExecutionExitPolicy);
        const quoteAt = new Date(Math.max(Date.now(), +stored.openedAt + 1));
        const price = stored.takePrice.add(5);
        const event = await prisma.marketPriceEvent.create({
          data: {
            eventKey: randomUUID(),
            symbol: stored.symbol,
            price,
            observedAt: quoteAt,
            receivedAt: quoteAt,
            streamId: stored.priceStreamId!,
          },
        });
        const p: ExecutionPosition = {
          exitPolicy: defaultExecutionExitPolicy,
          instrumentRules: context.snapshot.instrumentRules,
          symbol: stored.symbol,
          side: "long",
          openedAt: stored.openedAt,
          entryPrice: Number(stored.entryPrice),
          quantity: Number(stored.quantity),
          stopPrice: Number(stored.stopPrice),
          takePrice: Number(stored.takePrice),
          trailingPrice: null,
          bestPrice: Number(stored.bestPrice),
          entryFee: Number(stored.entryFee),
          entrySlippage: Number(stored.entrySlippage),
          entryRegime: "neutral",
          entrySession: "europe",
        };
        const config = strategyConfigSchema.parse(fixture.config);
        const settlement = evaluateExecutionPriceExit(
          p,
          { symbol: stored.symbol, price: Number(price), observedAt: quoteAt, source: "LastPrice" },
          config,
        )!;
        const close = {
          workspaceId: context.workspace.id,
          deploymentId: context.deployment.id,
          executionRunId: context.run.id,
          strategyVersionId: stored.strategyVersionId,
          positionId: stored.id,
          expectedPositionVersion: stored.runtimeVersion,
          symbol: stored.symbol,
          quotePrice: price.toFixed(),
          quoteAt,
          processedPrice: { eventId: event.id, streamId: event.streamId, throughAt: quoteAt },
          processedEventCount: 1,
          traceInputs: runtimeTraceInputs({
            firstEventId: event.id,
            policy: null,
            signals: [],
            recoveries: [],
          }),
          factors: { source: "durable-price-events" },
          action: {
            kind: "close" as const,
            settlement: {
              exitPrice: String(settlement.exitPrice),
              grossPnl: String(settlement.grossPnl),
              netPnl: String(settlement.netPnl),
              fees: String(settlement.fees),
              slippage: String(settlement.slippage),
              exitReason: settlement.exitReason,
              closedAt: quoteAt,
            },
          },
        };
        await assert.rejects(
          runtime.persistRealtimeQuote({ ...close, quotePrice: "999" }),
          /durable price event/,
        );
        await assert.rejects(
          runtime.persistRealtimeQuote({
            ...close,
            action: {
              ...close.action,
              settlement: { ...close.action.settlement, exitPrice: stored.takePrice.toFixed() },
            },
          }),
          /settlement exitPrice mismatch/,
        );
        assert.equal(
          (await prisma.position.findUniqueOrThrow({ where: { id: stored.id } })).status,
          "OPEN",
        );
        assert.equal(
          await prisma.fill.count({ where: { order: { positionId: stored.id, side: "SELL" } } }),
          0,
        );
        assert.equal((await runtime.persistRealtimeQuote(close)).closed, true);
        assert.equal((await runtime.persistRealtimeQuote(close)).applied, false);
        const fill = await prisma.fill.findFirstOrThrow({
          where: { order: { positionId: stored.id, side: "SELL" } },
        });
        assert.equal(
          verifyExitTriggerProof(fill, config, stored.exitPolicy).triggerPrice,
          price.toFixed(),
        );
        const trace = await prisma.positionExecutionTrace.findUniqueOrThrow({
          where: { positionId: stored.id },
          include: { records: true },
        });
        const trade = await prisma.trade.findUniqueOrThrow({ where: { positionId: stored.id } });
        const replay = await replayRuntimeTrace({
          snapshot: trace.snapshot,
          snapshotHash: trace.snapshotHash,
          fullFromEntry: true,
          startEventId: trace.startEventId,
          endEventId: trace.endEventId!,
          expectedEventCount: trace.eventCount,
          records: trace.records,
          loadEvents: (cursor, through) =>
            new PriceArchiveRepository(prisma).after(stored.symbol, cursor, through),
          trade: {
            exitReason: trade.exitReason,
            closedAt: trade.closedAt,
            averageExitPrice: trade.averageExitPrice.toFixed(),
            grossPnl: trade.grossPnl.toFixed(),
            netPnl: trade.netPnl.toFixed(),
            fees: trade.fees.toFixed(),
            slippage: trade.slippage.toFixed(),
          },
        });
        assert.equal(replay.status, "matched");
      },
    );
    const exitRepository = () =>
      new RuntimeRepository(prisma, undefined, undefined, undefined, {
        ...defaultLiquidityExitPolicy,
        orderTtlMs: 1000,
      });
    async function exitContext(funded = false) {
      const repo = funded
          ? new RuntimeRepository(
              prisma,
              undefined,
              undefined,
              undefined,
              { ...defaultLiquidityExitPolicy, orderTtlMs: 1000 },
              enabledFundingPolicy,
            )
          : exitRepository(),
        context = await liquiditySetup(false, false, "0", repo);
      const { input } = await liquidityFill(context);
      assert.equal((await repo.persistRealtimeEntry(input)).applied, true);
      const position = await prisma.position.findFirstOrThrow({
        where: { executionRunId: context.run.id },
      });
      return { ...context, repo, position };
    }
    async function exitEvent(
      context: Awaited<ReturnType<typeof exitContext>>,
      price = "97",
      size = "0.15",
      streamId = context.source.streamId,
    ) {
      const time = new Date(),
        bid = new Prisma.Decimal(price).sub("0.05").toFixed(),
        ask = new Prisma.Decimal(price).add("0.05").toFixed();
      return prisma.marketPriceEvent.create({
        data: {
          eventKey: randomUUID(),
          symbol: context.symbol,
          price,
          observedAt: time,
          receivedAt: time,
          streamId,
          executionData: [
            1,
            "0.01",
            "Buy",
            false,
            false,
            [bid, size, ask, size, +time, +time, String(+time), String(+time)],
          ],
        },
      });
    }
    async function latchExit(context: Awaited<ReturnType<typeof exitContext>>) {
      const event = await exitEvent(context),
        p = context.position;
      const settlement = evaluateExecutionPriceExit(
        {
          ...context.entry.position,
          exitPolicy: context.snapshot.exitPolicy!,
          entryExecution: {
            version: entryLiquidityVersion,
            orderId: context.stored.id,
            requestedQuantity: "1",
          },
          side: "long",
          entryRegime: "neutral",
          entrySession: "europe",
          entryPrice: Number(p.entryPrice),
          quantity: Number(p.quantity),
          ...(p.fundingPolicy ? { fundingPaid: p.fundingRemaining!.toNumber() } : {}),
          stopPrice: Number(p.stopPrice),
          takePrice: Number(p.takePrice),
          trailingPrice: null,
          bestPrice: Number(p.bestPrice),
          entryFee: Number(p.entryFee),
          entrySlippage: Number(p.entrySlippage),
        },
        {
          symbol: p.symbol,
          price: Number(event.price),
          observedAt: event.observedAt,
          source: "LastPrice",
        },
        strategyConfigSchema.parse(fixture.config),
      )!;
      const request: PersistRuntimeQuoteInput = {
        workspaceId: p.workspaceId,
        deploymentId: context.deployment.id,
        executionRunId: p.executionRunId,
        strategyVersionId: p.strategyVersionId,
        positionId: p.id,
        expectedPositionVersion: p.runtimeVersion,
        symbol: p.symbol,
        quoteAt: event.observedAt,
        quotePrice: event.price.toFixed(),
        processedPrice: {
          eventId: event.id,
          streamId: event.streamId,
          throughAt: event.observedAt,
        },
        processedEventCount: 1,
        traceInputs: runtimeTraceInputs({
          firstEventId: event.id,
          policy: null,
          signals: [],
          recoveries: [],
        }),
        factors: { source: "durable-price-events" },
        action: {
          kind: "close",
          settlement: {
            ...settlement,
            exitPrice: String(settlement.exitPrice),
            grossPnl: String(settlement.grossPnl),
            netPnl: String(settlement.netPnl),
            fees: String(settlement.fees),
            slippage: String(settlement.slippage),
            closedAt: new Date(settlement.closedAt),
          },
        },
      };
      assert.equal((await context.repo.persistRealtimeQuote(request)).closed, false);
      assert.equal((await context.repo.persistRealtimeQuote(request)).applied, false);
      return request;
    }
    async function advanceExit(
      context: Awaited<ReturnType<typeof exitContext>>,
      repo = context.repo,
    ) {
      const p = await prisma.position.findUniqueOrThrow({ where: { id: context.position.id } });
      return repo.advanceLiquidityPosition({
        workspaceId: p.workspaceId,
        executionRunId: p.executionRunId,
        positionId: p.id,
        expectedPositionVersion: p.runtimeVersion,
      });
    }
    async function replayExit(
      context: Awaited<ReturnType<typeof exitContext>>,
      tamper: boolean | "funding" = false,
      missingSource = false,
    ) {
      const trace = await prisma.positionExecutionTrace.findUniqueOrThrow({
        where: { positionId: context.position.id },
        include: { records: { orderBy: { id: "asc" } }, position: { include: { trade: true } } },
      });
      const t = trace.position.trade;
      if (tamper === "funding") {
        const record = trace.records.find(
          (r) => r.kind === "funding" && (r.payload as { payments: unknown[] }).payments.length,
        )!;
        const payload = structuredClone(record.payload) as unknown as {
          payments: Array<{ amount: string }>;
        };
        payload.payments[0]!.amount = "999";
        record.payload = payload as unknown as Prisma.JsonValue;
        record.payloadHash = hashTracePayload(payload);
      } else if (tamper) {
        const record = trace.records.find(
          (r) =>
            r.kind === "liquidity-step" &&
            (r.payload as unknown as LiquidityExitStep).action.kind === "fill",
        )!;
        const payload = structuredClone(record.payload) as unknown as LiquidityExitStep;
        if (payload.action.kind === "fill") payload.action.fill!.netPnl = "999";
        record.payload = payload as unknown as Prisma.JsonValue;
        record.payloadHash = hashTracePayload(payload);
      }
      return replayRuntimeTrace({
        snapshot: trace.snapshot,
        snapshotHash: trace.snapshotHash,
        fullFromEntry: trace.fullFromEntry,
        startEventId: trace.startEventId,
        endEventId: trace.endEventId ?? trace.position.priceEventId!,
        expectedEventCount: trace.eventCount,
        records: trace.records,
        loadEvents: (cursor, through) =>
          new PriceArchiveRepository(prisma).after(context.symbol, cursor, through),
        loadFundingSnapshot: (id) =>
          missingSource
            ? Promise.resolve(null)
            : prisma.fundingHistorySnapshot.findUnique({
                where: { id },
                select: { payload: true, payloadHash: true },
              }),
        trade: t
          ? {
              exitReason: t.exitReason,
              closedAt: t.closedAt,
              averageExitPrice: t.averageExitPrice.toFixed(),
              grossPnl: t.grossPnl.toFixed(),
              netPnl: t.netPnl.toFixed(),
              fees: t.fees.toFixed(),
              slippage: t.slippage.toFixed(),
              funding: t.funding.toFixed(),
            }
          : null,
      });
    }
    async function fundingContext() {
      const c = await exitContext(true),
        settledAt = new Date(Math.floor(Date.now() / 60000) * 60000),
        openedAt = new Date(+settledAt - 3600000);
      const state = initialPositionFundingState(openedAt, settledAt);
      c.position = await prisma.position.update({
        where: { id: c.position.id },
        data: { openedAt, fundingState: state },
      });
      const trace = await prisma.positionExecutionTrace.findUniqueOrThrow({
        where: { positionId: c.position.id },
      });
      const snapshot = structuredClone(trace.snapshot) as unknown as {
        position: Record<string, unknown>;
        funding: Record<string, unknown>;
      };
      snapshot.position.openedAt = openedAt.toISOString();
      snapshot.funding.state = state;
      await prisma.positionExecutionTrace.update({
        where: { positionId: c.position.id },
        data: {
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          snapshotHash: hashTracePayload(snapshot),
          fullFromEntry: false,
        },
      });
      const funding = new FundingRepository(prisma);
      const data: ExecutionFundingDataset = {
        version: 1,
        policy: enabledFundingPolicy,
        symbols: [c.symbol],
        startsAt: openedAt.toISOString(),
        throughAt: new Date().toISOString(),
        coverage: "complete",
        events: [
          {
            symbol: c.symbol,
            settledAt: settledAt.toISOString(),
            rate: "0.001",
            markPrice: "100",
            markInterval: "1",
          },
        ],
      };
      const publish = () =>
        funding.saveMarket({
          data,
          nextFundingAt: new Date(+settledAt + 3600000),
          observedAt: new Date(),
        });
      return { c, funding, data, publish };
    }
    await t.test(
      "funding policy pins to new entry; missing settlement blocks entries and repeated concurrent synchronization pays once",
      async () => {
        const { c, funding, publish } = await fundingContext();
        assert.equal(c.snapshot.fundingPolicy?.version, enabledFundingPolicy.version);
        await publish();
        const freshMarket = await prisma.fundingMarketState.findUniqueOrThrow({
          where: { symbol: c.symbol },
        });
        const savedData = (
          await prisma.fundingHistorySnapshot.findUniqueOrThrow({
            where: { id: freshMarket.snapshotId },
          })
        ).payload as unknown as ExecutionFundingDataset;
        await funding.saveMarket({
          data: savedData,
          nextFundingAt: new Date(+freshMarket.nextFundingAt + 3600000),
          observedAt: new Date(+freshMarket.observedAt - 1000),
        });
        assert.deepEqual(
          await prisma.fundingMarketState.findUniqueOrThrow({ where: { symbol: c.symbol } }),
          freshMarket,
        );
        await Promise.all([
          funding.synchronizePosition(c.position.id),
          funding.synchronizePosition(c.position.id),
        ]);
        let p = await prisma.position.findUniqueOrThrow({ where: { id: c.position.id } });
        assert.equal(p.fundingAccrued!.toFixed(), "0.04");
        assert.equal(p.fundingRemaining!.toFixed(), "0.04");
        assert.equal(p.realizedPnl.toFixed(), "-0.04");
        assert.equal(await prisma.positionFundingPayment.count({ where: { positionId: p.id } }), 1);
        assert.equal(
          await realizedCashPnl(prisma, {
            workspaceId: p.workspaceId,
            exchangeAccountId: c.deployment.exchangeAccountId,
            environment: "DRY_RUN",
            since: new Date(0),
          }),
          "-0.04",
        );
        assert.equal((await replayExit(c)).status, "matched");
        await assert.rejects(replayExit(c, "funding"), /cash flow/);
        await assert.rejects(replayExit(c, false, true), /source snapshot is missing/);
        await funding.markUnavailable(c.symbol, "FUNDING_SOURCE_UNAVAILABLE");
        assert.equal(
          (
            await new RuntimeRiskRepository(prisma).assess(
              c.workspace.id,
              c.deployment.exchangeAccountId,
              fixture.config as Prisma.JsonValue,
            )
          ).reason,
          "FUNDING_DATA_UNAVAILABLE",
        );
        p = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
        assert.equal((p.fundingState as { status: string }).status, "pending");
        c.position = p;
        await latchExit(c);
        await advanceExit(c);
        await exitEvent(c, "97", "1");
        await new Promise((r) => setTimeout(r, 1100));
        await advanceExit(c);
        p = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
        assert.equal(p.remainingQuantity!.toFixed(), "0");
        assert.equal(p.status, "OPEN");
        assert.equal(await prisma.trade.count({ where: { positionId: p.id } }), 0);
        await publish();
        await new FundingRepository(prisma).synchronizePosition(p.id);
        assert.deepEqual(await advanceExit(c), { applied: true, closed: true });
        const trade = await prisma.trade.findUniqueOrThrow({ where: { positionId: p.id } });
        assert.equal(trade.funding.toFixed(), "0.04");
        assert.equal(await prisma.positionFundingPayment.count({ where: { positionId: p.id } }), 1);
        assert.equal((await replayExit(c)).status, "matched");
      },
    );
    await t.test(
      "late funding after partial fills uses original settlement exposure and preserves fill cash",
      async () => {
        const { c, funding, publish } = await fundingContext();
        await funding.markUnavailable(c.symbol, "FUNDING_SOURCE_UNAVAILABLE");
        c.position = await prisma.position.findUniqueOrThrow({ where: { id: c.position.id } });
        await latchExit(c);
        await advanceExit(c);
        await exitEvent(c);
        await new Promise((r) => setTimeout(r, 1100));
        await advanceExit(c);
        const before = await prisma.position.findUniqueOrThrow({ where: { id: c.position.id } });
        assert.equal(before.remainingQuantity!.toFixed(), "0.25");
        const fill = await prisma.fill.findFirstOrThrow({
          where: { order: { positionId: before.id, side: "SELL" } },
        });
        await publish();
        await funding.synchronizePosition(before.id);
        const after = await prisma.position.findUniqueOrThrow({ where: { id: before.id } });
        assert.equal(after.fundingAccrued!.toFixed(), "0.04");
        assert.equal(after.fundingRemaining!.toFixed(), "0.025");
        assert.equal(after.realizedPnl.sub(before.realizedPnl).toFixed(), "-0.04");
        assert.deepEqual(await prisma.fill.findUniqueOrThrow({ where: { id: fill.id } }), fill);
        assert.equal((await replayExit(c)).status, "matched");
      },
    );
    await t.test(
      "funding payment write failure rolls back money, proof and runtime version",
      async () => {
        const { c, funding, publish } = await fundingContext();
        await publish();
        const before = await prisma.position.findUniqueOrThrow({ where: { id: c.position.id } }),
          records = await prisma.positionTraceRecord.count({
            where: { positionId: c.position.id },
          });
        await prisma.$executeRawUnsafe(
          `CREATE FUNCTION reject_funding_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'funding write unavailable'; END $$`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER reject_funding_payment BEFORE INSERT ON "PositionFundingPayment" FOR EACH ROW EXECUTE FUNCTION reject_funding_payment()`,
        );
        try {
          await assert.rejects(funding.synchronizePosition(c.position.id));
          assert.deepEqual(
            await prisma.position.findUniqueOrThrow({ where: { id: c.position.id } }),
            before,
          );
          assert.equal(
            await prisma.positionTraceRecord.count({ where: { positionId: c.position.id } }),
            records,
          );
        } finally {
          await prisma.$executeRawUnsafe(
            `DROP TRIGGER reject_funding_payment ON "PositionFundingPayment"`,
          );
          await prisma.$executeRawUnsafe(`DROP FUNCTION reject_funding_payment()`);
        }
        await funding.synchronizePosition(c.position.id);
        assert.equal(
          await prisma.positionFundingPayment.count({ where: { positionId: c.position.id } }),
          1,
        );
      },
    );
    await t.test(
      "liquidity stop persists intent, fills in parts, survives restart and books cash exactly once",
      async () => {
        const c = await exitContext();
        await latchExit(c);
        assert.equal(await prisma.trade.count({ where: { positionId: c.position.id } }), 0);
        await advanceExit(c);
        await exitEvent(c);
        await new Promise((r) => setTimeout(r, 1100));
        assert.deepEqual(await advanceExit(c), { applied: true, closed: false });
        let p = await prisma.position.findUniqueOrThrow({ where: { id: c.position.id } });
        assert.equal(p.quantity.toFixed(), "0.4");
        assert.equal(p.remainingQuantity!.toFixed(), "0.25");
        assert.equal(p.remainingEntryFee!.toFixed(), "0.015");
        assert.equal(p.realizedPnl.toFixed(), "-0.4752255");
        assert.equal(
          await realizedCashPnl(prisma, { workspaceId: p.workspaceId, since: new Date(0) }),
          "-0.4752255",
        );
        const eq = await c.repo.getDryRunEquity(
          p.workspaceId,
          c.deployment.exchangeAccountId,
          "10000",
        );
        assert.equal(eq, 9998.7597745);
        const risk = await new RuntimeRiskRepository(prisma).assess(
          p.workspaceId,
          c.deployment.exchangeAccountId,
          strategyConfigSchema.parse(fixture.config),
        );
        assert.equal(risk.exposure, 24.25);
        assert.ok(risk.dailyPnl < Number(p.realizedPnl));
        assert.equal(
          (
            await snapshots.captureDryRunSnapshot({
              workspaceId: p.workspaceId,
              exchangeAccountId: c.deployment.exchangeAccountId,
              initialBalance: "10000",
            })
          ).equity.toNumber(),
          eq,
        );
        const ledger = await new DashboardRepository(prisma).getTradingLedger(p.workspaceId);
        assert.equal(ledger.positions[0]!.quantity.toFixed(), "0.25");
        assert.equal(ledger.positions[0]!.closing, true);
        assert.equal(ledger.summary.netPnl, "-0.4752255");
        assert.equal((await replayExit(c)).status, "matched");
        await exitEvent(c, "102", "0.25");
        await advanceExit(c, exitRepository());
        await exitEvent(c, "102", "0.25");
        const current = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
        const input = {
          workspaceId: p.workspaceId,
          executionRunId: p.executionRunId,
          positionId: p.id,
          expectedPositionVersion: current.runtimeVersion,
        };
        const reads = Promise.all(
          Array.from({ length: 5 }, () =>
            new DashboardRepository(prisma).getTradingLedger(p.workspaceId),
          ),
        );
        const outcomes = await Promise.all([
          exitRepository().advanceLiquidityPosition(input),
          exitRepository().advanceLiquidityPosition(input),
        ]);
        for (const view of await reads) {
          assert.ok(["-0.4752255", "-0.018018"].includes(view.summary.netPnl));
          assert.equal(view.positions.length + view.trades.length, 1);
        }
        assert.equal(outcomes.filter((r) => r.closed).length, 1);
        p = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
        assert.equal(p.status, "CLOSED");
        assert.equal(p.remainingQuantity!.toFixed(), "0");
        assert.equal(p.remainingEntryFee!.toFixed(), "0");
        const trade = await prisma.trade.findUniqueOrThrow({ where: { positionId: p.id } });
        assert.equal(trade.exitReason, "stop-loss");
        assert.equal(trade.quantity.toFixed(), "0.4");
        assert.equal(trade.grossPnl.toFixed(), "0.03");
        assert.equal(trade.netPnl.toFixed(), "-0.018018");
        assert.equal(trade.averageExitPrice.toFixed(), "100.075");
        assert.equal(
          await realizedCashPnl(prisma, { workspaceId: p.workspaceId, since: new Date(0) }),
          trade.netPnl.toFixed(),
        );
        assert.equal(
          await c.repo.getDryRunEquity(p.workspaceId, c.deployment.exchangeAccountId, "10000"),
          9999.981982,
        );
        const fills = await prisma.fill.findMany({
          where: { order: { positionId: p.id, side: "SELL" } },
          orderBy: { filledAt: "asc" },
        });
        assert.equal(fills.length, 2);
        for (const f of fills)
          assert.equal(
            verifyLiquidityExitFill(
              f,
              strategyConfigSchema.parse(fixture.config),
              liquidityExitBasis(p),
            ).status,
            "matched",
          );
        await assert.rejects(
          async () =>
            verifyLiquidityExitFill(
              { ...fills[0]!, realizedNetPnl: new Prisma.Decimal(0) },
              strategyConfigSchema.parse(fixture.config),
              liquidityExitBasis(p),
            ),
          /stored fill/,
        );
        const replay = await replayExit(c);
        assert.deepEqual(replay.differences, []);
        assert.deepEqual(replay.gaps, []);
        assert.equal(replay.status, "matched");
        await assert.rejects(replayExit(c, true), /accounting mismatch/);
        const hot = await prisma.marketPriceEvent.findMany({
          where: { symbol: c.symbol },
          orderBy: { id: "asc" },
        });
        const { rawBytes, ...chunk } = await encodePriceArchive(hot.map(archivePriceEvent));
        assert.ok(rawBytes > 0);
        await prisma.$transaction(async (tx) => {
          await tx.marketPriceArchiveChunk.create({ data: chunk });
          await tx.marketPriceEvent.deleteMany({ where: { symbol: c.symbol } });
        });
        assert.equal(await prisma.marketPriceEvent.count({ where: { symbol: c.symbol } }), 0);
        assert.equal((await replayExit(c)).status, "matched");
        const first = fills[0]!.filledAt,
          second = fills[1]!.filledAt;
        assert.equal(
          await realizedCashPnl(prisma, { workspaceId: p.workspaceId, since: first, until: first }),
          "-0.4752255",
        );
        assert.equal(
          await realizedCashPnl(prisma, {
            workspaceId: p.workspaceId,
            since: second,
            until: second,
          }),
          "0.4572075",
        );
      },
    );
    await t.test(
      "exit fill, IOC terminal state and remaining balance roll back together",
      async () => {
        const c = await exitContext();
        await latchExit(c);
        await advanceExit(c);
        await exitEvent(c);
        const before = await prisma.position.findUniqueOrThrow({ where: { id: c.position.id } });
        const fn = `fail_exit_${randomUUID().replaceAll("-", "")}`;
        await prisma.$executeRawUnsafe(
          `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."realizedNetPnl" IS NOT NULL THEN RAISE EXCEPTION 'exit test rollback'; END IF; RETURN NEW; END $$`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER ${fn} BEFORE INSERT ON "Fill" FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
        );
        try {
          await assert.rejects(advanceExit(c), /exit test rollback/);
        } finally {
          await prisma.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "Fill"`);
          await prisma.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
        }
        const unchanged = await prisma.position.findUniqueOrThrow({ where: { id: before.id } });
        assert.equal(unchanged.runtimeVersion, before.runtimeVersion);
        assert.deepEqual(unchanged.exitState, before.exitState);
        assert.equal(
          await prisma.fill.count({ where: { order: { positionId: before.id, side: "SELL" } } }),
          0,
        );
        assert.equal((await advanceExit(c)).applied, true);
        assert.equal(
          await prisma.fill.count({ where: { order: { positionId: before.id, side: "SELL" } } }),
          1,
        );
      },
    );
    await t.test(
      "manual exit is an idempotent closing request; stale book and TTL never fake a fill",
      async () => {
        const c = await exitContext(),
          p = c.position;
        const request = {
          workspaceId: p.workspaceId,
          positionId: p.id,
          executionRunId: p.executionRunId,
          actorId: "test",
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          reason: "test",
        };
        const result = await c.repo.requestManualLiquidityExit(request);
        assert.equal(result.status, "closing");
        assert.equal(result.tradeId, null);
        assert.equal((await c.repo.requestManualLiquidityExit(request)).replayed, true);
        await assert.rejects(
          c.repo.closeManually({
            ...request,
            idempotencyKey: randomUUID(),
            quoteObservedAt: new Date(),
            maximumQuoteAgeMs: 1000,
            settlement: {
              exitPrice: "100",
              grossPnl: "0",
              netPnl: "0",
              fees: "0",
              slippage: "0",
              exitReason: "manual",
              closedAt: new Date(),
            },
          }),
          /./,
        );
        await prisma.marketPriceEvent.create({
          data: {
            eventKey: randomUUID(),
            symbol: p.symbol,
            price: "99",
            observedAt: new Date(),
            streamId: c.source.streamId,
          },
        });
        await advanceExit(c);
        let stored = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
        assert.equal(
          readLiquidityExitState(stored.exitState)!.waitingReason,
          "EXIT_BOOK_UNAVAILABLE",
        );
        assert.equal(stored.unrealizedPnl.toFixed(), "-0.4");
        assert.equal(remainingExitQuantity(readLiquidityExitState(stored.exitState)!), "0.4");
        await exitEvent(c, "99", "0.4");
        await advanceExit(c);
        await new Promise((r) => setTimeout(r, 1100));
        await advanceExit(c);
        stored = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
        assert.equal(readLiquidityExitState(stored.exitState)!.waitingReason, "EXIT_ORDER_EXPIRED");
        assert.equal(await prisma.trade.count({ where: { positionId: p.id } }), 0);
        assert.equal((await replayExit(c)).status, "matched");
        await exitEvent(c, "99", "0.4");
        await advanceExit(c);
        await exitEvent(c, "99", "0.4");
        assert.equal((await advanceExit(c)).closed, true);
        assert.equal((await replayExit(c)).status, "matched");
      },
    );
    await t.test(
      "paused or revoked deployment keeps servicing an already latched liquidity exit",
      async () => {
        const c = await exitContext();
        await latchExit(c);
        await prisma.deployment.update({
          where: { id: c.deployment.id },
          data: { status: "PAUSED" },
        });
        await prisma.exchangeConnection.update({
          where: { id: c.connection.id },
          data: { status: "INVALID", revokedAt: new Date() },
        });
        await advanceExit(c);
        await c.repo.cancelInactiveEntryOrders(c.workspace.id);
        await exitEvent(c, "97", "0.4");
        assert.equal((await advanceExit(c)).closed, true);
      },
    );
    await t.test("exit retries cannot reuse already consumed book liquidity", async () => {
      const c = await exitContext();
      await latchExit(c);
      await advanceExit(c);
      const first = await exitEvent(c, "97", "0.3");
      await advanceExit(c);
      assert.equal(
        (
          await prisma.position.findUniqueOrThrow({ where: { id: c.position.id } })
        ).remainingQuantity!.toFixed(),
        "0.1",
      );
      await advanceExit(c);
      const next = await exitEvent(c, "97", "0.3");
      const data = structuredClone(next.executionData) as unknown as StoredExecutionMarketData;
      data[5]![6] = (first.executionData as unknown as StoredExecutionMarketData)[5]![6];
      await prisma.marketPriceEvent.update({
        where: { id: next.id },
        data: { executionData: data },
      });
      await advanceExit(c);
      let p = await prisma.position.findUniqueOrThrow({ where: { id: c.position.id } });
      assert.equal(p.remainingQuantity!.toFixed(), "0.1");
      assert.equal(
        readLiquidityExitState(p.exitState)!.waitingReason,
        "EXIT_LIQUIDITY_UNAVAILABLE",
      );
      assert.equal((await replayExit(c)).status, "matched");
      await advanceExit(c);
      await exitEvent(c, "97", "0.3", "new-stream");
      await advanceExit(c, exitRepository());
      p = await prisma.position.findUniqueOrThrow({ where: { id: c.position.id } });
      assert.equal(readLiquidityExitState(p.exitState)!.waitingReason, "EXIT_ORDER_STREAM_CHANGED");
      await advanceExit(c);
      await exitEvent(c, "97", "0.3", "new-stream");
      assert.equal((await advanceExit(c)).closed, true);
      assert.equal((await replayExit(c)).status, "matched");
    });
    await t.test(
      "manual liquidity close API returns closing without REST price, enforces CSRF and replays the receipt",
      async () => {
        const c = await exitContext(),
          config = loadServerConfig({
            DATABASE_URL: databaseUrl!,
            NODE_ENV: "test",
            LOG_LEVEL: "silent",
          });
        const app = await createApp({ config, prisma });
        try {
          const token = randomUUID(),
            user = await prisma.user.create({
              data: {
                email: `${randomUUID()}@example.test`,
                passwordHash: "unused",
                displayName: "Test",
              },
            });
          await prisma.workspaceMembership.create({
            data: { workspaceId: c.workspace.id, userId: user.id, role: "OWNER" },
          });
          await prisma.session.create({
            data: {
              userId: user.id,
              activeWorkspaceId: c.workspace.id,
              tokenHash: createHash("sha256").update(token).digest("hex"),
              expiresAt: new Date(Date.now() + 60000),
            },
          });
          const headers = {
            cookie: `cryptoanal_session=${token}`,
            "x-csrf-token": createHmac("sha256", config.AUTH_SECRET)
              .update(token)
              .digest("base64url"),
          };
          const payload = {
              idempotencyKey: randomUUID(),
              reason: "Manual exit test",
              expectedStatus: "open",
            },
            url = `/api/v1/positions/${c.position.id}/close`;
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url,
                headers: { cookie: headers.cookie },
                payload,
              })
            ).statusCode,
            403,
          );
          const response = await app.inject({ method: "POST", url, headers, payload });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().data.status, "closing");
          assert.equal(response.json().data.tradeId, null);
          assert.equal(
            (await app.inject({ method: "POST", url, headers, payload })).json().data.replayed,
            true,
          );
          assert.equal(await prisma.trade.count({ where: { positionId: c.position.id } }), 0);
        } finally {
          await app.close();
        }
      },
    );
    await t.test(
      "first entry fill crossing the stop latches liquidity exit without inventing a close",
      async () => {
        const repo = exitRepository(),
          context = await liquiditySetup(true, true, "0", repo),
          { input } = await liquidityFill(context, "97");
        input.entryOrderType = "LIMIT";
        assert.equal((await repo.persistRealtimeEntry(input)).applied, true);
        const position = await prisma.position.findFirstOrThrow({
          where: { executionRunId: context.run.id },
        });
        assert.equal(position.status, "OPEN");
        assert.equal(readLiquidityExitState(position.exitState)!.intent.reason, "stop-loss");
        assert.equal(await prisma.trade.count({ where: { positionId: position.id } }), 0);
        assert.equal((await replayExit({ ...context, repo, position })).status, "matched");
      },
    );
    await t.test(
      "shared account cannot allocate the same opposing book volume to two entries",
      async () => {
        const first = await liquiditySetup();
        const one = await liquidityFill(first, "100", "0.3");
        assert.equal((await runtime.persistRealtimeEntry(one.input)).applied, true);
        const second = await setup({
          workspace: first.workspace,
          account: first.deployment.exchangeAccountId,
        });
        await prisma.strategyVersion.update({
          where: { id: second.entry.strategyVersionId },
          data: {
            config: { ...fixture.config, risk: { ...fixture.config.risk, maxOpenPositions: 10 } },
          },
        });
        await prisma.runtimeCursor.update({
          where: {
            executionRunId_symbol: { executionRunId: second.run.id, symbol: second.symbol },
          },
          data: { symbol: first.symbol },
        });
        const entry = {
          ...second.entry,
          symbol: first.symbol,
          entryPriceEventId: first.source.id,
          position: {
            ...second.entry.position,
            symbol: first.symbol,
            instrumentRules: first.snapshot.instrumentRules,
          },
        };
        const submitted = await runtime.submitRealtimeEntryOrder({
          workspaceId: first.workspace.id,
          executionRunId: second.run.id,
          symbol: first.symbol,
          expectedCandleAt: candleAt,
          expectedPendingPriceEventId: null,
          entryPriceEventId: first.source.id,
          position: entry.position,
          policy: defaultEntryLiquidityPolicy,
        });
        assert.equal(submitted.applied, true);
        const stored = await prisma.order.findUniqueOrThrow({ where: { id: submitted.orderId! } });
        const snapshot = readExecutionEntryOrder(
          (stored.execution as { snapshot: unknown }).snapshot,
        );
        const context = {
          ...second,
          entry,
          symbol: first.symbol,
          source: first.source,
          stored,
          snapshot,
        };
        const two = await liquidityFill(context, "100", "0.3");
        assert.equal((await runtime.persistRealtimeEntry(two.input)).applied, false);
        assert.equal(
          (
            await runtime.persistRealtimeEntry({
              ...two.input,
              position: { ...two.input.position, quantity: "0.1", entryFee: "0.006" },
            })
          ).applied,
          true,
        );
        const total = await prisma.fill.aggregate({
          where: { orderId: { in: [first.stored.id, stored.id] } },
          _sum: { quantity: true },
        });
        assert.equal(total._sum.quantity!.toFixed(), "0.4");
      },
    );
  } finally {
    await prisma.$disconnect();
  }
});
