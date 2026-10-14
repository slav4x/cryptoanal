import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  roundExecutionStep,
  floorExecutionRatio,
  compareExecutionDecimals,
  executionDecimalProduct,
  executionDecimalSum,
  executionStepNumber,
  readExecutionInstrumentRules,
  openExecutionPositionAtQuote,
  limitExecutionPositionRisk,
  executionStopRisk,
  executionInstrumentSizeFailure,
  updateExecutionTrailingAtPrice,
  executionBreakEvenPrice,
  settleExecutionPosition,
  runValidationEngine,
  runRuntimeReplay,
  type ExecutionInstrumentRules,
  applyExecutionProfitProtection,
  roundExecutionRatio,
} from "../packages/application/src/index";
import { captureInstrumentRules } from "../packages/persistence/src/instrument-rules";

const at = new Date("2026-10-15T00:00:00Z");
const config = strategyConfigSchema.parse({
  ...fixture.config,
  risk: { ...fixture.config.risk, riskPerTradePercent: 1 },
  entry: { orderType: "market", limitOffsetBps: 0 },
  exit: {
    stopLossPercent: 2,
    takeProfitPercent: 4,
    trailingStopPercent: 0.7,
    breakEvenActivationR: 0.5,
    trailingActivationR: 1,
  },
  costs: { makerFeeBps: 2, takerFeeBps: 6, slippageBps: 2 },
});
function rules(symbol = "BTCUSDT", tickSize = "0.1", qtyStep = "0.001"): ExecutionInstrumentRules {
  return {
    version: 1,
    symbol,
    observedAt: at.toISOString(),
    tickSize,
    qtyStep,
    minOrderQty: qtyStep,
    minNotional: "5",
    maxOrderQty: "100000",
    maxMarketOrderQty: "10000",
    minPrice: tickSize,
    maxPrice: "10000000",
  };
}
test("decimal step arithmetic handles fractional steps, scientific numbers and exact budget boundaries", () => {
  assert.equal(roundExecutionStep("0.3", "0.1", "floor"), "0.3");
  assert.equal(roundExecutionStep("0.300000000000000001", "0.05", "ceil"), "0.35");
  assert.equal(roundExecutionStep(1e-8, "0.00000001", "ceil"), "0.00000001");
  assert.equal(
    roundExecutionStep("123456789012345678.15", "0.05", "floor"),
    "123456789012345678.15",
  );
  assert.equal(floorExecutionRatio("0.3", "0.1", "1"), "3");
  assert.equal(roundExecutionRatio("0.3", "0.1", "1", "ceil"), "3");
  assert.equal(floorExecutionRatio("0.299999999999999999", "0.1", "1"), "2");
  assert.equal(executionDecimalSum("1.000000000000000001", "-0.000000000000000001"), "1");
  assert.equal(executionDecimalProduct("0.1", "0.2"), "0.02");
  assert.throws(() => executionStepNumber("0.123456789123456789"), /numeric range/);
});
for (const [symbol, price, tick, step] of [
  ["BTCUSDT", 60000.03, "0.1", "0.001"],
  ["ETHUSDT", 3000.007, "0.01", "0.01"],
  ["DOGEUSDT", 0.1234567, "0.00001", "1"],
] as const)
  for (const side of ["long", "short"] as const)
    test(`${symbol} ${side}: normalized price, size and protection obey steps without exceeding risk`, () => {
      const instrument = rules(symbol, tick, step);
      const position = openExecutionPositionAtQuote(
        { side, signalPrice: price },
        { symbol, price, observedAt: at },
        "neutral",
        10000,
        10000,
        config,
        instrument,
      );
      assert.ok(position);
      assert.equal(executionInstrumentSizeFailure(position, instrument), null);
      const risk = executionStopRisk({
        ...position,
        takerFeeBps: config.costs.takerFeeBps,
        slippageBps: config.costs.slippageBps,
        tickSize: tick,
      });
      assert.ok(risk !== null && risk <= 100 + 1e-10);
      assert.ok(position.entryPrice * position.quantity + position.entryFee <= 10000);
      const limited = limitExecutionPositionRisk(position, 10000, 10000, config, 10);
      if (limited)
        assert.ok(
          executionStopRisk({ ...limited, takerFeeBps: 6, slippageBps: 2, tickSize: tick })! <=
            10 + 1e-10,
        );
      let moving = position;
      for (const multiplier of [1.04, 1.08, 1.05, 1.1]) {
        const next = updateExecutionTrailingAtPrice(
          moving,
          position.entryPrice * (side === "long" ? multiplier : 2 - multiplier),
          config,
        );
        assert.equal(executionInstrumentSizeFailure(next, instrument), null);
        assert.ok(
          side === "long" ? next.stopPrice >= moving.stopPrice : next.stopPrice <= moving.stopPrice,
        );
        if (moving.trailingPrice !== null && next.trailingPrice !== null)
          assert.ok(
            side === "long"
              ? next.trailingPrice >= moving.trailingPrice
              : next.trailingPrice <= moving.trailingPrice,
          );
        moving = next;
      }
      const breakEven = executionBreakEvenPrice(position, config);
      assert.ok(
        settleExecutionPosition(position, breakEven, at, "stop-loss", config).netPnl >= -1e-8,
      );
    });
