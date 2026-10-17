import assert from "node:assert/strict";
import { replayRuntimeTrace } from "../apps/worker/src/runtime-trace-replay";
import { test } from "node:test";
import { defaultLiquidityExitPolicy } from "../packages/application/src/execution-exit-policy";
import {
  initialLiquidityExitState,
  prepareLiquidityExitOrder,
  liquidityExitPreparationFailure,
  evaluateLiquidityExitOrder,
  applyLiquidityExitFill,
  liquidityExitSettlement,
  remainingExitQuantity,
  readLiquidityExitState,
  type ExitPositionBasis,
} from "../packages/persistence/src/liquidity-exit-model";
import type { EntryLiquidityEvent } from "../packages/application/src/execution-entry-liquidity";

const at = Date.parse("2026-10-15T05:00:00Z");
function basis(side: "BUY" | "SELL" = "BUY"): ExitPositionBasis {
  return {
    id: "position",
    symbol: "BTCUSDT",
    side,
    quantity: "3",
    entryPrice: "100",
    entryFee: "0.18",
    entrySlippage: "0.03",
    policy: defaultLiquidityExitPolicy,
    instrumentRules: {
      version: 1,
      symbol: "BTCUSDT",
      observedAt: new Date(at).toISOString(),
      tickSize: "0.01",
      qtyStep: "0.01",
      minOrderQty: "0.1",
      minNotional: "5",
      minPrice: "0.01",
      maxPrice: "1000000",
      maxOrderQty: "1000",
      maxMarketOrderQty: "1000",
    },
  };
}
function state(p = basis()) {
  return initialLiquidityExitState(p, {
    reason: "stop-loss",
    requestedAt: new Date(at - 10).toISOString(),
    triggerAt: new Date(at - 20).toISOString(),
    triggerEventId: "1",
    triggerPrice: "99",
    source: "journal",
  });
}
function event(id = 2n, offset = 10, size = "1"): EntryLiquidityEvent {
  const t = at + offset;
  return {
    id,
    symbol: "BTCUSDT",
    price: 100,
    observedAt: new Date(t),
    receivedAt: new Date(t),
    streamId: "stream",
    executionData: [
      1,
      "0.1",
      "Buy",
      true,
      false,
      ["99.95", size, "100.05", size, t, t, String(id), String(id)],
    ],
  };
}
for (const side of ["BUY", "SELL"] as const) {
  test(`${side}: exit sells bid or buys ask and closes only L1 capacity`, () => {
    const p = basis(side),
      s = state(p),
      order = prepareLiquidityExitOrder(p, s, event(2n, 0), new Date(at))!;
    assert.equal(order.ioc.side, side === "BUY" ? "short" : "long");
    assert.deepEqual(evaluateLiquidityExitOrder(order, event(3n, 10, "1.239")), {
      kind: "fill",
      price: side === "BUY" ? "99.95" : "100.05",
      quantity: "1.23",
      role: "taker",
      sourceKey: `stream:BTCUSDT:book:3:${side === "BUY" ? "short" : "long"}`,
      sourceCapacity: "1.239",
    });
    assert.equal(
      evaluateLiquidityExitOrder(order, event(3n, 10, "1.23"), "1", "0.23").kind,
      "cancel",
    );
    const heartbeat = event(4n, 20, "1.239");
    const data = heartbeat.executionData as { 5: string[] };
    data[5][6] = "3";
    const offered = evaluateLiquidityExitOrder(order, heartbeat);
    assert.equal(offered.kind, "fill");
    if (offered.kind === "fill") {
      assert.equal(offered.sourceKey, `stream:BTCUSDT:book:3:${side === "BUY" ? "short" : "long"}`);
      assert.equal(evaluateLiquidityExitOrder(order, heartbeat, "1.23", "0.009").kind, "cancel");
    }
    assert.deepEqual(evaluateLiquidityExitOrder(order, event(2n, 0)), {
      kind: "wait",
      reason: "EXIT_BEFORE_SUBMISSION",
    });
    assert.equal(
      evaluateLiquidityExitOrder(order, { ...event(3n, 10), streamId: "new" }).kind,
      "cancel",
    );
  });
  test(`${side}: exact accounting allocates entry fee once and aggregates weighted exit`, () => {
    const p = basis(side);
    let s = state(p);
    s = applyLiquidityExitFill(p, s, "99.95", "1.23", 6, "100").state;
    assert.equal(remainingExitQuantity(s), "1.77");
    assert.equal(s.entryFeesAllocated, "0.0738");
    assert.throws(() => liquidityExitSettlement(s, new Date(at)), /not fully/);
    s = applyLiquidityExitFill(p, s, "100.05", "1.77", 6, "100").state;
    const result = liquidityExitSettlement(s, new Date(at + 20));
    assert.equal(result.exitPrice, "100.009");
    assert.equal(result.fees, "0.3600162");
    assert.equal(result.grossPnl, side === "BUY" ? "0.027" : "-0.027");
    assert.equal(result.netPnl, side === "BUY" ? "-0.3330162" : "-0.3870162");
    assert.equal(result.slippage, "0.18");
    assert.equal(s.entryFeesAllocated, p.entryFee);
  });
}
test("exit placement requires a fresh causal book and spread within its pinned bound", () => {
  const p = basis(),
    s = state(p),
    e = event(2n, 0);
  assert.equal(
    liquidityExitPreparationFailure(p, s, { ...e, executionData: undefined }, new Date(at)),
    "EXIT_BOOK_UNAVAILABLE",
  );
  assert.equal(liquidityExitPreparationFailure(p, s, e, new Date(at + 1001)), "EXIT_BOOK_STALE");
  assert.equal(
    liquidityExitPreparationFailure(
      p,
      s,
      {
        ...e,
        executionData: [1, "1", "Buy", false, false, ["90", "1", "110", "1", at, at, "2", "2"]],
      },
      new Date(at),
    ),
    "EXIT_SPREAD_LIMIT",
  );
  assert.equal(
    prepareLiquidityExitOrder(p, s, e, new Date(at))!.ioc.submittedAt,
    new Date(at).toISOString(),
  );
});
test("an event received while IOC was alive stays executable after processing delay; late receipt cancels", () => {
  const p = basis(),
    order = prepareLiquidityExitOrder(p, state(p), event(2n, 0), new Date(at))!;
  assert.equal(evaluateLiquidityExitOrder(order, event(3n, 10)).kind, "fill");
  assert.equal(
    evaluateLiquidityExitOrder(order, { ...event(3n, 10), receivedAt: new Date(at + 5000) }).kind,
    "cancel",
  );
  assert.equal(evaluateLiquidityExitOrder(order, event(3n, 5000)).kind, "cancel");
  assert.equal(evaluateLiquidityExitOrder(order, event(3n, -1)).kind, "wait");
  const prebook = event(3n, 10);
  (prebook.executionData as unknown[])[5] = ["99.95", "1", "100.05", "1", at - 1, at - 1, "3", "3"];
  assert.equal(evaluateLiquidityExitOrder(order, prebook).kind, "wait");
});
test("reduce-only residual may be below entry minimum and is split by market maximum", () => {
  const p = basis(),
    s = { ...state(p), closedQuantity: "2.98", entryFeesAllocated: "0.1788" };
  assert.equal(prepareLiquidityExitOrder(p, s, event(2n, 0), new Date(at))!.ioc.quantity, "0.02");
  p.instrumentRules.maxMarketOrderQty = "0.5";
  assert.equal(
    prepareLiquidityExitOrder(p, state(p), event(2n, 0), new Date(at))!.ioc.quantity,
    "0.5",
  );
});
test("rounding leaves the exact entry-fee residual for the final fill", () => {
  const p = basis();
  p.entryFee = "0.000000000000000001";
  let s = state(p);
  for (let i = 0; i < 3; i++) s = applyLiquidityExitFill(p, s, "100", "1", 0, "100").state;
  assert.equal(s.entryFeesAllocated, p.entryFee);
  assert.equal(s.netPnl, "-0.000000000000000001");
  assert.throws(() => applyLiquidityExitFill(p, s, "100", "0.01", 0, "100"), /quantity/);
  assert.throws(() => readLiquidityExitState({ ...s, exitFees: "-1" }), /Negative/);
});

test("a liquidity trace with lost intent cannot pass as legacy execution", async () => {
  await assert.rejects(
    replayRuntimeTrace({
      snapshot: { position: { exitPolicy: defaultLiquidityExitPolicy } },
      snapshotHash: "",
      fullFromEntry: true,
      startEventId: 1n,
      endEventId: 1n,
      expectedEventCount: 0n,
      records: [{ eventId: 1n, kind: "liquidity-step", payload: {}, payloadHash: "" }],
      loadEvents: async () => [],
      trade: null,
    }),
    /trigger missing/,
  );
});
