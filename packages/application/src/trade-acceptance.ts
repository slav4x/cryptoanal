export const tradeAcceptanceVersion = "cryptoanal-trade-acceptance@1";

const entryChecks = [
  "source-integrity",
  "signal-finality",
  "admission",
  "entry-fill",
  "residual-protection",
];
const exitChecks = [
  "source-integrity",
  "original-risk",
  "exit-priority",
  "first-eligible-trigger",
  "exit-fill",
  "settlement",
];
export const tradeAcceptanceCases = [
  {
    id: "market-entry",
    checks: entryChecks,
    sources: ["entry-intent", "signal", "public-trades-l1", "fills"],
  },
  {
    id: "limit-entry",
    checks: [...entryChecks, "limit-ttl"],
    sources: ["entry-intent", "signal", "public-trades-l1", "fills"],
  },
  {
    id: "full-entry",
    checks: [...entryChecks, "quantity-conservation"],
    sources: ["entry-intent", "fills", "position"],
  },
  {
    id: "partial-entry",
    checks: [...entryChecks, "quantity-conservation"],
    sources: ["entry-intent", "fills", "cancelled-remainder", "position"],
  },
  {
    id: "stop-loss",
    checks: exitChecks,
    sources: ["initial-snapshot", "continuous-path", "exit-intent", "fills", "ledger"],
  },
  {
    id: "take-profit",
    checks: exitChecks,
    sources: ["initial-snapshot", "continuous-path", "exit-intent", "fills", "ledger"],
  },
  {
    id: "break-even",
    checks: [...exitChecks, "prospective-peak", "cost-aware-level"],
    sources: ["initial-snapshot", "continuous-path", "protection-checkpoints", "fills", "ledger"],
  },
  {
    id: "trailing",
    checks: [...exitChecks, "prospective-peak", "monotone-protection"],
    sources: ["initial-snapshot", "continuous-path", "protection-checkpoints", "fills", "ledger"],
  },
  {
    id: "signal-exit",
    checks: [...exitChecks, "signal-finality"],
    sources: ["initial-snapshot", "continuous-path", "signal", "exit-intent", "fills", "ledger"],
  },
  {
    id: "holding-timeout",
    checks: [...exitChecks, "holding-deadline"],
    sources: ["initial-snapshot", "continuous-path", "exit-intent", "fills", "ledger"],
  },
  {
    id: "partial-exit",
    checks: [...exitChecks, "quantity-conservation", "residual-protection"],
    sources: ["initial-snapshot", "continuous-path", "exit-intent", "fills", "ledger"],
  },
  {
    id: "recovery",
    checks: [
      "source-integrity",
      "causal-recovery",
      "checkpoint-continuity",
      "exit-priority",
      "settlement",
    ],
    sources: [
      "initial-snapshot",
      "recovery-boundaries",
      "recovery-inputs",
      "protection-checkpoints",
      "ledger",
    ],
  },
  {
    id: "restart",
    checks: [
      "source-integrity",
      "checkpoint-continuity",
      "idempotency",
      "residual-protection",
      "settlement",
    ],
    sources: ["before-restart", "after-restart", "fills", "ledger"],
  },
  {
    id: "settlement",
    checks: [
      "source-integrity",
      "quantity-conservation",
      "fees-funding",
      "cash-equity",
      "settlement",
    ],
    sources: ["initial-snapshot", "fills", "funding", "ledger"],
  },
] as const;
export type TradeAcceptanceCase = (typeof tradeAcceptanceCases)[number]["id"];
export type TradeAcceptanceStatus =
  "confirmed" | "violation" | "insufficient-data" | "not-applicable";
export type AcceptanceEvidence = {
  applicability: "yes" | "no" | "unknown";
  applicabilityEvidence: string[];
  checks: Array<{ id: string; outcome: "pass" | "fail" | "unknown"; evidenceIds: string[] }>;
  sources: string[];
};

