import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { test } from "node:test";
import { createPrismaClient } from "../packages/persistence/src/client";
import { MarketDataRepository } from "../packages/persistence/src/market-data-repository";
import { AccountSnapshotRepository } from "../packages/persistence/src/account-snapshot-repository";
import { DecisionRepository } from "../packages/persistence/src/decision-repository";
import {
  RuntimeRepository,
  RuntimeStateConflictError,
  type PersistRuntimeCycleInput,
  type PersistRuntimeQuoteInput,
  type PersistRealtimeEntryInput,
} from "../packages/persistence/src/runtime-repository";

import {
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
      detectedAt: "2026-01-01T12:15:00Z",
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
        const second = { ...first, openTime: quoteAt };
        await candles.saveCandles([{ ...first, close: "101", isClosed: true }, second]);
        await candles.saveCandles([first]);
        const rows = await prisma.marketCandle.findMany({
          where: { symbol: context.symbol },
          orderBy: { openTime: "asc" },
        });
        assert.equal(rows[0]!.close.toNumber(), 101);
        assert.equal(rows[0]!.isClosed, true);
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
    await t.test("invalid connection blocks pending and candle entries", async () => {
      const context = await setup();
      await prisma.exchangeConnection.update({
        where: { id: context.connection.id },
        data: { status: "INVALID" },
      });
      assert.equal((await runtime.persistRealtimeEntry(context.entry)).applied, false);
      assert.equal((await runtime.listRealtimePendingEntries(context.workspace.id)).length, 0);
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
        where: { executionRunId: context.run.id, mode: "EXECUTION" },
      });
      assert.equal(storedDecision.providerId, "cryptoanal-rule-engine");
      assert.ok(storedDecision.contextSnapshotId);
    });
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
            detectedAt: "2026-01-01T12:15:00Z",
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
