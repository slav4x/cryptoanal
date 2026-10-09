import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeErrorMessage } from "../apps/worker/src/runtime-error";

test("unavailable Docker proxy is actionable and its credentials never enter status", () => {
  const error = new TypeError("fetch failed", {
    cause: { code: "ECONNREFUSED", address: "192.168.65.254", port: 10820 },
  });
  const message = runtimeErrorMessage(
    error,
    "http://private-user:secret@host.docker.internal:10820",
  );
  assert.match(message, /прокси host\.docker\.internal:10820 недоступен/);
  assert.match(message, /ECONNREFUSED/);
  assert.doesNotMatch(message, /private-user|secret|192\.168/);
});

test("direct connection failures preserve network code without exposing raw causes", () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"]) {
    assert.match(
      runtimeErrorMessage(
        new TypeError("fetch failed", { cause: { code, message: "sensitive raw data" } }),
      ),
      new RegExp(code),
    );
  }
  assert.equal(
    runtimeErrorMessage(new TypeError("fetch failed", { cause: { code: "contains secret" } })),
    "fetch failed",
  );
  assert.equal(runtimeErrorMessage(new TypeError("fetch failed")), "fetch failed");
});

test("exchange and recovery errors retain their specific message", () => {
  assert.equal(
    runtimeErrorMessage(new Error("Recovery window exceeds configured limit")),
    "Recovery window exceeds configured limit",
  );
  assert.equal(runtimeErrorMessage(null), "Неизвестная ошибка");
});
