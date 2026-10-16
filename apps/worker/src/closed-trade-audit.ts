import { strategyConfigSchema } from "../../../packages/contracts/src/index";
import {
  assessTradeAcceptance,
  tradeAcceptanceCases,
  type TradeAcceptanceCase,
} from "../../../packages/application/src/trade-acceptance";
import {
  readExecutionInstrumentRules,
  executionInstrumentSizeFailure,
  roundExecutionStep,
  executionDecimalProduct,
  executionDecimalSum,
} from "../../../packages/application/src/execution-instrument";
import { readExecutionPositionExitPolicy } from "../../../packages/application/src/execution-position-exit";
import { entryLiquidityVersion } from "../../../packages/application/src/execution-entry-liquidity";
import {
  isLiquidityExitPolicy,
  liquidityExitVersion,
  executionExitPolicyVersion,
} from "../../../packages/application/src/execution-exit-policy";
import { hashTracePayload } from "../../../packages/persistence/src/position-trace";
import { readPinnedExecutionPolicy } from "../../../packages/persistence/src/execution-policy-repository";
import { verifyEntryExecutionProof } from "../../../packages/persistence/src/entry-execution-proof";
import { verifyExitTriggerProof } from "../../../packages/persistence/src/exit-trigger-proof";
import { verifyLiquidityExitFill } from "../../../packages/persistence/src/liquidity-exit-proof";
import {
  exitDecimal,
  type ExitPositionBasis,
} from "../../../packages/persistence/src/liquidity-exit-model";
import type { ArchivedPriceEvent } from "../../../packages/persistence/src/price-archive-codec";
import { replayRuntimeTrace } from "./runtime-trace-replay";
import {
  fundingAmount,
  type ExecutionFundingEvent,
} from "../../../packages/application/src/execution-funding";

export const closedTradeAuditVersion = "cryptoanal-closed-trade-audit@1";
export class AuditSourceUnavailable extends Error {}
export const auditObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const auditJson = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v)));
type Amount = string;
type Fill = {
  id: string;
  quantity: Amount;
  price: Amount;
  fee: Amount;
  filledAt: string;
  execution: unknown;
  realizedGrossPnl: Amount | null;
  realizedNetPnl: Amount | null;
  entryFeeAllocated: Amount | null;
  fundingAllocated: Amount | null;
};
export type ClosedTradeAuditSource = {
  asOf: string;
  config: unknown;
  configHash: string;
  run: {
    id: string;
    strategyVersionId: string;
    configHash: string;
    contextHash?: string;
    engineVersion: string;
    executionPolicy: unknown;
  };
  position: {
    id: string;
    workspaceId: string;
    executionRunId: string;
    strategyVersionId: string;
    symbol: string;
    side: "BUY" | "SELL";
    status: string;
    quantity: Amount;
    entryPrice: Amount;
    stopPrice: Amount;
    takePrice: Amount;
    trailingPrice: Amount | null;
    entryFee: Amount;
    entrySlippage: Amount;
    realizedPnl: Amount;
    openedAt: string;
    closedAt: string | null;
    createdAt: string;
    executionPolicy: unknown;
    positionExitPolicy: unknown;
    instrumentRules: unknown;
    entryExecution: unknown;
    exitPolicy: unknown;
    exitState: unknown;
    fundingPolicy: unknown;
  };
  trade: {
    id: string;
    positionId: string;
    executionRunId: string;
    strategyVersionId: string;
    symbol: string;
    side: string;
    quantity: Amount;
    averageEntryPrice: Amount;
    averageExitPrice: Amount;
    grossPnl: Amount;
    fees: Amount;
    funding: Amount;
    netPnl: Amount;
    slippage: Amount;
    exitReason: string;
    openedAt: string;
    closedAt: string;
  };
  orders: Array<{
    id: string;
    positionId: string | null;
    side: string;
    type: string;
    status: string;
    quantity: Amount;
    execution: unknown;
    fills: Fill[];
  }>;
  payments: Array<{
    id: string;
    settledAt: string;
    amount: Amount;
    quantity?: string;
    rate?: string;
    markPrice?: string;
    execution?: unknown;
  }>;
  signals: Array<{ id: string; metadata: unknown }>;
  entryDecisions: Array<{ id: string; decidedAt: string }>;
  trace: null | {
    snapshot: unknown;
    snapshotHash: string;
    fullFromEntry: boolean;
    startEventId: string;
    endEventId: string | null;
    eventCount: string | null;
    retainUntil: string | null;
    records: Array<{
      id: string;
      eventId: string | null;
      kind: string;
      payload: unknown;
      payloadHash: string;
    }>;
  };
};
export type AuditLoaders = {
  events: (cursor: bigint, through: bigint) => Promise<ArchivedPriceEvent[]>;
  funding: (id: string) => Promise<{ payload: unknown; payloadHash: string } | null>;
};
type Check = {
  id: string;
  outcome: "pass" | "fail" | "unknown";
  evidenceIds: string[];
  expected: unknown;
  actual: unknown;
};
export const auditInfrastructureFailure = (error: unknown) => {
  const value = auditObject(error);
  return (
    /^Prisma/.test(String(value.name ?? "")) ||
    /^(?:E(?:CONNRESET|CONNREFUSED|TIMEDOUT|PIPE|IO|NOSPC|NOENT)|57014|57P01|08\w{3}|P20\d\d)$/.test(
      String(value.code ?? ""),
    )
  );
};
export const missingAuditSource = (error: unknown) =>
  error instanceof AuditSourceUnavailable ||
  auditInfrastructureFailure(error) ||
  /missing|unsupported|not supported|coverage|not found|expired|incomplete|budget/i.test(
    error instanceof Error ? error.message : String(error),
  );

