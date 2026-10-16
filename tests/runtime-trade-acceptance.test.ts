import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessTradeAcceptance,
  classifyAcceptanceCohort,
  tradeAcceptanceCases,
  type AcceptanceBoundary,
  type AcceptanceEvidence,
} from "../packages/application/src/trade-acceptance";

const definition = tradeAcceptanceCases.find((c) => c.id === "stop-loss")!;
function evidence(): AcceptanceEvidence {
  return {
    applicability: "yes",
    applicabilityEvidence: ["trade:sl"],
    sources: [...definition.sources],
    checks: definition.checks.map((id) => ({ id, outcome: "pass", evidenceIds: [`source:${id}`] })),
  };
}
test("acceptance distinguishes a proven violation, missing evidence and a verified case", () => {
  const input = evidence();
  const original = structuredClone(input);
  assert.equal(assessTradeAcceptance("stop-loss", input).status, "confirmed");
  assert.deepEqual(input, original);
  input.sources.splice(input.sources.indexOf("continuous-path"), 1);
  assert.equal(assessTradeAcceptance("stop-loss", input).status, "insufficient-data");
  input.checks.find((c) => c.id === "first-eligible-trigger")!.outcome = "fail";
  assert.equal(assessTradeAcceptance("stop-loss", input).status, "violation");
  input.checks.find((c) => c.id === "first-eligible-trigger")!.evidenceIds = [];
  assert.equal(assessTradeAcceptance("stop-loss", input).status, "insufficient-data");
});
test("no observed trigger cannot be called inapplicable; absence needs policy evidence", () => {
  const input: AcceptanceEvidence = {
    applicability: "no",
    applicabilityEvidence: [],
    sources: [],
    checks: [],
  };
  assert.equal(assessTradeAcceptance("holding-timeout", input).status, "insufficient-data");
  input.applicabilityEvidence = ["pinned-policy:timeout-disabled"];
  assert.equal(assessTradeAcceptance("holding-timeout", input).status, "not-applicable");
  const failed = evidence();
  failed.applicability = "no";
  failed.checks[0]!.outcome = "fail";
  assert.equal(assessTradeAcceptance("stop-loss", failed).status, "violation");
});
test("unknown, missing and blank references never confirm an acceptance check", () => {
  for (const mutate of [
    (e: AcceptanceEvidence) => {
      e.checks[0]!.outcome = "unknown";
    },
    (e: AcceptanceEvidence) => {
      e.checks.pop();
    },
    (e: AcceptanceEvidence) => {
      e.checks[0]!.evidenceIds = [""];
    },
    (e: AcceptanceEvidence) => {
      e.applicabilityEvidence = [" "];
    },
    (e: AcceptanceEvidence) => {
      e.applicability = "unknown";
    },
  ]) {
    const input = evidence();
    mutate(input);
    assert.equal(assessTradeAcceptance("stop-loss", input).status, "insufficient-data");
  }
});
test("duplicate or unrelated checks fail rather than hiding contradictory results", () => {
  const input = evidence();
  input.checks.push(input.checks[0]!);
  assert.throws(() => assessTradeAcceptance("stop-loss", input), /duplicate/);
  input.checks = [{ id: "unrelated", outcome: "pass", evidenceIds: ["x"] }];
  assert.throws(() => assessTradeAcceptance("stop-loss", input), /Unknown/);
});
test("repeated classification is deterministic and independent of evidence ordering", () => {
  for (const c of tradeAcceptanceCases) {
    const input: AcceptanceEvidence = {
      applicability: "yes",
      applicabilityEvidence: ["policy:1"],
      sources: [...c.sources],
      checks: c.checks.map((id) => ({ id, outcome: "pass", evidenceIds: ["checked:1"] })),
    };
    const first = assessTradeAcceptance(c.id, input);
    assert.equal(first.status, "confirmed");
    assert.deepEqual(assessTradeAcceptance(c.id, structuredClone(input)), first);
    input.checks.reverse();
    input.sources.reverse();
    assert.deepEqual(assessTradeAcceptance(c.id, input), first);
  }
});

const boundary: AcceptanceBoundary = {
  asOf: "2026-10-16T10:00:00.000Z",
  knownTradeIds: ["old-trade"],
  knownPositionIds: ["old-position"],
  runs: [
    {
      executionRunId: "run",
      strategyVersionId: "v1",
      configHash: "config1",
      policyFingerprint: "policy1",
    },
  ],
};
const fresh = {
  ...boundary.runs[0]!,
  id: "new-position",
  tradeId: "new-trade",
  openedAt: "2026-10-16T10:01:00.000Z",
  createdAt: "2026-10-16T10:01:00.000Z",
};
test("snapshot IDs isolate old closed trades and positions carried across the boundary", () => {
  assert.equal(
    classifyAcceptanceCohort(boundary, { ...fresh, tradeId: "old-trade" }),
    "baseline-closed",
  );
  assert.equal(
    classifyAcceptanceCohort(boundary, { ...fresh, id: "old-position" }),
    "baseline-position",
  );
  assert.equal(classifyAcceptanceCohort(boundary, fresh), "new-entry-pinned");
});
test("a newly visible backdated or boundary-time record is not a new forward trial", () => {
  for (const field of ["openedAt", "createdAt"] as const) {
    assert.equal(
      classifyAcceptanceCohort(boundary, { ...fresh, [field]: boundary.asOf }),
      "late-discovered",
    );
    assert.equal(
      classifyAcceptanceCohort(boundary, { ...fresh, [field]: "2026-09-01T00:00:00Z" }),
      "late-discovered",
    );
  }
});
test("new run, strategy, config and policy identities stay separate from the pinned cohort", () => {
  for (const key of [
    "executionRunId",
    "strategyVersionId",
    "configHash",
    "policyFingerprint",
  ] as const)
    assert.equal(
      classifyAcceptanceCohort(boundary, { ...fresh, [key]: "changed" }),
      "new-policy-entry",
    );
  assert.throws(
    () => classifyAcceptanceCohort(boundary, { ...fresh, openedAt: "invalid" }),
    /boundary time/,
  );
});
