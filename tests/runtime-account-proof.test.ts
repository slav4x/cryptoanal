import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../research/golden/v1/momentum-reversal.json";
import {
  assessExecutionAccount,
  defaultExecutionAccountSafety,
} from "../packages/application/src/execution-account";
import { tradeAcceptanceCases } from "../packages/application/src/trade-acceptance";
import {
  accountStateAmounts,
  type AccountState,
} from "../packages/persistence/src/runtime-account-proof";
import { hashTracePayload } from "../packages/persistence/src/position-trace";
import { auditJson, type auditClosedTrade } from "../apps/worker/src/closed-trade-audit";
import {
  extendAccountAudit,
  type RetainedTradeAuditSource,
} from "../apps/worker/src/retained-trade-audit";
function example() {
  const fee = "0.012345678901234567",
    price = "100.012345678901234567",
    time = "2026-10-17T01:00:00.000Z";
  const input = {
    policy: defaultExecutionAccountSafety,
    config: fixture.config,
    now: time,
    realizedNetPnl: 0,
    utcCashPnl: 0,
    strategyCashPnl: 0,
    positions: [],
    marketReady: true,
    fundingReady: true,
    killSwitch: false,
    utcHalted: false,
  };
  const before: AccountState = {
    workspaceId: "w",
    exchangeAccountId: "account",
    executionRunId: "run",
    observedAt: time,
    initialBalance: "10000",
    ledger: { legacyNet: "0", liquidityNet: "0", funding: "0" },
    positions: [],
    cashPnl: "0",
    markEquityPnl: "0",
    cash: "10000",
    markEquity: "10000",
  };
  const after = {
    ...before,
    positions: [
      {
        id: "p",
        side: "BUY" as const,
        quantity: "1",
        entryPrice: price,
        markPrice: price,
        remainingEntryFee: fee,
        managedThroughAt: time,
        runtimeVersion: 0,
      },
    ],
  };
  Object.assign(after, accountStateAmounts(after));
  const payload = auditJson({
    version: "cryptoanal-account-transition@1",
    positionId: "p",
    kind: "entry",
    sourceIds: ["Fill:entry"],
    before,
    after,
    admission: {
      risk: { input, result: assessExecutionAccount({ ...input, now: new Date(time) }) },
      entry: {
        candidate: {
          symbol: "BTCUSDT",
          side: "long",
          quantity: 1,
          entryPrice: Number(price),
          entryFee: Number(fee),
          stopPrice: 97,
          tickSize: "0.000000000000000001",
        },
        conflicts: [],
        failure: null,
        eventId: "1",
      },
    },
  });
  const source = {
    accountId: "account",
    position: {
      id: "p",
      workspaceId: "w",
      executionRunId: "run",
      symbol: "BTCUSDT",
      side: "BUY",
      entryPrice: price,
      quantity: "1",
      entryFee: fee,
      executionPolicy: null,
      exitPolicy: null,
    },
    trade: { id: "t" },
    run: { id: "run" },
    config: fixture.config,
    orders: [{ side: "BUY", fills: [{ id: "entry", fee, quantity: "1" }] }],
    payments: [],
    accountProofs: [{ id: "proof", metadata: { payload, hash: hashTracePayload(payload) } }],
  } as unknown as RetainedTradeAuditSource;
  const base = {
    checks: [
      {
        id: "admission",
        outcome: "unknown",
        evidenceIds: [],
        expected: "original",
        actual: "NO_ORIGINAL_ACCOUNT_PROOF",
      },
      {
        id: "cash-equity",
        outcome: "unknown",
        evidenceIds: [],
        expected: "original",
        actual: "NO_ORIGINAL_ACCOUNT_PROOF",
      },
    ],
    cases: tradeAcceptanceCases.map((c) => ({
      caseId: c.id,
      status: "insufficient-data",
      applicability: "unknown",
      missingSources: [...c.sources],
    })),
    status: "insufficient-data",
  } as unknown as Awaited<ReturnType<typeof auditClosedTrade>>;
  return { source, base };
}
test("admission replays the original numeric risk inputs while account cash retains decimal precision", () => {
  const { source, base } = example(),
    result = extendAccountAudit(base, source);
  assert.equal(result.checks.find((c) => c.id === "account-proof-integrity")!.outcome, "pass");
  assert.equal(result.checks.find((c) => c.id === "admission")!.outcome, "pass");
  assert.equal(result.checks.find((c) => c.id === "cash-equity")!.outcome, "unknown");
});
test("unknown historical account evidence is not converted to a successful admission", () => {
  const { source, base } = example();
  source.accountProofs = [];
  const result = extendAccountAudit(base, source);
  assert.equal(result.checks.find((c) => c.id === "admission")!.outcome, "unknown");
  assert.equal(result.status, "insufficient-data");
});
test("a proof from a different account cannot establish a valid cash transition", () => {
  const { source, base } = example();
  source.accountId = "another-account";
  assert.equal(
    extendAccountAudit(base, source).checks.find((c) => c.id === "account-proof-integrity")!
      .outcome,
    "fail",
  );
});
test("a checksum-valid duplicate operation is rejected before counting its cash twice", () => {
  const { source, base } = example(),
    envelope = source.accountProofs![0]!.metadata as {
      payload: { sourceIds: string[] };
      hash: string;
    };
  envelope.payload.sourceIds.push("Fill:entry");
  envelope.hash = hashTracePayload(envelope.payload);
  const result = extendAccountAudit(base, source);
  assert.equal(result.checks.find((c) => c.id === "account-proof-integrity")!.outcome, "fail");
  assert.equal(result.status, "violation");
});
