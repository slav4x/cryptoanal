import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  defaultEntryLiquidityPolicy,
  entryLiquidityVersion,
  entryPostOnlyCrosses,
  evaluateExecutionEntryOrder,
  readExecutionEntryOrder,
  type ExecutionEntryOrder,
  type EntryLiquidityEvent,
} from "../packages/application/src/execution-entry-liquidity";
import {
  openExecutionPositionAtFill,
  evaluateExecutionPriceExit,
} from "../packages/application/src/execution-engine";
import { executionInstrumentSizeFailure } from "../packages/application/src/execution-instrument";

const at = Date.parse("2026-10-15T01:00:00Z");
function order(
  side: "long" | "short" = "long",
  type: "IOC" | "PostOnly" = "IOC",
): ExecutionEntryOrder {
  return {
    version: entryLiquidityVersion,
    symbol: "BTCUSDT",
    side,
    timeInForce: type,
    quantity: "3",
    limitPrice: type === "PostOnly" ? "100" : null,
    signalPrice: "100",
    decisionPrice: "100",
    submitReferencePrice: side === "long" ? "100.05" : "99.95",
    submittedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 60000).toISOString(),
    submitEventId: "1",
    streamId: "stream",
    policy: defaultEntryLiquidityPolicy,
    instrumentRules: {
      version: 1,
      symbol: "BTCUSDT",
      observedAt: new Date(at).toISOString(),
      tickSize: "0.01",
      qtyStep: "0.01",
      minOrderQty: "0.01",
      minNotional: "5",
      minPrice: "0.01",
      maxPrice: "1000000",
      maxOrderQty: "1000",
      maxMarketOrderQty: "1000",
    },
    placementData: [
      1,
      "0.01",
      "Sell",
      false,
      false,
      ["99.95", "10", "100.05", "10", at - 1, at - 1, "10", "20"],
    ],
  };
}
function event(side: "long" | "short" = "long"): EntryLiquidityEvent {
  return {
    id: 2n,
    symbol: "BTCUSDT",
    price: 100,
    observedAt: new Date(at + 100),
    receivedAt: new Date(at + 200),
    streamId: "stream",
    executionData: [
      1,
      "0.01",
      side === "long" ? "Sell" : "Buy",
      false,
      false,
      ["99.95", "10", "100.05", "10", at + 99, at + 150, "11", "21"],
    ],
  };
}
for (const side of ["long", "short"] as const) {
  test(`${side}: IOC full/partial fill uses available opposing book and taker price`, () => {
    const input = order(side),
      quote = event(side);
    const full = evaluateExecutionEntryOrder(input, quote);
    assert.equal(full.kind, "fill");
    if (full.kind !== "fill") return;
    assert.equal(full.quantity, "3");
    assert.equal(full.role, "taker");
    assert.equal(full.price, side === "long" ? "100.05" : "99.95");
    const data = quote.executionData as ExecutionEntryOrder["placementData"];
    data[5]![side === "long" ? 3 : 1] = "1.239";
    const partial = evaluateExecutionEntryOrder(input, quote);
    assert.equal(partial.kind, "fill");
    if (partial.kind === "fill") assert.equal(partial.quantity, "1.23");
  });
  test(`${side}: passive touch never fills; trade-through is volume-limited and excludes special prints`, () => {
    const input = order(side, "PostOnly"),
      quote = event(side);
    assert.equal(evaluateExecutionEntryOrder(input, quote).kind, "wait");
    quote.price = side === "long" ? 99.99 : 100.01;
    const data = quote.executionData as ExecutionEntryOrder["placementData"];
    data[1] = "2";
    const fill = evaluateExecutionEntryOrder(input, quote);
    assert.equal(fill.kind, "fill");
    if (fill.kind === "fill") {
      assert.equal(fill.price, "100");
      assert.equal(fill.role, "maker");
      assert.equal(fill.quantity, "0.2");
    }
    data[3] = true;
    assert.equal(evaluateExecutionEntryOrder(input, quote).kind, "wait");
    data[3] = false;
    data[4] = true;
    assert.equal(evaluateExecutionEntryOrder(input, quote).kind, "wait");
    data[4] = false;
    data[2] = side === "long" ? "Buy" : "Sell";
    assert.equal(evaluateExecutionEntryOrder(input, quote).kind, "wait");
  });
}
test("IOC never reuses liquidity consumed by the source trade or another fill", () => {
  const quote = event();
  quote.price = 100.05;
  const data = quote.executionData as ExecutionEntryOrder["placementData"];
  data[1] = "8";
  data[2] = "Buy";
  const fill = evaluateExecutionEntryOrder(order(), quote, "0.75");
  assert.equal(fill.kind, "fill");
  if (fill.kind === "fill") assert.equal(fill.quantity, "1.25");
  assert.equal(evaluateExecutionEntryOrder(order(), quote, "2").kind, "cancel");
  assert.throws(() => evaluateExecutionEntryOrder(order(), quote, "-1"), /consumed/);
});
test("submission, both expiry clocks, stream changes and missing/stale/future books are explicit", () => {
  const input = order(),
    quote = event();
  assert.equal(evaluateExecutionEntryOrder(input, { ...quote, id: 1n }).kind, "wait");
  assert.equal(
    evaluateExecutionEntryOrder(input, { ...quote, observedAt: new Date(at - 1) }).kind,
    "wait",
  );
  assert.equal(
    evaluateExecutionEntryOrder(input, { ...quote, observedAt: new Date(at + 60000) }).kind,
    "cancel",
  );
  assert.equal(
    evaluateExecutionEntryOrder(input, { ...quote, receivedAt: new Date(at + 60000) }).kind,
    "cancel",
  );
  assert.equal(evaluateExecutionEntryOrder(input, { ...quote, streamId: "new" }).kind, "cancel");
  assert.equal(
    evaluateExecutionEntryOrder(input, { ...quote, executionData: null }).kind,
    "cancel",
  );
  assert.equal(
    evaluateExecutionEntryOrder(order("long", "PostOnly"), { ...quote, executionData: null }).kind,
    "wait",
  );
  const data = quote.executionData as ExecutionEntryOrder["placementData"];
  data[5]![4] = at + 101;
  assert.equal(evaluateExecutionEntryOrder(input, quote).kind, "cancel");
  data[5]![4] = at - 1001;
  assert.equal(evaluateExecutionEntryOrder(input, quote).kind, "cancel");
});
test("spread and slippage reject the order independently; crossing PostOnly cancels", () => {
  const input = order(),
    quote = event(),
    data = quote.executionData as ExecutionEntryOrder["placementData"];
  data[5]![0] = "99";
  assert.deepEqual(evaluateExecutionEntryOrder(input, quote), {
    kind: "cancel",
    reason: "ENTRY_SPREAD_LIMIT",
  });
  data[5]![0] = "100.55";
  data[5]![2] = "100.6";
  assert.deepEqual(evaluateExecutionEntryOrder(input, quote), {
    kind: "cancel",
    reason: "ENTRY_SLIPPAGE_LIMIT",
  });
  const passive = order("long", "PostOnly");
  passive.limitPrice = "100.05";
  assert.equal(entryPostOnlyCrosses(passive), true);
  assert.deepEqual(readExecutionEntryOrder(JSON.parse(JSON.stringify(input))), input);
  assert.throws(
    () =>
      readExecutionEntryOrder({ ...input, policy: { ...input.policy, makerParticipationBps: 0 } }),
    /policy/,
  );
});
test("partial below order minimum remains protected; fixed slippage is not added to observed fill", () => {
  const config = strategyConfigSchema.parse(fixture.config),
    rules = {
      ...order().instrumentRules,
      symbol: "DOGEUSDT",
      tickSize: "0.00001",
      qtyStep: "1",
      minOrderQty: "1",
    };
  const quote = { symbol: "DOGEUSDT", price: 0.08, observedAt: new Date(at + 100) };
  const position = openExecutionPositionAtFill({
    signal: { side: "long", signalPrice: 0.08 },
    quote,
    entryRegime: "bull",
    equity: 10000,
    maximumNotional: 1000,
    config,
    instrumentRules: rules,
    fillPrice: 0.08001,
    maximumQuantity: 1,
    entryExecution: { version: entryLiquidityVersion, orderId: "order", requestedQuantity: "100" },
  });
  assert.ok(position);
  assert.equal(position.entryPrice, 0.08001);
  assert.equal(position.quantity, 1);
  assert.equal(executionInstrumentSizeFailure(position, rules), "ENTRY_BELOW_MIN_NOTIONAL");
  assert.equal(executionInstrumentSizeFailure(position, rules, true), null);
  assert.ok(evaluateExecutionPriceExit(position, { ...quote, price: position.stopPrice }, config));
});
