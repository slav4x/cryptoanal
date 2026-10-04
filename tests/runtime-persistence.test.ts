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
} from "../packages/persistence/src/runtime-risk";
import { PriceEventRepository } from "../packages/persistence/src/price-event-repository";
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
  const quoteAt = new Date();
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
    await prisma.marketInstrument.create({
      data: {
        symbol,
        baseAsset: "TEST",
        quoteAsset: "USDT",
        exchange: "bybit",
        instrumentType: "linear-perpetual",
        status: "Trading",
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
          const detectedAt = new Date(Date.now() - age);
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
        }));
        const first = await journal.append(events, owner);
        const restarted = new PriceEventRepository(prisma);
        assert.deepEqual(
          (await restarted.append(events, owner)).map((row) => row.id),
          first.map((row) => row.id),
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
        position: { ...second.entry.position, symbol: first.symbol, side: "SELL" },
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
  } finally {
    await prisma.$disconnect();
  }
});
