import assert from "node:assert/strict";
import { test } from "node:test";
import { loadServerConfig } from "../packages/config/src/index";
import {
  runtimeEntryExpiresAt,
  runtimeMarketEntryFailure,
} from "../packages/persistence/src/runtime-entry-policy";

const detectedAt = new Date("2026-10-04T12:00:00Z");
const expiresAt = new Date(+detectedAt + 900_000);
const input = { detectedAt, expiresAt, signalPrice: 100, now: new Date(+detectedAt + 59_999) };

test("market TTL is independent of candle interval and rejects the exact deadline", () => {
  assert.equal(+runtimeEntryExpiresAt("MARKET", detectedAt, expiresAt), +detectedAt + 60_000);
  assert.equal(runtimeMarketEntryFailure(input), null);
  assert.equal(
    runtimeMarketEntryFailure({ ...input, now: new Date(+detectedAt + 60_000) }),
    "ENTRY_SIGNAL_EXPIRED",
  );
  assert.equal(
    runtimeMarketEntryFailure({ ...input, now: new Date(+detectedAt + 300_000) }),
    "ENTRY_SIGNAL_EXPIRED",
  );
  assert.equal(
    runtimeMarketEntryFailure({ ...input, quoteAt: new Date(+detectedAt + 60_000) }),
    "ENTRY_SIGNAL_EXPIRED",
  );
});

test("saved earlier expiry is never extended and limits retain their own deadline", () => {
  const earlier = new Date(+detectedAt + 5000);
  assert.equal(+runtimeEntryExpiresAt("MARKET", detectedAt, earlier), +earlier);
  assert.equal(+runtimeEntryExpiresAt("LIMIT", detectedAt, expiresAt), +expiresAt);
});

test("market deviation accepts the exact boundary in either direction", () => {
  for (const quotePrice of [99.5, 100.5])
    assert.equal(runtimeMarketEntryFailure({ ...input, quotePrice }), null);
  for (const quotePrice of [99.4999, 100.5001])
    assert.equal(runtimeMarketEntryFailure({ ...input, quotePrice }), "ENTRY_PRICE_DEVIATION");
  const zero = { ttlMs: 60_000, maxDeviationBps: 0 };
  assert.equal(runtimeMarketEntryFailure({ ...input, quotePrice: 100 }, zero), null);
  assert.equal(
    runtimeMarketEntryFailure({ ...input, quotePrice: 100.0001 }, zero),
    "ENTRY_PRICE_DEVIATION",
  );
});

test("invalid prices/timing and pre-signal quotes fail closed", () => {
  for (const signalPrice of [0, -1, NaN, Infinity])
    assert.equal(runtimeMarketEntryFailure({ ...input, signalPrice }), "INVALID_ENTRY_SIGNAL");
  for (const quotePrice of [0, -1, NaN, Infinity])
    assert.equal(runtimeMarketEntryFailure({ ...input, quotePrice }), "INVALID_ENTRY_QUOTE");
  assert.equal(
    runtimeMarketEntryFailure({ ...input, quoteAt: new Date(+detectedAt - 1) }),
    "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY",
  );
  assert.equal(
    runtimeMarketEntryFailure({ ...input, now: new Date(+detectedAt - 1) }),
    "INVALID_ENTRY_SIGNAL",
  );
});

test("market entry configuration has bounded defaults and accepts explicit overrides", () => {
  const environment = { DATABASE_URL: "postgresql://test:test@localhost:5432/test" };
  const defaults = loadServerConfig(environment);
  assert.equal(defaults.RUNTIME_MARKET_ENTRY_TTL_MS, 60_000);
  assert.equal(defaults.RUNTIME_MARKET_ENTRY_MAX_DEVIATION_BPS, 50);
  const custom = loadServerConfig({
    ...environment,
    RUNTIME_MARKET_ENTRY_TTL_MS: "5000",
    RUNTIME_MARKET_ENTRY_MAX_DEVIATION_BPS: "0",
  });
  assert.equal(custom.RUNTIME_MARKET_ENTRY_TTL_MS, 5000);
  assert.equal(custom.RUNTIME_MARKET_ENTRY_MAX_DEVIATION_BPS, 0);
  assert.throws(() => loadServerConfig({ ...environment, RUNTIME_MARKET_ENTRY_TTL_MS: "0" }));
  assert.throws(() =>
    loadServerConfig({ ...environment, RUNTIME_MARKET_ENTRY_MAX_DEVIATION_BPS: "-1" }),
  );
});
