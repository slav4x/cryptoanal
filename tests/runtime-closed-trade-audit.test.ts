import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import type {
  ExecutionPosition,
  ExecutionSettlement,
} from "../packages/application/src/execution-engine";
import { executionEngineVersion } from "../packages/application/src/index";
import { hashTracePayload } from "../packages/persistence/src/position-trace";
import type { ArchivedPriceEvent } from "../packages/persistence/src/price-archive-codec";
import { processRuntimePriceEvents } from "../apps/worker/src/runtime-price-processor";
import { runtimeTraceInputs } from "../apps/worker/src/runtime-trace";
import {
  auditClosedTrade,
  auditJson,
  AuditSourceUnavailable,
  type ClosedTradeAuditSource,
} from "../apps/worker/src/closed-trade-audit";
import { captureAuditEvidence, readAuditEvidence } from "../scripts/lib/trade-audit-evidence";
import {
  defaultEntryLiquidityPolicy,
  entryLiquidityVersion,
  evaluateExecutionEntryOrder,
  type ExecutionEntryOrder,
} from "../packages/application/src/execution-entry-liquidity";
import { defaultLiquidityExitPolicy } from "../packages/application/src/execution-exit-policy";

const at = new Date("2026-10-17T00:00:00Z");
async function example(side: "long" | "short" = "long") {
  const config = strategyConfigSchema.parse({
    ...fixture.config,
    exit: { stopLossPercent: 3, takeProfitPercent: 9, trailingStopPercent: 0 },
    costs: { makerFeeBps: 0, takerFeeBps: 0, slippageBps: 0 },
  });
  const policy = {
    enabledAt: at.toISOString(),
    breakEvenActivationR: 0.5,
    trailingActivationR: 1,
    trailingDistanceR: 0.5,
  };
  const position: ExecutionPosition = {
    symbol: "BTCUSDT",
    side,
    entryRegime: "neutral",
    entrySession: "asia",
    openedAt: at,
    entryPrice: 100,
    quantity: 1,
    stopPrice: side === "long" ? 97 : 103,
    takePrice: side === "long" ? 109 : 91,
    trailingPrice: null,
    bestPrice: 100,
    entryFee: 0,
    entrySlippage: 0,
  };
  const events: ArchivedPriceEvent[] = [100, side === "long" ? 104 : 96, 100].map((price, i) => ({
    id: BigInt(i + 1),
    symbol: "BTCUSDT",
    eventKey: String(i + 1),
    price: String(price),
    streamId: "same",
    observedAt: new Date(+at + i * 1000),
    receivedAt: new Date(+at + i * 1000),
  }));
  const snapshot = auditJson({
    version: 1,
    positionId: "p",
    executionEngineVersion,
    config,
    eventId: "1",
    streamId: "same",
    throughAt: at.toISOString(),
    markPrice: "100",
    signalCandleAt: null,
    profitProtectionState: null,
    profitProtectionPolicy: policy,
    funding: { status: "disabled" },
    position: {
      ...position,
      side: side === "long" ? "BUY" : "SELL",
      entryRegime: "NEUTRAL",
      entrySession: "ASIA",
      openedAt: at.toISOString(),
      entryPrice: "100",
      quantity: "1",
      stopPrice: String(position.stopPrice),
      takePrice: String(position.takePrice),
      bestPrice: "100",
      entryFee: "0",
      entrySlippage: "0",
    },
  });
  const records: NonNullable<ClosedTradeAuditSource["trace"]>["records"] = [];
  let ending = position;
  let settlement: ExecutionSettlement | null = null;
  await processRuntimePriceEvents({
    position,
    through: at,
    streamId: "same",
    config,
    profitProtection: { policy, state: null },
    events: events.slice(1).map((e) => ({ ...e, price: Number(e.price) })),
    recover: async () => {
      throw new Error("Unexpected fixture recovery");
    },
    checkpoint: async (c) => {
      ending = c.position;
      settlement = c.settlement;
      const payload = auditJson({
        quotePrice: String(c.markPrice),
        quoteAt: c.through.toISOString(),
        signalCandleAt: c.signalCandleAt?.toISOString() ?? null,
        profitProtectionState: c.profitProtectionState ?? null,
        inputs: runtimeTraceInputs({ firstEventId: 2n, policy, signals: [], recoveries: [] }),
        action: c.settlement
          ? {
              kind: "close",
              settlement: c.settlement,
              protection: {
                bestPrice: String(c.position.bestPrice),
                stopPrice: String(c.position.stopPrice),
                trailingPrice:
                  c.position.trailingPrice === null ? null : String(c.position.trailingPrice),
              },
            }
          : {
              kind: "update",
              bestPrice: String(c.position.bestPrice),
              stopPrice: String(c.position.stopPrice),
              trailingPrice:
                c.position.trailingPrice === null ? null : String(c.position.trailingPrice),
            },
      });
      records.push({
        id: String(records.length + 1),
        eventId: String(c.event.id),
        kind: "journal",
        payload,
        payloadHash: hashTracePayload(payload),
      });
      return true;
    },
  });
  assert.ok(settlement);
  const closed = settlement as ExecutionSettlement;
  const buySell = side === "long" ? "BUY" : "SELL",
    opposite = side === "long" ? "SELL" : "BUY";
  const fill = (id: string, price: string, filledAt: string) => ({
    id,
    quantity: "1",
    price,
    fee: "0",
    filledAt,
    execution: null,
    realizedGrossPnl: null,
    realizedNetPnl: null,
    entryFeeAllocated: null,
    fundingAllocated: null,
  });
  const source: ClosedTradeAuditSource = {
    asOf: new Date(+at + 10000).toISOString(),
    config,
    configHash: "config",
    run: {
      id: "r",
      strategyVersionId: "v",
      configHash: "config",
      engineVersion: executionEngineVersion,
      executionPolicy: null,
    },
    position: {
      id: "p",
      workspaceId: "w",
      executionRunId: "r",
      strategyVersionId: "v",
      symbol: "BTCUSDT",
      side: buySell,
      status: "CLOSED",
      quantity: "1",
      entryPrice: "100",
      stopPrice: String(ending.stopPrice),
      takePrice: String(ending.takePrice),
      trailingPrice: ending.trailingPrice === null ? null : String(ending.trailingPrice),
      entryFee: "0",
      entrySlippage: "0",
      realizedPnl: String(closed.netPnl),
      openedAt: at.toISOString(),
      closedAt: closed.closedAt,
      createdAt: at.toISOString(),
      executionPolicy: null,
      positionExitPolicy: null,
      instrumentRules: null,
      entryExecution: null,
      exitPolicy: null,
      exitState: null,
      fundingPolicy: null,
    },
    trade: {
      id: "t",
      positionId: "p",
      executionRunId: "r",
      strategyVersionId: "v",
      symbol: "BTCUSDT",
      side: buySell,
      quantity: "1",
      averageEntryPrice: "100",
      averageExitPrice: String(closed.exitPrice),
      grossPnl: String(closed.grossPnl),
      fees: String(closed.fees),
      funding: "0",
      netPnl: String(closed.netPnl),
      slippage: String(closed.slippage),
      exitReason: closed.exitReason,
      openedAt: at.toISOString(),
      closedAt: closed.closedAt,
    },
    orders: [
      {
        id: "in",
        positionId: "p",
        side: buySell,
        type: "MARKET",
        status: "FILLED",
        quantity: "1",
        execution: null,
        fills: [fill("entry", "100", at.toISOString())],
      },
      {
        id: "out",
        positionId: "p",
        side: opposite,
        type: "MARKET",
        status: "FILLED",
        quantity: "1",
        execution: null,
        fills: [fill("exit", String(closed.exitPrice), closed.closedAt)],
      },
    ],
    payments: [],
    signals: [],
    entryDecisions: [],
    trace: {
      snapshot,
      snapshotHash: hashTracePayload(snapshot),
      fullFromEntry: true,
      startEventId: "1",
      endEventId: "3",
      eventCount: "2",
      retainUntil: null,
      records,
    },
  };
  const loaders = {
    events: async (cursor: bigint, through: bigint) =>
      events.filter((e) => e.id > cursor && e.id <= through),
    funding: async () => null,
  };
  return { source, events, loaders };
}
const check = (result: Awaited<ReturnType<typeof auditClosedTrade>>, id: string) =>
  result.checks.find((c) => c.id === id)!;
