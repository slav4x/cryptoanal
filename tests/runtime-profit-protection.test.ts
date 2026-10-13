import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  applyExecutionProfitProtection,
  readExecutionProfitProtectionState,
  evaluateExecutionPriceExit,
  executionUnrealizedPnl,
  type ExecutionPosition,
  type ExecutionProfitProtectionState,
} from "../packages/application/src/index";
import { processRuntimePriceEvents } from "../apps/worker/src/runtime-price-processor";

const config = strategyConfigSchema.parse({
  ...fixture.config,
  exit: { stopLossPercent: 3, takeProfitPercent: 9, trailingStopPercent: 0 },
});
const at = new Date("2026-10-12T07:22:00Z");
const policy = {
  enabledAt: at.toISOString(),
  breakEvenActivationR: 0.5,
  trailingActivationR: 1,
  trailingDistanceR: 0.5,
};
function position(side: "long" | "short" = "long"): ExecutionPosition {
  return {
    symbol: "ETHUSDT",
    side,
    openedAt: new Date(+at - 86400000),
    entryPrice: 100,
    quantity: 10,
    stopPrice: side === "long" ? 97 : 103,
    takePrice: side === "long" ? 109 : 91,
    trailingPrice: null,
    bestPrice: side === "long" ? 106 : 94,
    entryFee: 0.6,
    entrySlippage: 0,
    entryRegime: "neutral",
    entrySession: "us",
  };
}
function quote(price: number, offset = 0) {
  return { symbol: "ETHUSDT", price, observedAt: new Date(+at + offset) };
}

for (const side of ["long", "short"] as const) {
  test(`${side}: historical peak cannot activate new protection; restart retains only new observations`, () => {
    const initial = position(side);
    const before = applyExecutionProfitProtection(initial, quote(100, -1), config, policy, null);
    assert.equal(before.state, null);
    const started = applyExecutionProfitProtection(initial, quote(100), config, policy, null);
    assert.equal(started.position.stopPrice, initial.stopPrice);
    assert.equal(started.position.trailingPrice, null);
    assert.equal(started.state!.bestPrice, 100);
    const grown = applyExecutionProfitProtection(
      started.position,
      quote(side === "long" ? 104 : 96, 1000),
      config,
      policy,
      readExecutionProfitProtectionState(JSON.parse(JSON.stringify(started.state))),
    );
    assert.ok(grown.position.trailingPrice);
    assert.equal(grown.position.bestPrice, initial.bestPrice);
    const exitPrice = side === "long" ? 102 : 98;
    const settlement = evaluateExecutionPriceExit(grown.position, quote(exitPrice, 2000), config);
    assert.ok(settlement);
    assert.equal(settlement.exitReason, "trailing-stop");
    assert.ok(settlement.netPnl > 0);
    assert.ok(executionUnrealizedPnl(grown.position, exitPrice) > settlement.netPnl);
  });
  test(`${side}: break-even includes costs and protection never weakens`, () => {
    const started = applyExecutionProfitProtection(
      position(side),
      quote(side === "long" ? 102 : 98),
      config,
      policy,
      null,
    );
    assert.equal(started.position.trailingPrice, null);
    assert.ok(
      side === "long" ? started.position.stopPrice > 100 : started.position.stopPrice < 100,
    );
    const settlement = evaluateExecutionPriceExit(
      started.position,
      quote(started.position.stopPrice, 1000),
      config,
    )!;
    assert.ok(Math.abs(settlement.netPnl) < 0.00001);
    const grown = applyExecutionProfitProtection(
      started.position,
      quote(side === "long" ? 104 : 96, 2000),
      config,
      policy,
      started.state,
    );
    const next = applyExecutionProfitProtection(
      grown.position,
      quote(side === "long" ? 103 : 97, 3000),
      config,
      policy,
      grown.state,
    );
    assert.equal(next.position.trailingPrice, grown.position.trailingPrice);
    assert.equal(next.position.stopPrice, grown.position.stopPrice);
    assert.equal(
      applyExecutionProfitProtection(next.position, quote(100, 4000), config, null, next.state)
        .position.trailingPrice,
      next.position.trailingPrice,
    );
  });
}

