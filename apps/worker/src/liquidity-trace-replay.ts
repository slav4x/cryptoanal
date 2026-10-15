import { strategyConfigSchema } from "@cryptoanal/contracts";
import { readExecutionMarketData } from "@cryptoanal/application";
import {
  verifyFundingRecord,
  verifyFundingAllocation,
  fundingCovers,
  type FundingReplayBalance,
  hashTracePayload,
  evaluateLiquidityExitOrder,
  initialLiquidityExitState,
  remainingExitQuantity,
  liquidityExitSettlement,
  exitDecimal,
  verifyLiquidityExitStep,
  exitReceiptEvent,
  type ExitPositionBasis,
  type LiquidityExitState,
  type LiquidityExitStep,
  type ArchivedPriceEvent,
} from "@cryptoanal/persistence";
import type { RuntimeTraceReplayInput, replayRuntimeTraceBase } from "./runtime-trace-replay";

type Trigger = {
  basis: ExitPositionBasis;
  state: LiquidityExitState;
  origin: string;
  recordedAt: string;
  quotePrice: string;
  action: { kind: "close"; settlement: { exitReason: string } };
};
export async function replayLiquidityRuntimeTrace(
  input: RuntimeTraceReplayInput,
  base: typeof replayRuntimeTraceBase,
) {
  if (hashTracePayload(input.snapshot) !== input.snapshotHash)
    throw new Error("Trace snapshot checksum mismatch");
  for (const r of input.records)
    if (hashTracePayload(r.payload) !== r.payloadHash)
      throw new Error("Trace record checksum mismatch");
  const snapshot = input.snapshot as { position: Record<string, unknown>; config: unknown };
  const config = strategyConfigSchema.parse(snapshot.config);
  const triggerIndex = input.records.findIndex((r) => r.kind === "liquidity-trigger"),
    record = input.records[triggerIndex]!;
  if (
    input.records.filter((r) => r.kind === "liquidity-trigger").length !== 1 ||
    record.eventId === null
  )
    throw new Error("Liquidity exit trigger duplicated or missing");
  const trigger = record.payload as Trigger,
    basis = trigger.basis;
  for (const key of [
    "symbol",
    "side",
    "quantity",
    "entryPrice",
    "entryFee",
    "entrySlippage",
    "instrumentRules",
  ] as const)
    if (hashTracePayload(basis[key]) !== hashTracePayload(snapshot.position[key]))
      throw new Error(`Liquidity trace original ${key} mismatch`);
  if (hashTracePayload(basis.policy) !== hashTracePayload(snapshot.position.exitPolicy))
    throw new Error("Liquidity trace original policy mismatch");
  if (
    hashTracePayload(initialLiquidityExitState(basis, trigger.state.intent)) !==
      hashTracePayload(trigger.state) ||
    trigger.state.intent.triggerEventId !== String(record.eventId) ||
    trigger.state.intent.requestedAt !== trigger.recordedAt ||
    trigger.state.intent.reason !== trigger.action.settlement.exitReason ||
    trigger.state.intent.source !== trigger.origin
  )
    throw new Error("Liquidity trace initial intent mismatch");
  const automatic = !["manual", "independent-risk-guard"].includes(trigger.origin);
  const prefixRecords = input.records
    .slice(0, triggerIndex)
    .filter((r) => r.kind === "journal" || r.kind === "funding");
  const prefixEnd = automatic
    ? record.eventId
    : (prefixRecords.at(-1)?.eventId ?? input.startEventId);
  let availableEvents = 0,
    prefixEvents = 0;
  const events: ArchivedPriceEvent[] = [];
  let readThrough = input.startEventId - 1n;
  while (readThrough < input.endEventId) {
    const batch = await input.loadEvents(readThrough, input.endEventId);
    if (!batch.length) break;
    if (
      batch.some(
        (e, i) =>
          e.id <= readThrough || e.id > input.endEventId || (i > 0 && e.id <= batch[i - 1]!.id),
      )
    )
      throw new Error("Liquidity trace event order mismatch");
    availableEvents += batch.filter((e) => e.id > input.startEventId).length;
    prefixEvents += batch.filter((e) => e.id > input.startEventId && e.id <= prefixEnd!).length;
    events.push(...batch.filter((e) => e.id >= record.eventId!));
    readThrough = batch.at(-1)!.id;
  }
  const triggerEvent = events.find((e) => e.id === record.eventId);
  if (automatic) prefixRecords.push({ ...record, kind: "journal" });
  const prefix = await base({
    ...input,
    records: prefixRecords,
    endEventId: prefixEnd!,
    expectedEventCount: BigInt(prefixEvents),
    trade: null,
  });
  const differences = [...prefix.differences],
    gaps = [...prefix.gaps];
  if (
    !triggerEvent ||
    triggerEvent.price !== trigger.quotePrice ||
    trigger.state.intent.triggerPrice !== trigger.quotePrice ||
    trigger.state.intent.triggerAt !== triggerEvent.observedAt.toISOString()
  )
    gaps.push("Original liquidity trigger event missing or mismatched");
  if (
    automatic &&
    (!prefix.settlement ||
      prefix.settlement.exitReason !== trigger.state.intent.reason ||
      prefix.throughEventId !== String(record.eventId))
  )
    differences.push("Liquidity automatic intent does not match original price processing");
  let state = trigger.state,
    cursor = record.eventId,
    fills = 0,
    steps = 0,
    finalAt: Date | null = null;
  let fundingBalance: FundingReplayBalance | null = prefix.fundingBalance ?? null;
  const fundingBasis = {
    id: basis.id,
    symbol: basis.symbol,
    side: basis.side,
    quantity: basis.quantity,
    openedAt: String(snapshot.position.openedAt),
  };
  const exits: Array<{ quantity: string; filledAt: string }> = [];
  const sources = new Map<string, string>();
  for (const r of input.records.slice(triggerIndex + 1)) {
    if (r.kind === "settlement") continue;
    if (r.kind === "funding") {
      if (!fundingBalance || r.eventId !== cursor)
        throw new Error("Unexpected funding exit record");
      fundingBalance = await verifyFundingRecord(
        r.payload,
        fundingBasis,
        fundingBalance,
        exits,
        input.loadFundingSnapshot,
      );
      continue;
    }
    if (r.kind === "liquidity-finalize") {
      const finalized = r.payload as {
        before: typeof state;
        after: typeof state;
        funding: string;
        closedAt: string;
      };
      if (
        !fundingBalance ||
        r.eventId !== cursor ||
        remainingExitQuantity(state) !== "0" ||
        hashTracePayload(finalized.before) !== hashTracePayload(state) ||
        hashTracePayload(finalized.after) !== hashTracePayload({ ...state, waitingReason: null }) ||
        !exitDecimal(finalized.funding).eq(fundingBalance.accrued) ||
        !fundingCovers(fundingBalance.state, new Date(finalized.closedAt)) ||
        finalized.closedAt !== finalAt?.toISOString()
      )
        throw new Error("Funding exit finalization mismatch");
      state = finalized.after;
      continue;
    }

    if (r.kind !== "liquidity-step")
      throw new Error("Unexpected management after liquidity exit intent");
    const step = r.payload as LiquidityExitStep;
    if (
      step.scan.cursor !== String(cursor) ||
      r.eventId !== BigInt(step.event.id) ||
      r.eventId < cursor ||
      BigInt(step.scan.latestEventId) < r.eventId
    )
      throw new Error("Liquidity trace cursor mismatch");
    const original = events.find((e) => e.id === r.eventId);
    const copied = exitReceiptEvent(step.event);
    if (
      !original ||
      original.symbol !== copied.symbol ||
      original.price !== step.event.price ||
      +original.observedAt !== +copied.observedAt ||
      +original.receivedAt !== +copied.receivedAt ||
      original.streamId !== copied.streamId ||
      hashTracePayload(original.executionData ?? null) !==
        hashTracePayload(copied.executionData ?? null)
    ) {
      gaps.push(`Original liquidity event missing or mismatched at ${r.eventId}`);
      break;
    }
    if (step.before.order && ["fill", "cancel", "wait"].includes(step.action.kind)) {
      const order = step.before.order.snapshot;
      for (const e of events.filter((e) => e.id > cursor && e.id < r.eventId!)) {
        const result = evaluateLiquidityExitOrder(order, { ...e, price: Number(e.price) });
        if (result.kind !== "wait")
          throw new Error("Liquidity trace skipped an earlier executable event");
      }
      const a = step.action;
      if (a.kind === "fill" || a.kind === "cancel" || a.kind === "wait") {
        const market = original.executionData
          ? readExecutionMarketData(original.executionData)
          : null;
        if (a.result.kind === "fill" && market?.book) {
          const book = market.book;
          const used = events
            .filter(
              (e) =>
                e.id > BigInt(order.ioc.submitEventId) &&
                e.id < r.eventId! &&
                e.streamId === original.streamId &&
                +e.observedAt >= book.observedAt &&
                +e.receivedAt <= +original.receivedAt,
            )
            .reduce((sum, e) => {
              if (!e.executionData) return sum;
              const m = readExecutionMarketData(e.executionData);
              return m.book?.updateId === book.updateId &&
                m.trade.blockTrade !== true &&
                m.trade.rpiTrade !== true &&
                m.trade.takerSide === (order.ioc.side === "long" ? "Buy" : "Sell") &&
                (order.ioc.side === "long"
                  ? exitDecimal(e.price).gte(book.ask[0])
                  : exitDecimal(e.price).lte(book.bid[0]))
                ? sum.add(m.trade.quantity)
                : sum;
            }, exitDecimal(0));
          if (
            !used.eq(a.publicConsumed) ||
            exitDecimal(a.own).lt(sources.get(a.result.sourceKey) ?? "0")
          )
            throw new Error("Liquidity trace consumed source mismatch");
          sources.set(
            a.result.sourceKey,
            exitDecimal(sources.get(a.result.sourceKey) ?? "0")
              .add(a.result.quantity)
              .toFixed(),
          );
        }
        if (
          a.result.kind === "cancel" &&
          a.result.reason === "EXIT_ORDER_EXPIRED" &&
          (!step.scan.exhausted || step.scan.latestEventId !== step.event.id)
        )
          throw new Error("Liquidity expiry before scanning all recorded events");
      }
    } else if (step.scan.latestEventId !== step.event.id)
      throw new Error("Liquidity placement does not use its latest event");
    if (step.action.kind === "fill" && step.action.result.kind === "fill" && fundingBalance) {
      const allocation = verifyFundingAllocation(
        step.fundingAllocation,
        fundingBalance.remaining,
        step.action.result.quantity,
        remainingExitQuantity(state),
      );
      if (!exitDecimal(allocation.accrued).eq(fundingBalance.accrued))
        throw new Error("Funding accrued balance at fill mismatch");
      fundingBalance = { ...fundingBalance, remaining: allocation.remaining };
    }
    state = verifyLiquidityExitStep(step, config, basis, state).state;
    cursor = r.eventId;
    steps++;
    if (step.action.kind === "fill") {
      fills++;
      if (step.action.result.kind !== "fill") throw new Error("Missing exit fill result");
      exits.push({
        quantity: step.action.result.quantity,
        filledAt: original.observedAt.toISOString(),
      });
      finalAt = original.observedAt;
    }
  }
  if (input.expectedEventCount === null || BigInt(availableEvents) !== input.expectedEventCount)
    gaps.push("Liquidity trace event coverage mismatch");
  if (cursor !== input.endEventId) gaps.push("Liquidity trace tail does not match position cursor");
  const priced =
    exitDecimal(remainingExitQuantity(state)).eq(0) &&
    finalAt &&
    state.waitingReason !== "EXIT_WAITING_FUNDING"
      ? liquidityExitSettlement(state, finalAt)
      : null;
  const final = priced
    ? {
        ...priced,
        ...(fundingBalance ? { funding: fundingBalance.accrued } : {}),
        netPnl: exitDecimal(priced.netPnl)
          .sub(fundingBalance?.accrued ?? "0")
          .toFixed(),
      }
    : null;
  const settlements = input.records.filter((r) => r.kind === "settlement");
  if (final) {
    if (
      settlements.length !== 1 ||
      hashTracePayload(settlements[0]!.payload) !==
        hashTracePayload({ ...final, closedAt: final.closedAt.toISOString() })
    )
      differences.push("Liquidity settlement checkpoint mismatch");
  } else if (settlements.length) differences.push("Unexpected liquidity settlement checkpoint");
  if (input.trade) {
    if (!final) differences.push("Closed trade has an unfilled liquidity remainder");
    else {
      if (final.exitReason !== input.trade.exitReason || +final.closedAt !== +input.trade.closedAt)
        differences.push("Liquidity trade reason or time mismatch");
      if (fundingBalance && !exitDecimal(input.trade.funding ?? "0").eq(fundingBalance.accrued))
        differences.push("Trade funding mismatch");
      for (const [actual, expected] of [
        [final.exitPrice, input.trade.averageExitPrice],
        [final.grossPnl, input.trade.grossPnl],
        [final.netPnl, input.trade.netPnl],
        [final.fees, input.trade.fees],
        [final.slippage, input.trade.slippage],
      ] as const)
        if (!exitDecimal(actual).eq(expected))
          differences.push("Liquidity trade settlement mismatch");
    }
  } else if (final) differences.push("Filled liquidity exit has no trade");
  return {
    ...prefix,
    ...(fundingBalance ? { fundingBalance } : {}),
    status: gaps.length ? "incomplete" : differences.length ? "mismatch" : "matched",
    events: availableEvents,
    availableEvents,
    checkpoints: prefix.checkpoints + steps + 1,
    throughEventId: String(cursor),
    differences,
    gaps,
    settlement: final
      ? {
          ...final,
          ...(fundingBalance ? { funding: Number(fundingBalance.accrued) } : {}),
          exitPrice: Number(final.exitPrice),
          grossPnl: Number(final.grossPnl),
          netPnl: Number(final.netPnl),
          fees: Number(final.fees),
          slippage: Number(final.slippage),
          closedAt: final.closedAt.toISOString(),
        }
      : null,
    liquidity: {
      steps,
      fills,
      remainingQuantity: remainingExitQuantity(state),
      realizedPnl: exitDecimal(state.netPnl)
        .sub(fundingBalance?.accrued ?? "0")
        .toFixed(),
    },
    limits: [
      ...prefix.limits,
      "Shared-account consumption is recorded per fill; global source capacity is checked by runtime:ledger",
      ...(!automatic ? ["Manual and risk-guard exit intents are external inputs"] : []),
    ],
  };
}