async function entryExample() {
  const x = await example(),
    p = x.source.position,
    order = x.source.orders[0]!,
    fill = order.fills[0]!;
  x.source.trace = null;
  const rules = {
    version: 1 as const,
    symbol: "BTCUSDT",
    observedAt: at.toISOString(),
    tickSize: "0.01",
    qtyStep: "0.01",
    minOrderQty: "0.01",
    minNotional: "5",
    minPrice: "0.01",
    maxPrice: "1000000",
    maxOrderQty: "1000",
    maxMarketOrderQty: "1000",
  };
  const snapshot: ExecutionEntryOrder = {
    version: entryLiquidityVersion,
    symbol: "BTCUSDT",
    side: "long",
    timeInForce: "IOC",
    quantity: "3",
    limitPrice: null,
    signalPrice: "100",
    decisionPrice: "100",
    submitReferencePrice: "100.05",
    submittedAt: new Date(+at - 1000).toISOString(),
    expiresAt: new Date(+at + 1000).toISOString(),
    submitEventId: "1",
    streamId: "same",
    policy: defaultEntryLiquidityPolicy,
    instrumentRules: rules,
    placementData: [
      1,
      "0.01",
      "Sell",
      false,
      false,
      ["99.95", "10", "100.05", "10", +at - 1001, +at - 1001, "10", "20"],
    ],
  };
  const event = {
    id: 2n,
    symbol: "BTCUSDT",
    price: 100,
    observedAt: at,
    receivedAt: new Date(+at + 100),
    streamId: "same",
    executionData: [
      1,
      "0.01",
      "Sell",
      false,
      false,
      ["99.95", "10", "100.05", "1", +at - 1, +at - 1, "11", "21"],
    ],
  };
  const result = evaluateExecutionEntryOrder(snapshot, event);
  assert.equal(result.kind, "fill");
  if (result.kind !== "fill") throw Error("Fixture entry failed");
  const payload = auditJson({
    version: entryLiquidityVersion,
    source: "dry-run-public-liquidity-model",
    orderId: order.id,
    role: result.role,
    sourceKey: result.sourceKey,
    sourceCapacity: result.sourceCapacity,
    consumedQuantity: "0",
    publicConsumedQuantity: "0",
    event: { ...event, id: "2", price: "100" },
  });
  fill.price = result.price;
  fill.execution = { payload, hash: hashTracePayload(payload) };
  order.quantity = "3";
  order.status = "CANCELLED";
  order.execution = {
    snapshot,
    hash: hashTracePayload(snapshot),
    terminal: { filledQuantity: "1", cancelledQuantity: "2" },
  };
  p.entryPrice = result.price;
  p.entryExecution = { version: entryLiquidityVersion, orderId: order.id, requestedQuantity: "3" };
  p.instrumentRules = rules;
  x.source.trade.averageEntryPrice = result.price;
  x.source.trade.grossPnl = "-0.05";
  x.source.trade.netPnl = "-0.05";
  p.realizedPnl = "-0.05";
  x.source.signals = [
    {
      id: "signal",
      metadata: { status: "SIGNAL", observedAt: new Date(+at - 1500).toISOString() },
    },
  ];
  x.source.entryDecisions = [{ id: "open", decidedAt: new Date(+at + 200).toISOString() }];
  return x;
}
for (const side of ["long", "short"] as const)
  test(`${side}: full original replay passes verified checks, unavailable admission stays unknown`, async () => {
    const x = await example(side),
      result = await auditClosedTrade(x.source, x.loaders);
    assert.equal(
      check(result, "recorded-replay").outcome,
      "pass",
      JSON.stringify(check(result, "recorded-replay")),
    );
    assert.equal(check(result, "initial-protection").outcome, "pass");
    assert.equal(check(result, "settlement").outcome, "pass");
    assert.equal(check(result, "admission").outcome, "unknown");
    assert.equal(result.path.complete, true);
    assert.equal(result.cases.find((c) => c.caseId === "break-even")?.applicability, "yes");
    assert.equal(result.status, "insufficient-data");
    assert.deepEqual(result, await auditClosedTrade(x.source, x.loaders));
  });