test("limit touch uses the normalized buy/sell limit and never an unplaceable raw price", () => {
  const configured = { ...config, entry: { orderType: "limit" as const, limitOffsetBps: 0 } };
  for (const side of ["long", "short"] as const) {
    const fill = (price: number) =>
      openExecutionPositionAtQuote(
        { side, signalPrice: 100.03 },
        { symbol: "BTCUSDT", price, observedAt: at },
        "neutral",
        10000,
        10000,
        configured,
        rules(),
      );
    assert.equal(fill(side === "long" ? 100.02 : 100.05), null);
    assert.equal(fill(side === "long" ? 100 : 100.1)?.entryPrice, side === "long" ? 100 : 100.1);
  }
});
test("break-even activates at exactly one tick beyond the level without a floating-point delay", () => {
  const configured = {
    ...config,
    costs: { makerFeeBps: 0, takerFeeBps: 0, slippageBps: 0 },
    exit: { ...config.exit, breakEvenActivationR: 0.01 },
  };
  for (const side of ["long", "short"] as const) {
    const position = openExecutionPositionAtQuote(
      { side, signalPrice: 100 },
      { symbol: "BTCUSDT", price: 100, observedAt: at },
      "neutral",
      10000,
      10000,
      configured,
      rules(),
    )!;
    assert.equal(
      updateExecutionTrailingAtPrice(position, side === "long" ? 100.1 : 99.9, configured)
        .stopPrice,
      100,
    );
  }
});

test("R activation uses the normalized initial stop and exact decimal comparisons", () => {
  const configured = {
    ...config,
    costs: { makerFeeBps: 0, takerFeeBps: 0, slippageBps: 0 },
    exit: { ...config.exit, stopLossPercent: 1.23, breakEvenActivationR: 0.5 },
  };
  const position = openExecutionPositionAtQuote(
    { side: "long", signalPrice: 100.1 },
    { symbol: "BTCUSDT", price: 100.1, observedAt: at },
    "neutral",
    10000,
    10000,
    configured,
    rules(),
  )!;
  assert.equal(position.stopPrice, 98.9);
  assert.equal(updateExecutionTrailingAtPrice(position, 100.7, configured).stopPrice, 100.1);
  const shortConfig = { ...configured, exit: { ...configured.exit, stopLossPercent: 2 } };
  const short = openExecutionPositionAtQuote(
    { side: "short", signalPrice: 10.2 },
    { symbol: "BTCUSDT", price: 10.2, observedAt: at },
    "neutral",
    10000,
    10000,
    shortConfig,
    rules("BTCUSDT", "0.001"),
  )!;
  assert.equal(updateExecutionTrailingAtPrice(short, 10.098, shortConfig).stopPrice, 10.2);
});