test("changed policy resets only its peak, without loosening existing protection", () => {
  const first = applyExecutionProfitProtection(position(), quote(105), config, policy, null);
  const next = applyExecutionProfitProtection(
    first.position,
    quote(104),
    config,
    { ...policy, enabledAt: new Date(+at + 1000).toISOString() },
    first.state,
  );
  assert.equal(next.state, first.state);
  const activated = applyExecutionProfitProtection(
    first.position,
    quote(104, 1000),
    config,
    { ...policy, enabledAt: new Date(+at + 1000).toISOString() },
    first.state,
  );
  assert.equal(activated.state!.bestPrice, 104);
  assert.equal(activated.position.trailingPrice, first.position.trailingPrice);
});

test("invalid checkpoint and activation parameters fail closed", () => {
  assert.throws(() => readExecutionProfitProtectionState({ version: 1, bestPrice: 0 }), /Invalid/);
  assert.throws(
    () =>
      applyExecutionProfitProtection(
        position(),
        quote(104),
        config,
        { ...policy, trailingDistanceR: 2 },
        null,
      ),
    /Invalid/,
  );
});

test("journal checkpoint persists protection together with price progress and resumes after JSON restart", async () => {
  let current = position();
  let state: ExecutionProfitProtectionState | null = null;
  let through = at;
  let closed = false;
  for (const [index, price] of [100, 104, 102].entries()) {
    const event = {
      ...quote(price, index * 1000),
      id: BigInt(index + 1),
      streamId: "same",
      receivedAt: new Date(+at + index * 1000),
    };
    await processRuntimePriceEvents({
      position: current,
      through,
      streamId: "same",
      events: [event],
      config,
      profitProtection: { policy, state },
      recover: async () => {
        throw new Error("continuous journal must not use OHLC");
      },
      checkpoint: async (checkpoint) => {
        state = readExecutionProfitProtectionState(
          JSON.parse(JSON.stringify(checkpoint.profitProtectionState)),
        );
        current = checkpoint.position;
        through = checkpoint.through;
        if (checkpoint.settlement) {
          assert.equal(checkpoint.settlement.exitReason, "trailing-stop");
          assert.ok(checkpoint.settlement.netPnl > 0);
          closed = true;
        }
        return true;
      },
    });
  }
  assert.equal(closed, true);
});

test("stream recovery failure commits the protected prefix without advancing the new peak", async () => {
  const checkpoints: Array<{ bestPrice: number; through: Date }> = [];
  await assert.rejects(
    processRuntimePriceEvents({
      position: position(),
      through: at,
      streamId: "first",
      config,
      profitProtection: { policy, state: null },
      events: [104, 105].map((price, index) => ({
        ...quote(price, index * 1000),
        id: BigInt(index + 1),
        streamId: index === 0 ? "first" : "reconnected",
        receivedAt: new Date(+at + index * 1000),
      })),
      recover: async () => {
        throw new Error("incomplete gap history");
      },
      checkpoint: async (state) => {
        checkpoints.push({
          bestPrice: state.profitProtectionState!.bestPrice,
          through: state.through,
        });
        return true;
      },
    }),
    /incomplete gap history/,
  );
  assert.deepEqual(checkpoints, [{ bestPrice: 104, through: at }]);
});

test("high costs postpone new protective levels until their exit covers fees and slippage", () => {
  const expensive = { ...config, costs: { makerFeeBps: 100, takerFeeBps: 100, slippageBps: 500 } };
  for (const side of ["long", "short"] as const) {
    const guarded = applyExecutionProfitProtection(
      position(side),
      quote(side === "long" ? 104 : 96),
      expensive,
      policy,
      null,
    );
    assert.equal(guarded.position.stopPrice, position(side).stopPrice);
    assert.equal(guarded.position.trailingPrice, null);
  }
});