test("missing original trace is not a zero path or a successful lifecycle verification", async () => {
  const x = await example();
  x.source.trace = null;
  const r = await auditClosedTrade(x.source, x.loaders);
  assert.equal(r.status, "insufficient-data");
  assert.equal(r.path.complete, false);
  assert.equal(check(r, "settlement").outcome, "pass");
  assert.equal(check(r, "recorded-replay").outcome, "unknown");
});
test("partial entry receipts pass while a persist at the exact TTL is rejected", async () => {
  const x = await entryExample();
  const valid = await auditClosedTrade(x.source, x.loaders);
  assert.equal(
    check(valid, "entry-fill").outcome,
    "pass",
    JSON.stringify(check(valid, "entry-fill")),
  );
  assert.equal(check(valid, "entry-timing").outcome, "pass");
  assert.equal(check(valid, "entry-finality").outcome, "pass");
  assert.equal(valid.cases.find((c) => c.caseId === "partial-entry")?.applicability, "yes");
  x.source.entryDecisions[0]!.decidedAt = new Date(+at + 1000).toISOString();
  assert.equal(check(await auditClosedTrade(x.source, x.loaders), "entry-timing").outcome, "fail");
});
test("a valid fill received before original signal availability is rejected", async () => {
  const x = await entryExample();
  x.source.signals[0]!.metadata = {
    status: "SIGNAL",
    observedAt: new Date(+at + 101).toISOString(),
  };
  assert.equal(
    check(await auditClosedTrade(x.source, x.loaders), "entry-finality").outcome,
    "fail",
  );
});
test("partial exit quantities conserve the original position and exact decimal net cannot hide dust", async () => {
  const x = await example();
  x.source.trace = null;
  x.source.position.exitPolicy = defaultLiquidityExitPolicy;
  const first = x.source.orders[1]!.fills[0]!;
  first.quantity = "0.4";
  first.realizedGrossPnl = "0";
  x.source.orders[1]!.fills.push({ ...first, id: "exit2", quantity: "0.6" });
  const valid = await auditClosedTrade(x.source, x.loaders);
  assert.equal(check(valid, "fill-ledger").outcome, "pass");
  assert.equal(check(valid, "trade-accounting").outcome, "pass");
  assert.equal(valid.cases.find((c) => c.caseId === "partial-exit")?.applicability, "yes");
  x.source.trade.netPnl = "0.000000000000000001";
  assert.equal(
    check(await auditClosedTrade(x.source, x.loaders), "trade-accounting").outcome,
    "fail",
  );
});
test("funding column comparisons use exact decimal values rather than string padding", async () => {
  const x = await example();
  x.source.trace = null;
  const event = {
    symbol: "BTCUSDT",
    settledAt: new Date(Math.ceil((+at + 1) / 60000) * 60000).toISOString(),
    rate: "0.00000000",
    markPrice: "100.000",
    markInterval: "1",
  };
  const payload = { positionId: "p", event, quantity: "1.000", amount: "0.00000000" };
  x.source.payments = [
    {
      id: "pay",
      settledAt: event.settledAt,
      amount: "0",
      quantity: "1",
      rate: "0",
      markPrice: "100",
      execution: { payload, hash: hashTracePayload(payload) },
    },
  ];
  assert.equal(
    check(await auditClosedTrade(x.source, x.loaders), "funding-payments").outcome,
    "pass",
  );
});
test("lost stop touch followed by a rebound is detected from original intrabar events", async () => {
  const x = await example();
  x.events[1]!.price = "96";
  const r = await auditClosedTrade(x.source, x.loaders);
  assert.equal(check(r, "recorded-replay").outcome, "fail");
  assert.equal(r.status, "violation");
});
test("a checksum-valid but incorrect stop movement is still rejected by original replay", async () => {
  const x = await example(),
    record = x.source.trace!.records[0]!;
  const payload = record.payload as { action: { protection: { stopPrice: string } } };
  payload.action.protection.stopPrice = "90";
  record.payloadHash = hashTracePayload(record.payload);
  const r = await auditClosedTrade(x.source, x.loaders);
  assert.equal(check(r, "recorded-replay").outcome, "fail");
});
test("duplicate fills are a proven local violation even without original path", async () => {
  const x = await example();
  x.source.trace = null;
  x.source.orders[0]!.fills.push(x.source.orders[0]!.fills[0]!);
  const r = await auditClosedTrade(x.source, x.loaders);
  assert.equal(check(r, "fill-ledger").outcome, "fail");
  assert.equal(r.status, "violation");
});
test("duplicate funding rows cannot cancel out or count as independent payments", async () => {
  const x = await example();
  x.source.payments = [
    { id: "one", settledAt: at.toISOString(), amount: "0" },
    { id: "one", settledAt: at.toISOString(), amount: "0" },
  ];
  assert.equal(
    check(await auditClosedTrade(x.source, x.loaders), "funding-payments").outcome,
    "fail",
  );
});
test("slippage is not subtracted twice and corrupted net PnL is reported", async () => {
  const x = await example();
  x.source.trade.slippage = "1";
  assert.equal(
    check(await auditClosedTrade(x.source, x.loaders), "trade-accounting").outcome,
    "pass",
  );
  x.source.trade.netPnl = "-1";
  x.source.position.realizedPnl = "-1";
  assert.equal(
    check(await auditClosedTrade(x.source, x.loaders), "trade-accounting").outcome,
    "fail",
  );
});
test("missing prefix and missing tail remain insufficient even when accounting matches", async () => {
  const x = await example();
  x.source.trace!.fullFromEntry = false;
  assert.equal((await auditClosedTrade(x.source, x.loaders)).path.complete, false);
  x.source.trace!.fullFromEntry = true;
  x.events.pop();
  const r = await auditClosedTrade(x.source, x.loaders);
  assert.equal(check(r, "recorded-replay").outcome, "unknown");
  assert.equal(r.status, "insufficient-data");
});
test("initial stop is checked against the original config, not only its self-consistent hash", async () => {
  const x = await example();
  const snapshot = x.source.trace!.snapshot as { position: { stopPrice: string } };
  snapshot.position.stopPrice = "90";
  x.source.trace!.snapshotHash = hashTracePayload(snapshot);
  assert.equal(
    check(await auditClosedTrade(x.source, x.loaders), "initial-protection").outcome,
    "fail",
  );
});
test("trace checksum corruption is a violation; bounded source exhaustion stays unknown", async () => {
  const x = await example();
  x.source.trace!.snapshotHash = "bad";
  assert.equal(
    check(await auditClosedTrade(x.source, x.loaders), "trace-integrity").outcome,
    "fail",
  );
  x.source.trace!.snapshotHash = hashTracePayload(x.source.trace!.snapshot);
  const r = await auditClosedTrade(x.source, {
    ...x.loaders,
    events: async () => {
      throw new AuditSourceUnavailable("AUDIT_EVENT_BUDGET_EXCEEDED");
    },
  });
  assert.equal(check(r, "recorded-replay").outcome, "unknown");
});
test("captured evidence reproduces the same result without database and detects altered gzip/source", async () => {
  const root = await mkdtemp(join(tmpdir(), "trade-audit-"));
  try {
    const x = await example(),
      capture = await captureAuditEvidence(root, x.source, x.loaders);
    const original = await auditClosedTrade(x.source, capture.loaders),
      manifest = await capture.finish();
    const saved = await readAuditEvidence(root, manifest.hash);
    assert.deepEqual(await auditClosedTrade(saved.source, saved.loaders), original);
    const gzip = join(root, "events-0.gz"),
      bytes = await readFile(gzip);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(gzip, bytes);
    const bad = await auditClosedTrade(saved.source, saved.loaders);
    assert.equal(check(bad, "recorded-replay").outcome, "fail");
    const source = JSON.parse(await readFile(join(root, "source.json"), "utf8"));
    source.trade.netPnl = "123";
    await writeFile(join(root, "source.json"), JSON.stringify(source));
    await assert.rejects(readAuditEvidence(root, manifest.hash), /source checksum/);
  } finally {
    await rm(root, { recursive: true });
  }
});
test("evidence budget outcomes are reproducible and cannot become a confirmed path", async () => {
  const root = await mkdtemp(join(tmpdir(), "trade-audit-budget-"));
  try {
    const x = await example(),
      capture = await captureAuditEvidence(root, x.source, x.loaders, 0);
    const original = await auditClosedTrade(x.source, capture.loaders),
      manifest = await capture.finish();
    const saved = await readAuditEvidence(root, manifest.hash);
    assert.deepEqual(await auditClosedTrade(saved.source, saved.loaders), original);
    assert.equal(original.path.complete, false);
  } finally {
    await rm(root, { recursive: true });
  }
});
test("database read failures stay unknown and saved funding failures replay without a database", async () => {
  const x = await example();
  const failure = () => Object.assign(new Error("network read failed"), { code: "ETIMEDOUT" });
  const result = await auditClosedTrade(x.source, {
    ...x.loaders,
    events: async () => {
      throw failure();
    },
  });
  assert.equal(check(result, "recorded-replay").outcome, "unknown");
  const root = await mkdtemp(join(tmpdir(), "trade-audit-read-failure-"));
  try {
    const capture = await captureAuditEvidence(root, x.source, {
      ...x.loaders,
      funding: async () => {
        throw failure();
      },
    });
    await assert.rejects(capture.loaders.funding("source"), /FUNDING_SOURCE_READ_UNAVAILABLE/);
    const manifest = await capture.finish(),
      saved = await readAuditEvidence(root, manifest.hash);
    await assert.rejects(saved.loaders.funding("source"), /FUNDING_SOURCE_READ_UNAVAILABLE/);
  } finally {
    await rm(root, { recursive: true });
  }
});
