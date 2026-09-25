import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateStrategyLifecycle } from "../packages/application/src/strategy-lifecycle";

test("a deployed strategy can be revalidated without stopping its deployment", () => {
  const lifecycle = evaluateStrategyLifecycle({
    status: "deployed",
    latestVersionId: "current-version",
    validations: [],
    hasActiveDeployment: true,
  });

  assert.equal(lifecycle.validation.eligible, true);
  assert.deepEqual(lifecycle.validation.reasons, []);
  assert.equal(lifecycle.transitions.find(({ target }) => target === "approved")?.allowed, false);
});

test("an active validation still prevents another validation", () => {
  const lifecycle = evaluateStrategyLifecycle({
    status: "deployed",
    latestVersionId: "current-version",
    validations: [{ strategyVersionId: "current-version", status: "running", verdict: "pending" }],
    hasActiveDeployment: true,
  });

  assert.equal(lifecycle.validation.eligible, false);
  assert.match(lifecycle.validation.reasons[0] ?? "", /уже выполняется/);
});
