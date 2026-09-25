import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDecisionMarketFrame,
  createDecisionContextSnapshot,
  runShadowDecisionProviders,
  type DecisionCandidate,
  type DecisionProvider,
  type ExecutionCandle,
} from "../packages/application/src/index";

function candles(count = 80): ExecutionCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.4 + Math.sin(index / 4);
    return {
      symbol: "BTCUSDT",
      openTime: new Date(Date.UTC(2026, 0, 1, 0, index)),
      open: close - 0.2,
      high: close + 0.8,
      low: close - 0.9,
      close,
      turnover: 1_000 + index * 10,
    };
  });
}

function snapshot() {
  const availableAt = new Date(Date.UTC(2026, 0, 1, 1, 20));
  const primaryFrame = buildDecisionMarketFrame({
    candles: candles(),
    timeframe: "1m",
    intervalMs: 60_000,
    availableAt,
    maxCandles: 64,
  });
  return createDecisionContextSnapshot({
    workspaceId: "workspace-1",
    executionRunId: "run-1",
    strategyVersionId: "version-1",
    strategyConfigHash: "config-hash",
    engineVersion: "engine@1",
    symbol: "BTCUSDT",
    availableAt: availableAt.toISOString(),
    primaryFrame,
    account: {
      equity: 10_000,
      availableBalance: 8_000,
      realizedPnlToday: 25,
      openExposure: 2_000,
    },
    position: null,
    risk: {
      entriesAllowed: true,
      maxOpenPositions: 4,
      maxDailyLossPercent: 3,
      riskPerTradePercent: 0.5,
      maximumAccountExposure: 8_000,
      remainingAccountExposure: 6_000,
    },
  });
}

test("decision context uses only closed candles and has a stable content hash", () => {
  const first = snapshot();
  const second = snapshot();

  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.snapshot.market.primary.candles.length, 64);
  assert.equal(first.snapshot.market.primary.lastClosedAt, "2026-01-01T01:20:00.000Z");
  assert.equal(first.snapshot.market.primary.regime, "bull");
  assert.ok(first.snapshot.market.primary.indicators.adx14 !== null);
  assert.ok(first.snapshot.market.primary.indicators.chop14 !== null);
  assert.ok(first.snapshot.market.primary.indicators.rvol20 !== null);
});

test("shadow providers share one context and invalid candidates fail closed", async () => {
  const context = snapshot();
  const candidate: DecisionCandidate = {
    action: "BUY",
    side: "long",
    tradable: true,
    confidence: 0.72,
    riskBudgetPercent: 0.5,
    stopLossPercent: 1,
    takeProfitPercent: 2,
    horizonCandles: 12,
    reasonCodes: ["TREND_CONFIRMED"],
    summary: "Trend and relative volume agree",
    generatedAt: "2026-01-01T01:20:01.000Z",
    validUntil: "2026-01-01T01:21:00.000Z",
  };
  const providers: DecisionProvider[] = [
    {
      id: "valid",
      version: "1",
      kind: "rule-based",
      decide: async () => candidate,
    },
    {
      id: "invalid",
      version: "1",
      kind: "llm",
      decide: async () => ({ ...candidate, confidence: 2 }),
    },
  ];

  const results = await runShadowDecisionProviders({
    providers,
    context,
    timeoutMs: 100,
    now: new Date("2026-01-01T01:20:02.000Z"),
  });

  assert.deepEqual(
    results.map(({ contextHash }) => contextHash),
    [context.contentHash, context.contentHash],
  );
  assert.equal(results[0]?.status, "accepted");
  assert.equal(results[1]?.status, "rejected");
  assert.equal(results[1]?.rejectionCode, "INVALID_CONFIDENCE");
});

test("shadow provider timeouts cannot become executable candidates", async () => {
  const provider: DecisionProvider = {
    id: "slow",
    version: "1",
    kind: "llm",
    decide: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
  const [result] = await runShadowDecisionProviders({
    providers: [provider],
    context: snapshot(),
    timeoutMs: 5,
    now: new Date("2026-01-01T01:20:02.000Z"),
  });

  assert.equal(result?.status, "timeout");
  assert.equal(result?.candidate, null);
  assert.equal(result?.rejectionCode, "PROVIDER_TIMEOUT");
});
