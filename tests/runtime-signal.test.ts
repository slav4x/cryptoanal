import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runtimeSignalId,
  runtimeSignalState,
  withRuntimeSignal,
} from "../packages/persistence/src/runtime-signal";
const at = new Date("2026-10-04T14:15:00Z");

test("signal identity is stable across JSON restart and distinct for run, symbol and candle", () => {
  const id = runtimeSignalId("run", "BTCUSDT", at);
  assert.equal(runtimeSignalId("run", "BTCUSDT", new Date(JSON.parse(JSON.stringify(at)))), id);
  assert.notEqual(runtimeSignalId("other-run", "BTCUSDT", at), id);
  assert.notEqual(runtimeSignalId("run", "ETHUSDT", at), id);
  assert.notEqual(runtimeSignalId("run", "BTCUSDT", new Date(+at + 900000)), id);
});

test("lifecycle metadata ignores a caller-supplied ID and preserves existing evidence", () => {
  for (const status of ["SIGNAL", "PENDING", "FILLED", "EXPIRED", "REJECTED"] as const) {
    const state = runtimeSignalState({
      executionRunId: "run",
      symbol: "BTCUSDT",
      candleAt: at,
      status,
      observedAt: at,
      reasonCode: "TEST",
      pending: {
        signalId: "forged",
        detectedAt: at.toISOString(),
        expiresAt: new Date(+at + 900000).toISOString(),
      },
    });
    assert.equal(state.id, runtimeSignalId("run", "BTCUSDT", at));
    assert.equal(state.status, status);
    assert.deepEqual(withRuntimeSignal({ evidence: "original", runtimeSignal: "forged" }, state), {
      evidence: "original",
      runtimeSignal: state,
    });
    assert.deepEqual(withRuntimeSignal("original", state), {
      details: "original",
      runtimeSignal: state,
    });
  }
});