export async function auditClosedTrade(source: ClosedTradeAuditSource, loaders: AuditLoaders) {
  const p = source.position,
    t = source.trade,
    trace = source.trace;
  const checks: Check[] = [];
  const ref = {
    trade: `Trade:${t.id}`,
    position: `Position:${p.id}`,
    trace: `Trace:${p.id}:${trace?.snapshotHash ?? "missing"}`,
  };
  function set(
    id: string,
    outcome: Check["outcome"],
    evidenceIds: string[],
    expected: unknown,
    actual: unknown,
  ) {
    const prior = checks.findIndex((c) => c.id === id);
    const check = {
      id,
      outcome,
      evidenceIds,
      expected: auditJson(expected),
      actual: auditJson(actual),
    };
    if (prior < 0) checks.push(check);
    else checks[prior] = check;
  }
  const unknown = (id: string, reason: string) =>
    set(id, "unknown", [], "verified original evidence", reason);
  function verify(id: string, refs: string[], fn: () => unknown) {
    try {
      const value = fn();
      set(id, "pass", refs, "matched", value ?? "matched");
      return true;
    } catch (error) {
      set(
        id,
        missingAuditSource(error) ? "unknown" : "fail",
        refs,
        "matched",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }
  const require = (ok: boolean, message: string) => {
    if (!ok) throw new Error(message);
  };
  const amountEqual = (a: string, b: string, label: string, tolerance = "0") =>
    require(exitDecimal(a).sub(b).abs().lte(tolerance), `${label}: expected ${b}, actual ${a}`);
  const config = strategyConfigSchema.parse(source.config);
  const decimalExit = isLiquidityExitPolicy(p.exitPolicy);
  const moneyTolerance = decimalExit ? "0" : "0.00000002";
  const entries = source.orders.filter((o) => o.side === p.side),
    exits = source.orders.filter((o) => o.side !== p.side);
  const entryFills = entries.flatMap((o) => o.fills),
    exitFills = exits.flatMap((o) => o.fills),
    fills = [...entryFills, ...exitFills];
  const sum = (items: Array<Record<string, unknown>>, key: string) =>
    items.reduce((a, f) => a.add(String(f[key])), exitDecimal(0)).toFixed();

  verify("bindings", [ref.trade, ref.position], () => {
    require(t.positionId === p.id &&
      t.executionRunId === p.executionRunId &&
      p.executionRunId === source.run.id &&
      t.strategyVersionId === p.strategyVersionId &&
      p.strategyVersionId === source.run.strategyVersionId &&
      source.configHash === source.run.configHash &&
      t.symbol === p.symbol &&
      t.side === p.side, "Trade/position/run/config binding mismatch");
    const policy = readPinnedExecutionPolicy(p.executionPolicy);
    if (policy)
      require(policy.hash ===
        readPinnedExecutionPolicy(source.run.executionPolicy)
          ?.hash, "Position/run policy mismatch");
    require(p.status === "CLOSED" &&
      p.closedAt === t.closedAt &&
      p.openedAt === t.openedAt &&
      Date.parse(t.closedAt) >= Date.parse(t.openedAt), "Position/trade lifecycle mismatch");
    amountEqual(t.quantity, p.quantity, "Position/trade quantity");
    amountEqual(t.averageEntryPrice, p.entryPrice, "Position/trade entry price");
    amountEqual(t.netPnl, p.realizedPnl, "Position/trade realized PnL");
    return { configHash: source.configHash, executionPolicyHash: policy?.hash ?? null };
  });
  verify("trade-accounting", [ref.trade], () => {
    for (const value of [t.quantity, t.averageEntryPrice, t.averageExitPrice])
      require(exitDecimal(value).gt(0), "Nonpositive trade value");
    require(exitDecimal(t.fees).gte(0), "Negative trade fees");
    const net = exitDecimal(t.grossPnl).sub(t.fees).sub(t.funding).toFixed();
    amountEqual(t.netPnl, net, "Net PnL", moneyTolerance);
    const gross = exitDecimal(t.averageExitPrice)
      .sub(t.averageEntryPrice)
      .mul(t.quantity)
      .mul(p.side === "BUY" ? 1 : -1)
      .toFixed();
    if (decimalExit) {
      require(exitFills.every(
        (f) => f.realizedGrossPnl !== null,
      ), "Missing decimal gross fill allocation");
      amountEqual(t.grossPnl, sum(exitFills, "realizedGrossPnl"), "Decimal gross PnL");
    } else
      amountEqual(
        t.grossPnl,
        gross,
        "Gross PnL",
        exitDecimal(t.quantity).mul("0.000000005").add("0.00000002").toFixed(),
      );
    return { net, slippageAlreadyInFillPrices: t.slippage };
  });
  verify("fill-ledger", [ref.position, ...fills.map((f) => `Fill:${f.id}`)], () => {
    require(new Set(fills.map((f) => f.id)).size === fills.length, "Duplicate fill ID");
    require(new Set(source.orders.map((o) => o.id)).size ===
      source.orders.length, "Duplicate order ID");
    require(source.orders.every((o) => o.positionId === p.id), "Order position binding mismatch");
    require(entryFills.length > 0 && exitFills.length > 0, "Entry or exit fill is missing");
    for (const f of fills)
      require(exitDecimal(f.quantity).gt(0) &&
        exitDecimal(f.price).gt(0) &&
        exitDecimal(f.fee).gte(0), `Invalid fill ${f.id}`);
    amountEqual(sum(entryFills, "quantity"), p.quantity, "Entry filled quantity");
    amountEqual(sum(exitFills, "quantity"), p.quantity, "Exit filled quantity");
    amountEqual(sum(entryFills, "fee"), p.entryFee, "Entry fees", moneyTolerance);
    amountEqual(sum(fills, "fee"), t.fees, "Total fill fees", moneyTolerance);
    require(Math.min(...entryFills.map((f) => Date.parse(f.filledAt))) === Date.parse(t.openedAt) &&
      Math.max(...exitFills.map((f) => Date.parse(f.filledAt))) ===
        Date.parse(t.closedAt), "Fill/trade endpoint time mismatch");
    for (const [rows, expected] of [
      [entryFills, t.averageEntryPrice],
      [exitFills, t.averageExitPrice],
    ] as const) {
      const notional = rows.reduce(
        (s, f) => s.add(exitDecimal(f.quantity).mul(f.price)),
        exitDecimal(0),
      );
      amountEqual(
        notional.toFixed(),
        exitDecimal(expected).mul(p.quantity).toFixed(),
        "Weighted fill price",
        decimalExit
          ? exitDecimal(p.quantity).mul("0.000000000000000001").toFixed()
          : exitDecimal(p.quantity).mul("0.000000005").add("0.00000002").toFixed(),
      );
    }
    return { entries: entryFills.length, exits: exitFills.length };
  });
  verify(
    "funding-payments",
    [ref.trade, ...source.payments.map((x) => `FundingPayment:${x.id}`)],
    () => {
      require(new Set(source.payments.map((x) => x.id)).size === source.payments.length &&
        new Set(source.payments.map((x) => x.settledAt)).size ===
          source.payments.length, "Duplicate funding payment");
      for (const row of source.payments) {
        const receipt = auditObject(row.execution),
          payload = auditObject(receipt.payload),
          event = auditObject(payload.event);
        if (!receipt.payload) throw new AuditSourceUnavailable("Original funding receipt missing");
        require(hashTracePayload(payload) ===
          receipt.hash, `Funding receipt checksum mismatch: ${row.id}`);
        require(payload.positionId === p.id &&
          event.symbol === p.symbol &&
          event.settledAt === row.settledAt, "Funding receipt binding mismatch");
        for (const [actual, expected] of [
          [row.amount, payload.amount],
          [row.quantity, payload.quantity],
          [row.rate, event.rate],
          [row.markPrice, event.markPrice],
        ] as const)
          if (typeof actual !== "string" || expected === undefined || expected === null)
            throw new AuditSourceUnavailable("Funding receipt column missing");
          else amountEqual(actual, String(expected), "Funding receipt column");
        amountEqual(
          row.amount,
          fundingAmount(
            p.side === "BUY" ? "long" : "short",
            row.quantity!,
            event as ExecutionFundingEvent,
          ),
          "Funding formula",
        );
      }
      amountEqual(
        source.payments.reduce((s, x) => s.add(x.amount), exitDecimal(0)).toFixed(),
        t.funding,
        "Funding payment total",
      );
      return { payments: source.payments.length };
    },
  );
  const newEntries = entries.filter(
    (o) => auditObject(auditObject(o.execution).snapshot).version === entryLiquidityVersion,
  );
  if (newEntries.length)
    verify(
      "entry-fill",
      newEntries.map((o) => `Order:${o.id}`),
      () => {
        require(newEntries.length === 1, "Multiple entry intents for one position");
        return newEntries.map((o) => verifyEntryExecutionProof(o, config));
      },
    );
  else unknown("entry-fill", "LEGACY_ENTRY_HAS_NO_EXECUTION_RECEIPT");
  if (newEntries.length && source.entryDecisions.length)
    verify(
      "entry-timing",
      [
        ...newEntries.map((o) => `Order:${o.id}`),
        ...source.entryDecisions.map((d) => `Decision:${d.id}`),
      ],
      () => {
        require(source.entryDecisions.length === 1, "Duplicate entry decision");
        const decidedAt = Date.parse(source.entryDecisions[0]!.decidedAt);
        require(Number.isFinite(decidedAt), "Invalid entry decision time");
        for (const order of newEntries) {
          const snapshot = auditObject(auditObject(order.execution).snapshot),
            expiresAt = Date.parse(String(snapshot.expiresAt));
          require(Number.isFinite(expiresAt) &&
            decidedAt < expiresAt, "Entry persisted after pinned order expiry");
          const policy = readPinnedExecutionPolicy(snapshot.executionPolicy);
          for (const fill of order.fills) {
            const event = auditObject(auditObject(auditObject(fill.execution).payload).event);
            require(decidedAt >=
              Date.parse(String(event.receivedAt)), "Entry decision precedes local event receipt");
            if (order.type === "MARKET" && policy)
              require(decidedAt - Date.parse(String(event.observedAt)) <=
                policy.payload.settings.marketEntry
                  .ttlMs, "Stale market entry at persisted decision");
          }
        }
        return { decidedAt: source.entryDecisions[0]!.decidedAt };
      },
    );
  else unknown("entry-timing", "NO_ORIGINAL_ENTRY_DECISION_OR_RECEIPT");
  const rules = readExecutionInstrumentRules(p.instrumentRules);
  if (rules)
    verify("instrument-rules", [ref.position], () => {
      require(rules.symbol === p.symbol, "Instrument symbol mismatch");
      const reason = executionInstrumentSizeFailure(p, rules, !!p.entryExecution);
      require(reason === null, `Pinned instrument violation: ${reason}`);
      return { rules };
    });
  else unknown("instrument-rules", "NO_PINNED_INSTRUMENT_RULES");
  if (trace?.fullFromEntry)
    verify("initial-protection", [ref.trace, ref.position], () => {
      const initial = auditObject(auditObject(trace.snapshot).position);
      amountEqual(String(initial.quantity), p.quantity, "Initial quantity");
      amountEqual(String(initial.entryPrice), p.entryPrice, "Initial entry price");
      const initialRules = readExecutionInstrumentRules(initial.instrumentRules);
      const direction = p.side === "BUY" ? 1 : -1;
      for (const [field, percent, sign] of [
        ["stopPrice", config.exit.stopLossPercent, -direction],
        ["takePrice", config.exit.takeProfitPercent, direction],
      ] as const) {
        const raw = executionDecimalProduct(
          p.entryPrice,
          executionDecimalSum(1, executionDecimalProduct(percent, sign * 0.01)),
        );
        const expected = initialRules
          ? roundExecutionStep(raw, initialRules.tickSize, direction === 1 ? "ceil" : "floor")
          : raw;
        amountEqual(
          String(initial[field]),
          expected,
          `Initial ${field}`,
          initialRules ? "0" : "0.00000001",
        );
      }
      return { initialStop: initial.stopPrice, initialTake: initial.takePrice };
    });
  else unknown("initial-protection", "NO_ORIGINAL_ENTRY_CHECKPOINT");
  if (source.signals.length && entryFills.length)
    verify(
      "entry-finality",
      source.signals.map((s) => `AuditEvent:${s.id}`),
      () => {
        const times = source.signals
          .map((s) => auditObject(s.metadata))
          .filter((s) => s.status === "SIGNAL")
          .map((s) => Date.parse(String(s.observedAt)));
        if (!times.length || !times.every(Number.isFinite))
          throw new AuditSourceUnavailable("Original signal availability missing");
        const availableAt = Math.min(...times);
        for (const f of entryFills) {
          const event = auditObject(auditObject(auditObject(f.execution).payload).event);
          if (!event.receivedAt)
            throw new AuditSourceUnavailable("Original entry event receivedAt missing");
          require(Date.parse(String(event.receivedAt)) >=
            availableAt, "Entry before recorded signal availability");
        }
        return { availableAt: new Date(availableAt).toISOString() };
      },
    );
  else unknown("entry-finality", "NO_ORIGINAL_SIGNAL_AVAILABILITY");
  if (p.exitPolicy)
    verify(
      "exit-fill",
      exitFills.map((f) => `Fill:${f.id}`),
      () => {
        if (isLiquidityExitPolicy(p.exitPolicy)) {
          if (!rules) throw new AuditSourceUnavailable("Pinned instrument rules missing");
          const basis: ExitPositionBasis = {
            id: p.id,
            symbol: p.symbol,
            side: p.side,
            quantity: p.quantity,
            entryPrice: p.entryPrice,
            entryFee: p.entryFee,
            entrySlippage: p.entrySlippage,
            instrumentRules: rules,
            policy: p.exitPolicy,
          };
          return exitFills.map((f) => {
            require(auditObject(auditObject(f.execution).payload).version ===
              liquidityExitVersion, "Liquidity exit receipt missing");
            return verifyLiquidityExitFill({ ...f, filledAt: new Date(f.filledAt) }, config, basis);
          });
        }
        if (
          !["stop-loss", "take-profit", "trailing-stop", "holding-timeout"].includes(t.exitReason)
        )
          throw new AuditSourceUnavailable("Legacy nonprotective exit has no trigger receipt");
        return exitFills.map((f) => {
          require(auditObject(auditObject(f.execution).payload).version ===
            executionExitPolicyVersion, "Exit trigger receipt missing");
          return verifyExitTriggerProof(f, config, p.exitPolicy);
        });
      },
    );
  else unknown("exit-fill", "LEGACY_EXIT_HAS_NO_EXECUTION_RECEIPT");
  unknown("admission", "NO_IMMUTABLE_ACCOUNT_ADMISSION_LEDGER");
  unknown("cash-equity", "NO_IMMUTABLE_ACCOUNT_CASH_EQUITY_TRANSITION");

  let replay: Awaited<ReturnType<typeof replayRuntimeTrace>> | null = null;
  let streams = 0;
  if (trace) {
    const integrity = verify("trace-integrity", [ref.trace], () => {
      require(hashTracePayload(trace.snapshot) ===
        trace.snapshotHash, "Trace snapshot checksum mismatch");
      const snapshot = auditObject(trace.snapshot);
      if (snapshot.positionId !== undefined)
        require(snapshot.positionId === p.id, "Trace position binding mismatch");
      if (snapshot.configHash !== undefined)
        require(snapshot.configHash === source.configHash, "Trace config hash mismatch");
      if (p.executionPolicy)
        require(readPinnedExecutionPolicy(snapshot.executionPolicy)?.hash ===
          readPinnedExecutionPolicy(p.executionPolicy)
            ?.hash, "Trace/position execution policy mismatch");
      for (const r of trace.records)
        require(hashTracePayload(r.payload) ===
          r.payloadHash, `Trace record checksum mismatch: ${r.id}`);
      require(hashTracePayload(strategyConfigSchema.parse(auditObject(trace.snapshot).config)) ===
        hashTracePayload(config), "Trace/config mismatch");
      return { records: trace.records.length };
    });
    if (integrity) {
      try {
        if (trace.retainUntil && Date.parse(trace.retainUntil) <= Date.parse(source.asOf))
          throw new AuditSourceUnavailable("Trace retention expired");
        if (trace.endEventId === null)
          throw new AuditSourceUnavailable("Closed trace tail missing");
        const streamIds = new Set<string>();
        replay = await replayRuntimeTrace({
          snapshot: trace.snapshot,
          snapshotHash: trace.snapshotHash,
          fullFromEntry: trace.fullFromEntry,
          startEventId: BigInt(trace.startEventId),
          endEventId: BigInt(trace.endEventId),
          expectedEventCount: trace.eventCount === null ? null : BigInt(trace.eventCount),
          records: trace.records.map((r) => ({
            ...r,
            eventId: r.eventId === null ? null : BigInt(r.eventId),
          })),
          loadEvents: async (cursor, through) => {
            const page = await loaders.events(cursor, through);
            for (const e of page) streamIds.add(e.streamId);
            return page;
          },
          loadFundingSnapshot: loaders.funding,
          trade: { ...t, closedAt: new Date(t.closedAt) },
        });
        streams = streamIds.size;
        set(
          "recorded-replay",
          replay.gaps.length ? "unknown" : replay.differences.length ? "fail" : "pass",
          [ref.trace],
          "recorded model matched",
          auditJson(replay),
        );
      } catch (error) {
        set(
          "recorded-replay",
          missingAuditSource(error) ? "unknown" : "fail",
          [ref.trace],
          "recorded model matched",
          error instanceof Error ? error.message : String(error),
        );
      }
    } else unknown("recorded-replay", "TRACE_INTEGRITY_FAILED");
  } else {
    unknown("trace-integrity", "NO_RETAINED_TRACE");
    unknown("recorded-replay", "NO_RETAINED_TRACE");
  }
  const complete = !!(
    trace?.fullFromEntry &&
    replay?.status === "matched" &&
    replay.continuity === "continuous" &&
    streams <= 1
  );
  set(
    "continuous-path",
    complete ? "pass" : "unknown",
    complete ? [ref.trace] : [],
    "complete original lifetime path",
    {
      fullFromEntry: trace?.fullFromEntry ?? false,
      continuity: replay?.continuity ?? null,
      streams,
    },
  );
  const replayPass = checks.find((c) => c.id === "recorded-replay")?.outcome === "pass";
  for (const id of [
    "exit-priority",
    "first-eligible-trigger",
    "prospective-peak",
    "cost-aware-level",
    "monotone-protection",
    "holding-deadline",
    "checkpoint-continuity",
    "causal-recovery",
  ])
    if (complete)
      set(id, "pass", [ref.trace], "full original processor replay", { events: replay!.events });
    else unknown(id, "FULL_CONTINUOUS_REPLAY_NOT_CONFIRMED");
  const combine = (id: string, inputs: string[]) => {
    const parts = inputs.map((key) => checks.find((c) => c.id === key));
    const failed = parts.some((c) => c?.outcome === "fail");
    set(
      id,
      failed ? "fail" : parts.every((c) => c?.outcome === "pass") ? "pass" : "unknown",
      parts.flatMap((c) => c?.evidenceIds ?? []),
      inputs,
      parts.map((c) => ({ id: c?.id ?? null, outcome: c?.outcome ?? "unknown" })),
    );
  };
  combine("quantity-conservation", ["fill-ledger"]);
  combine("original-risk", ["initial-protection", "recorded-replay"]);
  if (complete)
    set("signal-finality", "pass", [ref.trace], "causal exit signal processing", "matched");
  else unknown("signal-finality", "NO_FULL_EXIT_SIGNAL_REPLAY");
  combine("settlement", ["bindings", "trade-accounting", "fill-ledger", "funding-payments"]);
  combine("fees-funding", ["settlement", ...(p.fundingPolicy ? ["recorded-replay"] : [])]);
  combine("source-integrity", ["bindings", "trace-integrity"]);
  if (complete)
    combine("residual-protection", ["initial-protection", "fill-ledger", "recorded-replay"]);
  else unknown("residual-protection", "NO_VERIFIED_COMPLETE_RESIDUAL_PATH");
  unknown("idempotency", "NO_CONTROLLED_RESTART_PAIR");
  combine("limit-ttl", ["entry-fill", "entry-timing"]);

  const entryType = entries[0]?.type ?? null;
  const partialEntry =
    entries.length === 1 && entryFills.length > 0
      ? exitDecimal(sum(entryFills, "quantity")).lt(entries[0]!.quantity)
      : null;
  const definitionPolicy = readExecutionPositionExitPolicy(p.positionExitPolicy);
  const initial = auditObject(auditObject(trace?.snapshot).position);
  const initialRisk = Number.isFinite(Number(initial.stopPrice))
    ? Math.abs(Number(initial.entryPrice) - Number(initial.stopPrice))
    : 0;
  const protectionRecords = (trace?.records ?? []).map((record) => ({
    record,
    payload: auditObject(record.payload),
  }));
  const breakEvenObserved =
    initialRisk > 0 &&
    protectionRecords.some(({ payload }) => {
      const state = auditObject(payload.profitProtectionState);
      if (typeof state.policyKey !== "string" || typeof state.bestPrice !== "number") return false;
      try {
        const key = JSON.parse(state.policyKey) as unknown[];
        return (
          typeof key[0] === "string" &&
          typeof key[1] === "number" &&
          key[1] > 0 &&
          Date.parse(String(payload.quoteAt)) >= Date.parse(key[0]) &&
          (state.bestPrice - Number(initial.entryPrice)) * (p.side === "BUY" ? 1 : -1) >=
            initialRisk * key[1]
        );
      } catch {
        return false;
      }
    });
  const trailingObserved = protectionRecords.some(({ payload }) => {
    const action = auditObject(payload.action);
    return action.trailingPrice != null || auditObject(action.protection).trailingPrice != null;
  });
  const applicability = (id: TradeAcceptanceCase): "yes" | "no" | "unknown" => {
    if (id === "market-entry" || id === "limit-entry")
      return entryType === null
        ? "unknown"
        : entryType === (id === "market-entry" ? "MARKET" : "LIMIT")
          ? "yes"
          : "no";
    if (id === "full-entry" || id === "partial-entry")
      return partialEntry === null
        ? "unknown"
        : partialEntry === (id === "partial-entry")
          ? "yes"
          : "no";
    if (id === "settlement") return "yes";
    if (id === "partial-exit") return exitFills.length > 1 ? "yes" : "unknown";
    if (["stop-loss", "take-profit", "signal-exit"].includes(id))
      return t.exitReason === id ? "yes" : "no";
    if (id === "holding-timeout")
      return t.exitReason === id
        ? "yes"
        : definitionPolicy?.maxHoldingMs == null
          ? "no"
          : "unknown";
    if (id === "break-even") return breakEvenObserved ? "yes" : "unknown";
    if (id === "trailing")
      return t.exitReason === "trailing-stop" || trailingObserved ? "yes" : "unknown";
    if (id === "recovery")
      return (replay?.recoveries ?? 0) > 0 || t.exitReason === "recovery-exit" ? "yes" : "unknown";
    return "unknown";
  };
  const cases = tradeAcceptanceCases.map((c) => {
    const applies = applicability(c.id);
    const caseChecks = c.checks.map((id) => {
      const actualId = id === "signal-finality" && c.id.endsWith("entry") ? "entry-finality" : id;
      const check = checks.find((x) => x.id === actualId);
      return check ? { ...check, id } : { id, outcome: "unknown" as const, evidenceIds: [] };
    });
    const sources: string[] = [];
    if (trace && checks.find((x) => x.id === "trace-integrity")?.outcome === "pass")
      sources.push("initial-snapshot", "protection-checkpoints");
    if (complete) sources.push("continuous-path", "signal");
    if (replayPass && (replay?.recoveries ?? 0) > 0)
      sources.push("recovery-boundaries", "recovery-inputs");
    if (newEntries.length) sources.push("entry-intent", "public-trades-l1", "cancelled-remainder");
    if (fills.length) sources.push("fills");
    if (checks.find((x) => x.id === "settlement")?.outcome === "pass")
      sources.push("ledger", "funding", "position");
    if (p.exitState || trace?.records.some((r) => r.kind === "liquidity-trigger"))
      sources.push("exit-intent");
    return {
      ...assessTradeAcceptance(c.id, {
        applicability: applies,
        applicabilityEvidence:
          applies === "unknown" ? [] : [ref.trade, ...entries.map((o) => `Order:${o.id}`)],
        checks: caseChecks,
        sources,
      }),
      applicability: applies,
    };
  });
  const failures = checks.filter((c) => c.outcome === "fail");
  const triggerRecord = trace?.records.find(
    (r) =>
      r.kind === "liquidity-trigger" ||
      (r.kind === "journal" && auditObject(auditObject(r.payload).action).kind === "close"),
  );
  const triggerPayload = auditObject(triggerRecord?.payload);
  const observedTrigger =
    auditObject(p.exitState).intent ??
    auditObject(triggerPayload.state).intent ??
    (triggerRecord
      ? {
          triggerEventId: triggerRecord.eventId,
          triggerAt: triggerPayload.quoteAt ?? null,
          triggerPrice: triggerPayload.quotePrice ?? null,
          reason: t.exitReason,
        }
      : null);
  return {
    version: closedTradeAuditVersion,
    tradeId: t.id,
    positionId: p.id,
    asOf: source.asOf,
    sourceHash: hashTracePayload(source),
    identity: {
      workspaceId: p.workspaceId,
      executionRunId: p.executionRunId,
      strategyVersionId: p.strategyVersionId,
      configHash: source.configHash,
      symbol: p.symbol,
      side: p.side,
      timeframe: config.universe.timeframe,
      executionPolicyHash: auditObject(p.executionPolicy).hash ?? null,
      traceEngine: auditObject(trace?.snapshot).executionEngineVersion ?? null,
      runEngine: source.run.engineVersion,
      contextHash: source.run.contextHash ?? null,
    },
    status: failures.length
      ? "violation"
      : cases.some((c) => c.status === "insufficient-data")
        ? "insufficient-data"
        : "confirmed",
    checks,
    cases,
    path: {
      complete,
      startEventId: trace?.startEventId ?? null,
      endEventId: trace?.endEventId ?? null,
      events: replay?.events ?? 0,
      continuity: replay?.continuity ?? null,
    },
    stages: {
      openedAt: t.openedAt,
      firstEligibleTrigger: complete ? observedTrigger : null,
      observedTrigger,
      submissions: exits.map((o) => ({
        orderId: o.id,
        snapshot: auditObject(o.execution).snapshot ?? null,
      })),
      fills: exitFills.map((f) => ({
        fillId: f.id,
        at: f.filledAt,
        price: f.price,
        quantity: f.quantity,
      })),
      completedAt: t.closedAt,
    },
  };
}