test("profit trailing uses an absolute R distance without a percentage roundtrip adding a tick", () => {
  const configured = { ...config, costs: { makerFeeBps: 0, takerFeeBps: 0, slippageBps: 0 } };
  const policy = {
    enabledAt: at.toISOString(),
    breakEvenActivationR: 0.5,
    trailingActivationR: 1,
    trailingDistanceR: 0.5,
  };
  for (const side of ["long", "short"] as const) {
    const position = openExecutionPositionAtQuote(
      { side, signalPrice: 100 },
      { symbol: "BTCUSDT", price: 100, observedAt: at },
      "neutral",
      10000,
      10000,
      configured,
      rules(),
    )!;
    const result = applyExecutionProfitProtection(
      position,
      { symbol: "BTCUSDT", price: side === "long" ? 104 : 96, observedAt: at },
      configured,
      policy,
      null,
    );
    assert.equal(result.position.trailingPrice, side === "long" ? 103 : 97);
  }
});

test("sub-tick trailing uses the nearest valid level one tick behind the price", () => {
  const configured = {
    ...config,
    costs: { makerFeeBps: 0, takerFeeBps: 0, slippageBps: 0 },
    exit: {
      ...config.exit,
      stopLossPercent: 0.1,
      trailingStopPercent: 0.0001,
      trailingActivationR: 0,
      breakEvenActivationR: 0,
    },
  };
  const policy = {
    enabledAt: at.toISOString(),
    breakEvenActivationR: 0.5,
    trailingActivationR: 1,
    trailingDistanceR: 0.5,
  };
  for (const side of ["long", "short"] as const) {
    const position = openExecutionPositionAtQuote(
      { side, signalPrice: 100 },
      { symbol: "BTCUSDT", price: 100, observedAt: at },
      "neutral",
      10000,
      10000,
      configured,
      rules(),
    )!;
    const price = side === "long" ? 100.1 : 99.9;
    assert.equal(updateExecutionTrailingAtPrice(position, price, configured).trailingPrice, 100);
    assert.equal(
      applyExecutionProfitProtection(
        position,
        { symbol: "BTCUSDT", price, observedAt: at },
        configured,
        policy,
        null,
      ).position.trailingPrice,
      100,
    );
  }
});
test("size checks preserve exact minimum notional and reject zero, below-minimum, off-step and maximum sizes", () => {
  const instrument = rules("DOGEUSDT", "0.00001", "1");
  const position = {
    quantity: "50",
    entryPrice: "0.1",
    stopPrice: "0.09",
    takePrice: "0.11",
    trailingPrice: null,
  };
  assert.equal(executionInstrumentSizeFailure(position, instrument), null);
  assert.equal(
    executionInstrumentSizeFailure({ ...position, quantity: "49" }, instrument),
    "ENTRY_BELOW_MIN_NOTIONAL",
  );
  assert.equal(
    executionInstrumentSizeFailure({ ...position, quantity: "0" }, instrument),
    "ENTRY_SIZE_ROUNDED_TO_ZERO",
  );
  assert.equal(
    executionInstrumentSizeFailure({ ...position, quantity: "50.5" }, instrument),
    "INVALID_QUANTITY_STEP",
  );
  assert.equal(
    executionInstrumentSizeFailure({ ...position, quantity: "10001" }, instrument),
    "ENTRY_ABOVE_MAX_QUANTITY",
  );
  assert.equal(
    openExecutionPositionAtQuote(
      { side: "long", signalPrice: 0.1 },
      { symbol: instrument.symbol, price: 0.1, observedAt: at },
      "neutral",
      1,
      100,
      config,
      instrument,
    ),
    null,
  );
  assert.equal(
    openExecutionPositionAtQuote(
      { side: "long", signalPrice: 60000 },
      { symbol: "BTCUSDT", price: 60000, observedAt: at },
      "neutral",
      0.001,
      100,
      config,
      rules(),
    ),
    null,
  );
});
test("market fill rounds against the trade; coarse ticks reject collapsed protective levels", () => {
  const instrument = rules();
  const buy = openExecutionPositionAtQuote(
    { side: "long", signalPrice: 100 },
    { symbol: "BTCUSDT", price: 100, observedAt: at },
    "neutral",
    10000,
    10000,
    config,
    instrument,
  )!;
  const sell = openExecutionPositionAtQuote(
    { side: "short", signalPrice: 100 },
    { symbol: "BTCUSDT", price: 100, observedAt: at },
    "neutral",
    10000,
    10000,
    config,
    instrument,
  )!;
  assert.equal(buy.entryPrice, 100.1);
  assert.equal(sell.entryPrice, 99.9);
  assert.equal(settleExecutionPosition(buy, 97.93, at, "stop-loss", config).exitPrice, 97.9);
  assert.equal(settleExecutionPosition(sell, 102.07, at, "stop-loss", config).exitPrice, 102.1);
  assert.equal(
    openExecutionPositionAtQuote(
      { side: "long", signalPrice: 1 },
      { symbol: "BTCUSDT", price: 1, observedAt: at },
      "neutral",
      10000,
      10000,
      config,
      rules("BTCUSDT", "1", "1"),
    ),
    null,
  );
});
test("missing, invalid, future and stale instrument metadata block capture", () => {
  const instrument = rules();
  const stored = {
    symbol: instrument.symbol,
    metadataSyncedAt: at,
    ...Object.fromEntries(
      Object.entries(instrument)
        .filter(([key]) => !["version", "symbol", "observedAt"].includes(key))
        .map(([key, value]) => [key, { toFixed: () => String(value) }]),
    ),
  } as Parameters<typeof captureInstrumentRules>[0];
  assert.equal(captureInstrumentRules(null, at).reason, "INSTRUMENT_RULES_MISSING");
  assert.equal(captureInstrumentRules(stored, at).reason, null);
  assert.equal(
    captureInstrumentRules(stored, new Date(+at + 3600001)).reason,
    "INSTRUMENT_RULES_STALE",
  );
  assert.equal(
    captureInstrumentRules(stored, new Date(+at - 1001)).reason,
    "INSTRUMENT_RULES_STALE",
  );
  assert.throws(() => readExecutionInstrumentRules({ ...instrument, qtyStep: "0" }), /Invalid/);
});
test("validation and candle replay share pinned instrument rules and retain legacy results separately", () => {
  const configured = strategyConfigSchema.parse(fixture.config);
  const candles = fixture.candles.map((candle) => ({
    ...candle,
    openTime: new Date(candle.openTime),
  }));
  const instrumentRules = Object.fromEntries(
    configured.universe.symbols.map((symbol) => [symbol, rules(symbol, "0.05", "0.001")]),
  );
  const validation = runValidationEngine({
    config: configured,
    candles,
    initialCapital: 10000,
    kind: "backtest",
    walkForward: null,
    instrumentRules,
  });
  const replay = runRuntimeReplay({
    config: configured,
    candles,
    initialCapital: 10000,
    instrumentRules,
  });
  assert.ok(validation.trades.length > 0);
  for (let index = 0; index < validation.trades.length; index++) {
    const expected = validation.trades[index]!,
      actual = replay.trades[index]!;
    for (const key of Object.keys(expected) as Array<keyof typeof expected>)
      assert.equal(actual[key], expected[key]);
    assert.equal(
      compareExecutionDecimals(
        roundExecutionStep(expected.quantity, "0.001", "floor"),
        expected.quantity,
      ),
      0,
    );
  }
  assert.equal(replay.trades.length, validation.trades.length);
  assert.throws(
    () =>
      runValidationEngine({
        config: configured,
        candles,
        initialCapital: 10000,
        kind: "backtest",
        walkForward: null,
        instrumentRules: {},
      }),
    /Missing pinned/,
  );
});
