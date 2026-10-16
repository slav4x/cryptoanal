import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { createPrismaClient } from "../packages/persistence/src/client";
import {
  RuntimeRepository,
  type PersistRealtimeEntryInput,
} from "../packages/persistence/src/runtime-repository";
import {
  PriceEventRepository,
  type PriceEventInput,
} from "../packages/persistence/src/price-event-repository";
import { RuntimeLockBusyError } from "../packages/persistence/src/runtime-lock";
import { Prisma } from "../packages/persistence/src/generated/prisma/client";
import { OrderedPriceJournal } from "../apps/worker/src/price-journal";
import { RuntimeLatency } from "../apps/worker/src/runtime-latency";
import { runRuntimeLane } from "../apps/worker/src/runtime-lane";
import {
  RuntimeProtectionWatch,
  RuntimeProtectionPreempted,
} from "../apps/worker/src/runtime-protection-watch";
import { processRuntimePriceEvents } from "../apps/worker/src/runtime-price-processor";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  settleExecutionPosition,
  type ExecutionPosition,
} from "../packages/application/src/execution-engine";

const databaseUrl = process.env.RUNTIME_LOAD_DATABASE_URL;
if (process.env.npm_lifecycle_event === "runtime:load" && !databaseUrl)
  throw new Error(
    "RUNTIME_LOAD_DATABASE_URL must point to a migrated, dedicated cryptoanal_runtime_test_* database",
  );
if (databaseUrl && !/^\/cryptoanal_runtime_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname))
  throw Error("Use a dedicated cryptoanal_runtime_test_* database");

