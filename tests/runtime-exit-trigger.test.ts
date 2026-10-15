import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  defaultExecutionExitPolicy,
  readExecutionExitPolicy,
} from "../packages/application/src/execution-exit-policy";
import {
  evaluateExecutionPriceExit,
  type ExecutionPosition,
} from "../packages/application/src/execution-engine";
import { recoverRuntimeGap } from "../apps/worker/src/runtime-recovery";
import { processRuntimePriceEvents } from "../apps/worker/src/runtime-price-processor";
import {
  buildExitTriggerProof,
  verifyExitTriggerProof,
} from "../packages/persistence/src/exit-trigger-proof";
import { Prisma } from "../packages/persistence/src/generated/prisma/client";
import { hashTracePayload } from "../packages/persistence/src/position-trace";

const config = strategyConfigSchema.parse(fixture.config);
const at = new Date("2026-10-15T00:00:00Z");
function position(side: "long" | "short"): ExecutionPosition {
  return {
    exitPolicy: { ...defaultExecutionExitPolicy },
    symbol: "BTCUSDT",
    side,
    openedAt: new Date(+at - 60000),
    entryPrice: 100,
    quantity: 1,
    stopPrice: side === "long" ? 90 : 110,
    takePrice: side === "long" ? 120 : 80,
    trailingPrice: null,
    bestPrice: 100,
    entryFee: 0.06,
    entrySlippage: 0,
    entryRegime: "neutral",
    entrySession: "asia",
  };
}
for (const side of ["long", "short"] as const) {
  test(`${side}: pinned market TP fills from LastPrice after a gap, legacy keeps its target`, () => {
    const p = position(side),
      price = side === "long" ? 125 : 75;
    const quote = { symbol: p.symbol, price, observedAt: at, source: "LastPrice" as const };
    const result = evaluateExecutionPriceExit(p, quote, config)!;
    assert.equal(result.exitReason, "take-profit");
    assert.equal(
      result.exitPrice,
      price * (1 + ((side === "long" ? -1 : 1) * config.costs.slippageBps) / 10000),
    );
    const legacy = { ...p };
    delete legacy.exitPolicy;
    assert.equal(
      evaluateExecutionPriceExit(legacy, quote, config)!.exitPrice,
      p.takePrice * (1 + ((side === "long" ? -1 : 1) * config.costs.slippageBps) / 10000),
    );
  });
  test(`${side}: wrong or missing source cannot trigger a pinned stop or move protection`, async () => {
    const p = position(side),
      price = side === "long" ? 80 : 120;
    for (const source of [undefined, "MarkPrice", "IndexPrice"] as const)
      assert.throws(
        () =>
          evaluateExecutionPriceExit(
            p,
            { symbol: p.symbol, price, observedAt: at, ...(source ? { source } : {}) },
            config,
          ),
        /source/,
      );
    let checkpoints = 0;
    await assert.rejects(
      processRuntimePriceEvents({
        position: p,
        config,
        through: p.openedAt,
        streamId: "test",
        events: [
          {
            id: 1n,
            symbol: p.symbol,
            price,
            observedAt: at,
            receivedAt: at,
            streamId: "test",
            source: "MarkPrice",
          },
        ],
        recover: async () => {
          throw new Error("unexpected recovery");
        },
        checkpoint: async () => {
          checkpoints++;
          return true;
        },
      }),
      /source/,
    );
    assert.equal(checkpoints, 0);
  });
  test(`${side}: OHLC crossing is an uncertain recovery exit at the first known quote`, () => {
    const p = { ...position(side), openedAt: at };
    const price = side === "long" ? 115 : 85;
    const result = recoverRuntimeGap({
      position: p,
      since: at,
      quote: { symbol: p.symbol, price, observedAt: new Date(+at + 60000), source: "LastPrice" },
      minutes: [
        {
          symbol: p.symbol,
          openTime: at,
          open: 100,
          high: side === "long" ? 125 : 105,
          low: side === "long" ? 95 : 75,
          close: price,
          turnover: 1,
        },
      ],
      config,
    });
    assert.equal(result.settlement!.exitReason, "recovery-exit");
    assert.equal(result.evidence.quality, "ambiguous");
    assert.equal(result.settlement!.closedAt, new Date(+at + 60000).toISOString());
    assert.equal(
      result.settlement!.exitPrice,
      price * (1 + ((side === "long" ? -1 : 1) * config.costs.slippageBps) / 10000),
    );
    assert.deepEqual(result.position.exitPolicy, p.exitPolicy);
  });
  test(`${side}: trigger receipt validates event, level, market price and taker fee`, () => {
    const p = position(side),
      price = side === "long" ? 125 : 75;
    const result = evaluateExecutionPriceExit(
      p,
      { symbol: p.symbol, price, observedAt: at, source: "LastPrice" },
      config,
    )!;
    const settlement = {
      ...result,
      exitPrice: String(result.exitPrice),
      grossPnl: String(result.grossPnl),
      netPnl: String(result.netPnl),
      fees: String(result.fees),
      slippage: String(result.slippage),
      closedAt: at,
    };
    const proof = buildExitTriggerProof({
      position: p,
      config,
      event: {
        id: 1n,
        symbol: p.symbol,
        price: new Prisma.Decimal(price),
        observedAt: at,
        receivedAt: at,
        streamId: "test",
      },
      settlement,
    });
    const fill = {
      quantity: "1",
      price: settlement.exitPrice,
      fee: new Prisma.Decimal(settlement.fees).sub(p.entryFee).toFixed(),
      filledAt: at,
      execution: proof,
    };
    assert.equal(verifyExitTriggerProof(fill, config, p.exitPolicy).status, "matched");
    assert.equal(proof.payload.triggerLevel, String(p.takePrice));
    assert.equal(proof.payload.fillReferencePrice, String(price));
    assert.throws(
      () => verifyExitTriggerProof({ ...fill, fee: "0" }, config, p.exitPolicy),
      /fill mismatch/,
    );
    const payload = { ...proof.payload, fillReferencePrice: "999" };
    assert.throws(
      () =>
        verifyExitTriggerProof(
          { ...fill, execution: { payload, hash: hashTracePayload(payload) } },
          config,
          p.exitPolicy,
        ),
      /fill mismatch/,
    );
    assert.throws(
      () =>
        buildExitTriggerProof({
          position: p,
          config,
          event: {
            id: 1n,
            symbol: p.symbol,
            price: new Prisma.Decimal(price),
            observedAt: new Date(+at + 1),
            receivedAt: at,
            streamId: "test",
          },
          settlement,
        }),
      /precedes/,
    );
  });
}
test("exit policy rejects unsupported source and invalid trigger quote", () => {
  for (const patch of [
    { triggerSource: "MarkPrice" },
    { takeOrderType: "Limit" },
    { version: "unknown" },
  ])
    assert.throws(
      () => readExecutionExitPolicy({ ...defaultExecutionExitPolicy, ...patch }),
      /Unsupported/,
    );
  const p = position("long");
  for (const patch of [
    { price: 0 },
    { symbol: "ETHUSDT" },
    { observedAt: new Date(+p.openedAt - 1) },
  ])
    assert.throws(
      () =>
        evaluateExecutionPriceExit(
          p,
          { symbol: p.symbol, price: 100, observedAt: at, source: "LastPrice", ...patch },
          config,
        ),
      /Invalid/,
    );
});