export const tradeAcceptanceContract = {
  version: tradeAcceptanceVersion,
  cases: tradeAcceptanceCases,
  sides: ["BUY", "SELL"],
  statuses: ["confirmed", "violation", "insufficient-data", "not-applicable"],
  minimumConfirmedPerApplicableGroupAndSide: 1,
  observedOnlyIsNotConfirmed: true,
  missingHistoryIsNotZero: true,
  coverageGroups: [
    "executionRunId",
    "strategyVersionId",
    "configHash",
    "symbol",
    "side",
    "timeframe",
    "policyFingerprint",
    "modelFingerprint",
  ],
  tolerances: {
    newDecimalAccounting: "exact-decimal-to-18-places",
    legacyNetAbsolute: "0.00000002",
    legacyGross: "quantity * 0.000000005 + 0.00000002",
    replaySettlementAbsolute: "0.0000001",
    replayProtection: "max(1e-9, entryPrice * 1e-12)",
    openProtectionLedger: "max(1e-10, entryPrice * 1e-12)",
    instrumentSteps: "exact-pinned-tickSize-and-qtyStep",
    sourceIdsAndTimes: "exact-original-id-and-timestamp-no-clock-shift",
  },
  notes: [
    "A functional minimum of one is not statistical acceptance or proof of future profitability.",
    "Evidence assessment consumes verified check results; it does not run a trade replay.",
    "A proven local violation remains a violation even if other path evidence is missing.",
    "No observation is not evidence of policy inapplicability.",
  ],
} as const;

export function assessTradeAcceptance(caseId: TradeAcceptanceCase, input: AcceptanceEvidence) {
  const definition = tradeAcceptanceCases.find((c) => c.id === caseId);
  if (!definition) throw new Error("Unknown acceptance case");
  const required = new Set<string>(definition.checks);
  const seen = new Set<string>();
  for (const check of input.checks) {
    if (!required.has(check.id) || seen.has(check.id))
      throw new Error("Unknown or duplicate acceptance check");
    seen.add(check.id);
  }
  const hasReferences = (ids: string[]) =>
    ids.length > 0 && ids.every((id) => id.trim().length > 0);
  const failures = input.checks.filter((c) => c.outcome === "fail" && hasReferences(c.evidenceIds));
  const missingChecks = definition.checks.filter(
    (id) =>
      !input.checks.some(
        (c) => c.id === id && c.outcome === "pass" && hasReferences(c.evidenceIds),
      ),
  );
  const missingSources = definition.sources.filter((source) => !input.sources.includes(source));
  const applicabilityKnown = hasReferences(input.applicabilityEvidence);
  const status: TradeAcceptanceStatus = failures.length
    ? "violation"
    : input.applicability === "no" && applicabilityKnown
      ? "not-applicable"
      : input.applicability !== "yes" ||
          !applicabilityKnown ||
          missingChecks.length ||
          missingSources.length
        ? "insufficient-data"
        : "confirmed";
  return {
    caseId,
    status,
    failures: failures.map((c) => c.id).sort(),
    missingChecks: [...missingChecks].sort(),
    missingSources: [...missingSources].sort(),
  };
}

export type AcceptanceRunIdentity = {
  executionRunId: string;
  strategyVersionId: string;
  configHash: string;
  policyFingerprint: string;
};
export type AcceptanceBoundary = {
  asOf: string;
  knownTradeIds: string[];
  knownPositionIds: string[];
  runs: AcceptanceRunIdentity[];
};
export function classifyAcceptanceCohort(
  boundary: AcceptanceBoundary,
  position: AcceptanceRunIdentity & {
    id: string;
    tradeId: string | null;
    openedAt: string;
    createdAt: string;
  },
) {
  const cutoff = Date.parse(boundary.asOf),
    opened = Date.parse(position.openedAt),
    created = Date.parse(position.createdAt);
  if (![cutoff, opened, created].every(Number.isFinite))
    throw new Error("Invalid acceptance boundary time");
  if (position.tradeId && boundary.knownTradeIds.includes(position.tradeId))
    return "baseline-closed";
  if (boundary.knownPositionIds.includes(position.id)) return "baseline-position";
  if (opened <= cutoff || created <= cutoff) return "late-discovered";
  const run = boundary.runs.find((r) => r.executionRunId === position.executionRunId);
  return run &&
    run.strategyVersionId === position.strategyVersionId &&
    run.configHash === position.configHash &&
    run.policyFingerprint === position.policyFingerprint
    ? "new-entry-pinned"
    : "new-policy-entry";
}