test(
  "isolated PostgreSQL burst, pool starvation, database failure, slow history and priority exit",
  { skip: !databaseUrl, timeout: 60000 },
  async () => {
    const suffix = randomUUID();
    const db = createPrismaClient(databaseUrl!);
    const journalDb = createPrismaClient(databaseUrl!, {
      maxConnections: 2,
      applicationName: `cryptoanal-load-journal-${suffix}`,
      statementTimeoutMs: 4000,
    });
    const entryDb = createPrismaClient(databaseUrl!, {
      maxConnections: 2,
      applicationName: "cryptoanal-load-entry",
      statementTimeoutMs: 4000,
    });
    const positionDb = createPrismaClient(databaseUrl!, {
      maxConnections: 4,
      applicationName: "cryptoanal-load-position",
      statementTimeoutMs: 4000,
    });
    const backgroundDb = createPrismaClient(databaseUrl!, {
      maxConnections: 2,
      applicationName: "cryptoanal-load-background",
    });
    const makeRuntime = (client: typeof db) =>
      new RuntimeRepository(
        client,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
    const entries = makeRuntime(entryDb),
      positions = makeRuntime(positionDb),
      writer = new PriceEventRepository(journalDb, true);
    const metrics = new RuntimeLatency();
    const config = strategyConfigSchema.parse({
      ...fixture.config,
      risk: { ...fixture.config.risk, maxOpenPositions: 20 },
    });
    const latest = new Map<string, Awaited<ReturnType<PriceEventRepository["append"]>>[number]>();
    try {
      const workspace = await db.workspace.create({
        data: { slug: suffix, name: "Isolated load" },
      });
      const stream = `load-${suffix}`,
        owner = `writer-${suffix}`;
      const contexts: Array<{ entry: PersistRealtimeEntryInput; symbol: string }> = [];
      for (let i = 0; i < 20; i++) {
        const now = new Date(),
          symbol = `LOAD${suffix}-${i}`;
        const rules = {
          version: 1 as const,
          symbol,
          observedAt: now.toISOString(),
          tickSize: "0.00000001",
          qtyStep: "0.00000001",
          minOrderQty: "0.00000001",
          minNotional: "0",
          minPrice: "0.00000001",
          maxPrice: "100000000",
          maxOrderQty: "100000000",
          maxMarketOrderQty: "100000000",
        };
        await db.marketInstrument.create({
          data: {
            symbol,
            baseAsset: "LOAD",
            quoteAsset: "USDT",
            exchange: "bybit",
            instrumentType: "linear-perpetual",
            status: "Trading",
            metadataSyncedAt: now,
            tickSize: rules.tickSize,
            qtyStep: rules.qtyStep,
            minOrderQty: rules.minOrderQty,
            minNotional: rules.minNotional,
            minPrice: rules.minPrice,
            maxPrice: rules.maxPrice,
            maxOrderQty: rules.maxOrderQty,
            maxMarketOrderQty: rules.maxMarketOrderQty,
          },
        });
        const strategy = await db.strategy.create({
          data: {
            workspaceId: workspace.id,
            name: symbol,
            createdByActorId: "load",
            updatedByActorId: "load",
          },
        });
        const version = await db.strategyVersion.create({
          data: {
            workspaceId: workspace.id,
            strategyId: strategy.id,
            version: 1,
            config,
            configHash: symbol,
            createdByActorId: "load",
          },
        });
        const connection = await db.exchangeConnection.create({
          data: {
            workspaceId: workspace.id,
            label: symbol,
            environment: "DEMO",
            status: "ACTIVE",
            apiKeyHint: "mock",
            createdByActorId: "load",
          },
        });
        const deployment = await db.deployment.create({
          data: {
            workspaceId: workspace.id,
            strategyId: strategy.id,
            strategyVersionId: version.id,
            exchangeConnectionId: connection.id,
            environment: "DRY_RUN",
            exchangeAccountId: suffix,
            status: "RUNNING",
            createdByActorId: "load",
          },
        });
        const run = await db.executionRun.create({
          data: {
            workspaceId: workspace.id,
            deploymentId: deployment.id,
            strategyVersionId: version.id,
            environment: "DRY_RUN",
            configHash: symbol,
            contextHash: symbol,
            context: {},
            engineVersion: "load-fixture",
            status: "RUNNING",
            createdByActorId: "load",
          },
        });
        const candleAt = new Date(Math.floor(+now / 900000) * 900000 - 900000);
        await db.runtimeCursor.create({
          data: {
            workspaceId: workspace.id,
            executionRunId: run.id,
            symbol,
            lastEvaluatedAt: candleAt,
            pendingSignal: {
              mode: "realtime",
              side: "long",
              signalPrice: 100,
              detectedAt: now.toISOString(),
              availableAt: now.toISOString(),
              expiresAt: new Date(+now + 60000).toISOString(),
              entryRegime: "neutral",
            },
          },
        });
        const event = await db.marketPriceEvent.create({
          data: {
            eventKey: `${symbol}:entry`,
            symbol,
            price: "100",
            observedAt: now,
            streamId: stream,
          },
        });
        const entry: PersistRealtimeEntryInput = {
          workspaceId: workspace.id,
          deploymentId: deployment.id,
          executionRunId: run.id,
          strategyVersionId: version.id,
          symbol,
          expectedCandleAt: candleAt,
          entryPriceEventId: event.id,
          quoteAt: now,
          quotePrice: "100",
          unrealizedPnl: "0",
          maxOpenPositions: 20,
          entryOrderType: "MARKET",
          factors: {},
          position: {
            instrumentRules: rules,
            symbol,
            side: "BUY",
            entryRegime: "NEUTRAL",
            entrySession: "EUROPE",
            openedAt: now,
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
        contexts.push({ entry, symbol });
        if (i < 12) assert.equal((await entries.persistRealtimeEntry(entry)).applied, true);
      }
      await db.marketStreamLease.deleteMany();
      assert.equal(await writer.claimWriter(owner), true);
      const receivedAt = new Date(),
        journal = new OrderedPriceJournal<PriceEventInput>(
          async (batch) => {
            const start = performance.now();
            const saved = await writer.append(batch, owner);
            metrics.observe("journal.writeMs", performance.now() - start);
            for (const event of saved) {
              latest.set(event.symbol, event);
              metrics.observe("journal.eventToCommitMs", Date.now() - +event.receivedAt);
            }
          },
          10000,
          500,
        );
      for (let i = 0; i < 6000; i++)
        journal.enqueue({
          eventKey: `${suffix}:burst:${i}`,
          symbol: contexts[i % 20]!.symbol,
          price: "100",
          observedAt: receivedAt,
          receivedAt,
          streamId: stream,
        });
      let release!: () => void, locked!: () => void;
      const ready = new Promise<void>((r) => {
          locked = r;
        }),
        hold = new Promise<void>((r) => {
          release = r;
        });
      const blocker = backgroundDb.$transaction(async (tx) => {
        await tx.$executeRaw`LOCK TABLE "MarketPriceEvent" IN ACCESS EXCLUSIVE MODE`;
        locked();
        await hold;
      });
      await ready;
      const interrupted = journal.flush();
      const rejected = assert.rejects(interrupted);
      let blockedPid: number | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        const active = await db.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pid FROM pg_stat_activity WHERE application_name=${`cryptoanal-load-journal-${suffix}`} AND wait_event_type='Lock'`,
        );
        if (active[0]) {
          blockedPid = active[0].pid;
          break;
        }
        await sleep(10);
      }
      assert.ok(blockedPid, "writer must actually be blocked inside PostgreSQL");
      await db.$queryRaw(Prisma.sql`SELECT pg_terminate_backend(${blockedPid}::int)`);
      await rejected;
      release();
      await blocker;
      assert.equal(journal.size, 6000);
      assert.equal(journal.healthy, false);
      const background = Promise.all(
        [1, 2].map(() => backgroundDb.$executeRaw`SELECT pg_sleep(0.5)`),
      );
      const start = performance.now();
      await journal.flushAll();
      const burstMs = performance.now() - start;
      assert.equal(journal.size, 0);
      assert.equal(journal.healthy, true);
      assert.equal(
        await db.marketPriceEvent.count({
          where: { eventKey: { startsWith: `${suffix}:burst:` } },
        }),
        6000,
      );
      await background;
      const freshAt = new Date();
      const freshTail = await writer.append(
        contexts.map((context, i) => ({
          eventKey: `${suffix}:fresh:${i}`,
          symbol: context.symbol,
          price: "100",
          observedAt: freshAt,
          receivedAt: freshAt,
          streamId: stream,
        })),
        owner,
      );
      for (const event of freshTail) latest.set(event.symbol, event);
      const filled = new Set<string>(),
        managed = new Set<string>();
      let stop = false,
        deferred = 0;
      const handle = (error: unknown) => {
        if (error instanceof RuntimeLockBusyError) deferred++;
        else throw error;
      };
      const positionWork = runRuntimeLane({
        stopping: () => stop,
        intervalMs: 10,
        concurrency: 4,
        wait: sleep,
        load: () => positions.listRealtimePositions(workspace.id),
        process: async (target) => {
          if (managed.has(target.id)) return;
          if (managed.size < 4) await sleep(500);
          const events = await new PriceEventRepository(positionDb).afterWithArchive(
            target.symbol,
            target.priceEventId,
            target.openedAt,
          );
          await processRuntimePriceEvents({
            position: toPosition(target),
            through: target.managedThroughAt ?? target.openedAt,
            streamId: target.priceStreamId,
            events: events.map((e) => ({ ...e, price: Number(e.price) })),
            config,
            recover: async () => {
              throw Error("Fixture unexpectedly lost its stream");
            },
            checkpoint: async (state) => {
              const result = await positions.persistRealtimeQuote({
                workspaceId: workspace.id,
                deploymentId: target.executionRun.deployment.id,
                executionRunId: target.executionRunId,
                strategyVersionId: target.strategyVersionId,
                positionId: target.id,
                expectedPositionVersion: target.runtimeVersion,
                symbol: target.symbol,
                quoteAt: state.through,
                quotePrice: String(state.markPrice),
                processedPrice: {
                  eventId: state.event.id,
                  streamId: state.streamId,
                  throughAt: state.through,
                },
                processedEventCount: events.length,
                factors: {},
                action: {
                  kind: "update",
                  markPrice: String(state.markPrice),
                  unrealizedPnl: "0",
                  bestPrice: String(state.position.bestPrice),
                  stopPrice: String(state.position.stopPrice),
                  trailingPrice: null,
                },
              });
              if (result.applied) {
                managed.add(target.id);
                metrics.observe(
                  "position.realtime.eventToCheckpointMs",
                  Date.now() - +state.event.receivedAt,
                );
              }
              return result.applied;
            },
          });
        },
        onError: handle,
      });
      const entryStart = performance.now();
      const entryWork = runRuntimeLane({
        stopping: () => stop,
        intervalMs: 10,
        concurrency: 2,
        wait: sleep,
        load: async () => contexts.slice(12).filter((c) => !filled.has(c.symbol)),
        process: async (context) => {
          const event = latest.get(context.symbol)!;
          const result = await entries.persistRealtimeEntry({
            ...context.entry,
            entryPriceEventId: event.id,
            quoteAt: event.observedAt,
            position: { ...context.entry.position, openedAt: event.observedAt },
          });
          if (result.applied) {
            filled.add(context.symbol);
            metrics.observe("entry.quoteToFillMs", Date.now() - +event.receivedAt);
            metrics.observe("entry.independentAdmissionMs", performance.now() - entryStart);
          } else assert.equal(result.riskFailure, undefined);
        },
        onError: handle,
      });
      for (let attempt = 0; attempt < 500 && (filled.size < 8 || managed.size < 12); attempt++)
        await sleep(10);
      stop = true;
      await Promise.all([positionWork, entryWork]);
      assert.equal(filled.size, 8);
      assert.ok(managed.size >= 12);
      const [target] = await positions.listRealtimePositions(workspace.id);
      assert.ok(target);
      const watch = new RuntimeProtectionWatch();
      const expected = target.runtimeVersion,
        position = toPosition(target);
      const waiting = watch.during(
        target.id,
        async () => {
          if (!touch) return false;
          const result = await positions.persistRealtimeQuote({
            workspaceId: workspace.id,
            deploymentId: target.executionRun.deployment.id,
            executionRunId: target.executionRunId,
            strategyVersionId: target.strategyVersionId,
            positionId: target.id,
            expectedPositionVersion: expected,
            symbol: target.symbol,
            quoteAt: touch.observedAt,
            quotePrice: "97",
            processedPrice: {
              eventId: touch.id,
              streamId: touch.streamId,
              throughAt: touch.observedAt,
            },
            factors: { source: "priority-load-test" },
            action: {
              kind: "close",
              settlement: serializedSettlement(position, 97, touch.observedAt, "stop-loss", config),
            },
          });
          if (result.applied)
            metrics.observe("protection.eventToCheckpointMs", Date.now() - +touch.receivedAt);
          return result.applied;
        },
        async (signal) => {
          await new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
      );
      const preempted = assert.rejects(waiting, RuntimeProtectionPreempted);
      const [touch] = await writer.append(
        [
          {
            eventKey: `${suffix}:stop`,
            symbol: target.symbol,
            price: "97",
            observedAt: new Date(),
            receivedAt: new Date(),
            streamId: stream,
          },
        ],
        owner,
      );
      let riskLocked!: () => void;
      const riskReady = new Promise<void>((resolve) => {
        riskLocked = resolve;
      });
      const riskContention = backgroundDb.$transaction(async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`risk:${workspace.id}`}))`,
        );
        riskLocked();
        await sleep(400);
      });
      await riskReady;
      for (let attempt = 0; attempt < 10 && watch.size; attempt++) {
        await watch.poll(2, handle);
        if (watch.size) await sleep(100);
      }
      await riskContention;
      assert.equal(watch.size, 0);
      await preempted;
      assert.equal(await db.trade.count({ where: { positionId: target.id } }), 1);
      assert.equal(
        (await db.positionExecutionTrace.findUniqueOrThrow({ where: { positionId: target.id } }))
          .eventCount,
        null,
      );
      const wrong = await positions.persistRealtimeQuote({
        workspaceId: workspace.id,
        deploymentId: target.executionRun.deployment.id,
        executionRunId: target.executionRunId,
        strategyVersionId: target.strategyVersionId,
        positionId: target.id,
        expectedPositionVersion: expected,
        symbol: target.symbol,
        quoteAt: touch!.observedAt,
        quotePrice: "100",
        processedPrice: { eventId: touch!.id, streamId: stream, throughAt: touch!.observedAt },
        factors: {},
        action: {
          kind: "update",
          markPrice: "100",
          unrealizedPnl: "0",
          bestPrice: "100",
          stopPrice: "98",
          trailingPrice: null,
        },
      });
      assert.equal(wrong.applied, false);
      const measured = metrics.snapshot();
      const report = {
        asOf: new Date().toISOString(),
        scenario: {
          positions: 12,
          pendingEntries: 8,
          events: 6000,
          freshTailEvents: 20,
          protectiveEvents: 1,
          batchSize: 500,
          positionConcurrency: 4,
          entryConcurrency: 2,
          simulatedHistoryMs: 500,
          priorityRiskLockMs: 400,
          databaseFault: "actual writer backend terminated while INSERT waited for a table lock",
          background: "two occupied connections in an independent pool",
        },
        burstMs,
        eventsPerSecond: 6000 / (burstMs / 1000),
        filled: filled.size,
        managed: managed.size,
        deferredLocks: deferred,
        droppedEvents: 0,
        duplicateExitTrades: 0,
        staleWriterRejected: true,
        priorityTraceIncomplete: true,
        latency: measured,
        limits: [
          "Synthetic LastPrice fixtures; this does not model exchange L1 fills or continuous external market latency.",
          "The fixture measures a finite burst, not maximum sustainable capacity or an all-market production guarantee.",
        ],
      };
      if (process.env.RUNTIME_LOAD_REPORT_PATH)
        await writeFile(
          process.env.RUNTIME_LOAD_REPORT_PATH,
          JSON.stringify(report, null, 2) + "\n",
          { mode: 0o600 },
        );
      assert.ok(
        measured.metrics["journal.eventToCommitMs"]!.p99Ms <= 2000,
        "burst journal p99 exceeds 2s",
      );
      assert.ok(
        measured.metrics["entry.quoteToFillMs"]!.p99Ms <= 1000,
        "fresh entry p99 exceeds 1s",
      );
      assert.ok(
        measured.metrics["position.realtime.eventToCheckpointMs"]!.p99Ms <= 2000,
        "position checkpoint p99 exceeds 2s",
      );
      assert.ok(
        measured.metrics["protection.eventToCheckpointMs"]!.maxMs <= 1000,
        "priority exit exceeds 1s",
      );
    } finally {
      await Promise.all(
        [db, journalDb, entryDb, positionDb, backgroundDb].map((p) => p.$disconnect()),
      );
    }
  },
);
function toPosition(
  target: Awaited<ReturnType<RuntimeRepository["listRealtimePositions"]>>[number],
): ExecutionPosition {
  return {
    symbol: target.symbol,
    side: target.side === "BUY" ? "long" : "short",
    openedAt: target.openedAt,
    entryPrice: Number(target.entryPrice),
    quantity: Number(target.quantity),
    stopPrice: Number(target.stopPrice),
    takePrice: Number(target.takePrice),
    trailingPrice: target.trailingPrice === null ? null : Number(target.trailingPrice),
    bestPrice: Number(target.bestPrice),
    entryFee: Number(target.entryFee),
    entrySlippage: Number(target.entrySlippage),
    entryRegime: "neutral",
    entrySession: "asia",
  };
}

function serializedSettlement(
  position: ExecutionPosition,
  price: number,
  at: Date,
  reason: "stop-loss",
  config: ReturnType<typeof strategyConfigSchema.parse>,
) {
  const value = settleExecutionPosition(position, price, at, reason, config);
  return {
    exitPrice: String(value.exitPrice),
    grossPnl: String(value.grossPnl),
    netPnl: String(value.netPnl),
    fees: String(value.fees),
    slippage: String(value.slippage),
    exitReason: value.exitReason,
    closedAt: new Date(value.closedAt),
  };
}
