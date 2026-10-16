import {
  auditClosedTrade,
  auditJson,
  auditObject,
  type ClosedTradeAuditSource,
  type AuditLoaders,
} from "./closed-trade-audit";
import {
  assessTradeAcceptance,
  tradeAcceptanceCases,
} from "../../../packages/application/src/trade-acceptance";
import {
  assessExecutionAccount,
  executionAccountEntryFailure,
} from "../../../packages/application/src/execution-account";
import { readPinnedExecutionPolicy } from "../../../packages/persistence/src/execution-policy-repository";
import {
  accountStateAmounts,
  runtimeAccountProofVersion,
  type AccountState,
} from "../../../packages/persistence/src/runtime-account-proof";
import { hashTracePayload } from "../../../packages/persistence/src/position-trace";
import { exitDecimal } from "../../../packages/persistence/src/liquidity-exit-model";

export const retainedTradeAuditVersion = "cryptoanal-retained-trade-audit@1";
export type RetainedTradeAuditSource = ClosedTradeAuditSource & {
  accountId?: string;
  accountProofs?: Array<{ id: string; metadata: unknown }>;
};
type BaseResult = Awaited<ReturnType<typeof auditClosedTrade>>;
type Proof = {
  version: string;
  positionId: string;
  kind: "entry" | "exit" | "funding" | "settlement";
  sourceIds: string[];
  before: AccountState;
  after: AccountState;
  admission: unknown;
};
const same = (a: unknown, b: unknown, label: string) => {
  if (hashTracePayload(auditJson(a)) !== hashTracePayload(auditJson(b)))
    throw new Error(`${label} mismatch`);
};
const equal = (a: string, b: string, label: string, tolerance = "0") => {
  if (!exitDecimal(a).sub(b).abs().lte(tolerance))
    throw new Error(`${label}: expected ${b}, actual ${a}`);
};
export function extendAccountAudit(base: BaseResult, source: RetainedTradeAuditSource) {
  const result = structuredClone(base),
    checks = result.checks;
  const set = (
    id: string,
    outcome: "pass" | "fail" | "unknown",
    evidenceIds: string[],
    expected: unknown,
    actual: unknown,
  ) => {
    const next = {
      id,
      outcome,
      evidenceIds,
      expected: auditJson(expected),
      actual: auditJson(actual),
    };
    const index = checks.findIndex((c) => c.id === id);
    if (index < 0) checks.push(next);
    else checks[index] = next;
  };
  const proofs: Proof[] = [],
    refs = (source.accountProofs ?? []).map((p) => `AuditEvent:${p.id}`);
  const byFill = new Map(
    source.orders.flatMap((o) =>
      o.fills.map(
        (f) =>
          [`Fill:${f.id}` as string, { ...f, entry: o.side === source.position.side }] as const,
      ),
    ),
  );
  const byPayment = new Map(source.payments.map((p) => [`FundingPayment:${p.id}`, p]));
  let valid = true;
  if (refs.length)
    try {
      const seen = new Set<string>();
      for (const row of source.accountProofs!) {
        const envelope = auditObject(row.metadata),
          p = envelope.payload as Proof;
        if (
          !p ||
          p.version !== runtimeAccountProofVersion ||
          !Array.isArray(p.sourceIds) ||
          !p.sourceIds.length ||
          !["entry", "exit", "funding", "settlement"].includes(p.kind)
        )
          throw new Error("Invalid account proof envelope");
        same(envelope.hash, hashTracePayload(p), "Account proof checksum");
        if (p.positionId !== source.position.id)
          throw new Error("Account proof position binding mismatch");
        for (const s of [p.before, p.after]) {
          if (
            s.workspaceId !== source.position.workspaceId ||
            s.executionRunId !== source.run.id ||
            (source.accountId !== undefined && s.exchangeAccountId !== source.accountId) ||
            !s.exchangeAccountId ||
            !Number.isFinite(Date.parse(s.observedAt))
          )
            throw new Error("Account state scope mismatch");
          if (new Set(s.positions.map((p) => p.id)).size !== s.positions.length)
            throw new Error("Duplicate account position");
          for (const x of s.positions)
            if (
              !["BUY", "SELL"].includes(x.side) ||
              !exitDecimal(x.quantity).gte(0) ||
              !exitDecimal(x.entryPrice).gt(0) ||
              !exitDecimal(x.markPrice).gt(0) ||
              !exitDecimal(x.remainingEntryFee).gte(0)
            )
              throw new Error("Invalid account position amounts");
          const amounts = accountStateAmounts(s);
          for (const key of ["cashPnl", "markEquityPnl", "cash", "markEquity"] as const)
            same(s[key], amounts[key], `Account ${key}`);
        }
        if (
          p.before.exchangeAccountId !== p.after.exchangeAccountId ||
          p.before.initialBalance !== p.after.initialBalance ||
          Date.parse(p.after.observedAt) < Date.parse(p.before.observedAt)
        )
          throw new Error("Account transition scope or time mismatch");
        same(
          p.before.positions.filter((x) => x.id !== p.positionId),
          p.after.positions.filter((x) => x.id !== p.positionId),
          "Other account positions changed inside transition",
        );
        const beforePosition = p.before.positions.find((x) => x.id === p.positionId);
        const afterPosition = p.after.positions.find((x) => x.id === p.positionId);
        if (p.kind === "entry") {
          if (beforePosition || !afterPosition)
            throw new Error("Entry account position transition mismatch");
          equal(afterPosition.quantity, source.position.quantity, "Entry account quantity");
          equal(afterPosition.entryPrice, source.position.entryPrice, "Entry account price");
          equal(afterPosition.remainingEntryFee, source.position.entryFee, "Entry account fee");
        } else if (!beforePosition) throw new Error("Account operation has no original position");
        if (p.kind === "exit") {
          const exited = p.sourceIds.reduce(
            (sum, id) => sum.add(byFill.get(id)?.quantity ?? "0"),
            exitDecimal(0),
          );
          equal(
            exitDecimal(beforePosition!.quantity)
              .sub(afterPosition?.quantity ?? "0")
              .toFixed(),
            exited.toFixed(),
            "Account exit quantity",
          );
        }
        if (p.kind === "funding") {
          if (!afterPosition) throw new Error("Funding removed account position");
          equal(beforePosition!.quantity, afterPosition.quantity, "Funding exposure transition");
        }
        if (
          p.kind === "settlement" &&
          (!exitDecimal(beforePosition!.quantity).eq(0) || afterPosition)
        )
          throw new Error("Settlement account residual mismatch");
        let delta = exitDecimal(0);
        for (const id of p.sourceIds) {
          if (seen.has(id)) throw new Error(`Duplicate account operation: ${id}`);
          seen.add(id);
          const f = byFill.get(id),
            payment = byPayment.get(id);
          if (p.kind === "entry" && f?.entry) delta = delta.sub(f.fee);
          else if (p.kind === "exit" && f && !f.entry) {
            delta = delta.add(
              f.realizedNetPnl === null
                ? exitDecimal(source.trade.netPnl).add(source.position.entryFee)
                : exitDecimal(f.realizedNetPnl).add(f.entryFeeAllocated ?? "0"),
            );
          } else if (p.kind === "funding" && payment) delta = delta.sub(payment.amount);
          else if (
            (p.kind === "exit" || p.kind === "settlement") &&
            id === `Trade:${source.trade.id}`
          ) {
            // Trade creation adds no cash flow after individual exit fills were recorded.
          } else throw new Error(`Account proof source binding mismatch: ${id}`);
        }
        equal(
          p.after.cashPnl,
          exitDecimal(p.before.cashPnl).add(delta).toFixed(),
          "Account cash transition",
          source.position.exitPolicy ? "0" : "0.00000002",
        );
        proofs.push(p);
      }
      set("account-proof-integrity", "pass", refs, "original atomic transitions matched", {
        proofs: proofs.length,
        operations: seen.size,
      });
      const expected = [...byFill.keys(), ...byPayment.keys(), `Trade:${source.trade.id}`];
      const missing = expected.filter((id) => !seen.has(id));
      if (proofs.some((p) => p.before.initialBalance === null))
        missing.push("original-initial-capital");
      set(
        "cash-equity",
        missing.length ? "unknown" : "pass",
        refs,
        "all entry/exit/funding/settlement operations",
        { missing, transitions: proofs.length },
      );
    } catch (error) {
      valid = false;
      set(
        "account-proof-integrity",
        "fail",
        refs,
        "original atomic transitions matched",
        error instanceof Error ? error.message : String(error),
      );
      set("cash-equity", "fail", refs, "all original cash transitions", "ACCOUNT_PROOF_INVALID");
    }
  else
    set(
      "account-proof-integrity",
      "unknown",
      [],
      "original atomic account evidence",
      "NO_ORIGINAL_ACCOUNT_PROOF",
    );
  const entry = proofs.filter((p) => p.kind === "entry");
  if (valid && entry.length)
    try {
      if (entry.length !== 1) throw new Error("Duplicate admission proof");
      const a = entry[0]!.admission as {
        risk: {
          input: Omit<Parameters<typeof assessExecutionAccount>[0], "now"> & { now: string };
          result: unknown;
        };
        entry: {
          candidate: Parameters<typeof executionAccountEntryFailure>[1];
          conflicts: Parameters<typeof executionAccountEntryFailure>[2];
          failure: unknown;
          eventId: string;
        };
      };
      if (!a?.risk?.input || !a.entry) throw new Error("Invalid admission evidence");
      same(a.risk.input.config, source.config, "Admission strategy config");
      const pinned = readPinnedExecutionPolicy(source.position.executionPolicy);
      if (pinned)
        same(
          a.risk.input.policy,
          pinned.payload.settings.accountSafety,
          "Admission account policy",
        );
      const expected = assessExecutionAccount({ ...a.risk.input, now: new Date(a.risk.input.now) });
      same(a.risk.result, expected, "Admission risk assessment");
      const p = source.position,
        c = a.entry.candidate;
      if (c.symbol !== p.symbol || c.side !== (p.side === "BUY" ? "long" : "short"))
        throw new Error("Admission candidate binding mismatch");
      equal(String(c.quantity), String(Number(p.quantity)), "Admission quantity");
      equal(String(c.entryPrice), String(Number(p.entryPrice)), "Admission price");
      equal(String(c.entryFee), String(Number(p.entryFee)), "Admission fee");
      if (
        a.entry.failure !== null ||
        executionAccountEntryFailure(expected, c, a.entry.conflicts) !== null
      )
        throw new Error("Entry admitted despite account risk rejection");
      equal(
        String(a.risk.input.policy.initialBalance),
        entry[0]!.before.initialBalance ?? "NaN",
        "Admission initial capital",
      );
      set("admission", "pass", refs, "original account risk admission accepted", {
        checkedAt: a.risk.input.now,
        eventId: a.entry.eventId,
      });
    } catch (error) {
      set(
        "admission",
        "fail",
        refs,
        "original account risk admission accepted",
        error instanceof Error ? error.message : String(error),
      );
    }
  result.cases = tradeAcceptanceCases.map((def) => {
    const previous = base.cases.find((c) => c.caseId === def.id)!;
    return {
      ...assessTradeAcceptance(def.id, {
        applicability: previous.applicability,
        applicabilityEvidence:
          previous.applicability === "unknown" ? [] : [`Trade:${source.trade.id}`],
        checks: def.checks.map((id) => {
          const key = id === "signal-finality" && def.id.endsWith("entry") ? "entry-finality" : id;
          return {
            ...(checks.find((c) => c.id === key) ?? {
              outcome: "unknown" as const,
              evidenceIds: [],
            }),
            id,
          };
        }),
        sources: def.sources.filter((id) => !previous.missingSources.includes(id)),
      }),
      applicability: previous.applicability,
    };
  });
  result.status = checks.some((c) => c.outcome === "fail")
    ? "violation"
    : result.cases.some((c) => c.status === "insufficient-data")
      ? "insufficient-data"
      : "confirmed";
  return { ...result, version: retainedTradeAuditVersion };
}
export async function auditRetainedTrade(source: RetainedTradeAuditSource, loaders: AuditLoaders) {
  return extendAccountAudit(await auditClosedTrade(source, loaders), source);
}
