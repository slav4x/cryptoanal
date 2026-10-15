import {
  evaluateExecutionPriceExit,
  executionProtectionLevel,
  type ExecutionPosition,
  type ExecutionStrategyConfig,
} from "../../application/src/execution-engine";
import {
  executionExitPolicyVersion,
  readExecutionExitPolicy,
} from "../../application/src/execution-exit-policy";
import { readExecutionInstrumentRules } from "../../application/src/execution-instrument";
import { Prisma } from "./generated/prisma/client";
import { hashTracePayload } from "./position-trace";

type Settlement = {
  exitPrice: string;
  grossPnl: string;
  netPnl: string;
  fees: string;
  slippage: string;
  exitReason: string;
  closedAt: Date;
};
type Event = {
  id: bigint;
  symbol: string;
  price: { toFixed(): string };
  observedAt: Date;
  receivedAt: Date;
  streamId: string;
};

export function buildExitTriggerProof(input: {
  position: ExecutionPosition;
  config: ExecutionStrategyConfig;
  event: Event;
  settlement: Settlement;
}) {
  const { position, event, settlement } = input;
  if (!position.exitPolicy) throw new Error("Exit policy is required");
  if (settlement.closedAt < event.observedAt)
    throw new Error("Exit timestamp precedes its trigger event");
  const expected = evaluateExecutionPriceExit(
    position,
    {
      symbol: event.symbol,
      price: Number(event.price.toFixed()),
      observedAt: settlement.closedAt,
      source: "LastPrice",
    },
    input.config,
  );
  if (!expected || expected.exitReason !== settlement.exitReason)
    throw new Error("Exit trigger does not match the position protection");
  for (const key of ["exitPrice", "grossPnl", "netPnl", "fees", "slippage"] as const)
    if (!new Prisma.Decimal(settlement[key]).eq(expected[key]))
      throw new Error(`Exit trigger settlement ${key} mismatch`);
  const payload = {
    version: executionExitPolicyVersion,
    source: "dry-run-lastprice-market-model",
    role: "taker",
    triggerSource: position.exitPolicy.triggerSource,
    triggerLevel:
      expected.exitReason === "take-profit"
        ? String(position.takePrice)
        : String(executionProtectionLevel(position).price),
    triggerPrice: event.price.toFixed(),
    fillReferencePrice: event.price.toFixed(),
    position: { ...position, openedAt: position.openedAt.toISOString() },
    event: {
      id: String(event.id),
      symbol: event.symbol,
      price: event.price.toFixed(),
      source: "LastPrice",
      observedAt: event.observedAt.toISOString(),
      receivedAt: event.receivedAt.toISOString(),
      streamId: event.streamId,
    },
    settlement: { ...settlement, closedAt: settlement.closedAt.toISOString() },
  };
  return { payload, hash: hashTracePayload(payload) };
}

export function verifyExitTriggerProof(
  fill: {
    quantity: string | { toFixed(): string };
    price: string | { toFixed(): string };
    fee: string | { toFixed(): string };
    filledAt: Date | string;
    execution: unknown;
  },
  config: ExecutionStrategyConfig,
  policy: unknown,
) {
  const proof = fill.execution as ReturnType<typeof buildExitTriggerProof>;
  if (!proof?.payload || proof.hash !== hashTracePayload(proof.payload))
    throw new Error("Exit trigger receipt checksum mismatch");
  const payload = proof.payload;
  if (
    payload.version !== executionExitPolicyVersion ||
    payload.source !== "dry-run-lastprice-market-model" ||
    payload.triggerSource !== "LastPrice" ||
    payload.event.source !== "LastPrice" ||
    payload.role !== "taker" ||
    hashTracePayload(readExecutionExitPolicy(payload.position.exitPolicy)) !==
      hashTracePayload(readExecutionExitPolicy(policy))
  )
    throw new Error("Exit trigger provenance mismatch");
  const position: ExecutionPosition = {
    ...payload.position,
    openedAt: new Date(payload.position.openedAt),
    ...(payload.position.instrumentRules
      ? { instrumentRules: readExecutionInstrumentRules(payload.position.instrumentRules)! }
      : {}),
  };
  const rebuilt = buildExitTriggerProof({
    position,
    config,
    event: {
      ...payload.event,
      id: BigInt(payload.event.id),
      price: new Prisma.Decimal(payload.event.price),
      observedAt: new Date(payload.event.observedAt),
      receivedAt: new Date(payload.event.receivedAt),
    },
    settlement: { ...payload.settlement, closedAt: new Date(payload.settlement.closedAt) },
  });
  const decimal = (v: string | { toFixed(): string }) =>
    new Prisma.Decimal(typeof v === "string" ? v : v.toFixed());
  const exitFee = Prisma.Decimal.max(
    new Prisma.Decimal(payload.settlement.fees).sub(position.entryFee),
    0,
  );
  if (
    rebuilt.hash !== proof.hash ||
    !decimal(fill.quantity).eq(position.quantity) ||
    !decimal(fill.price).eq(payload.settlement.exitPrice) ||
    !decimal(fill.fee).eq(exitFee) ||
    +new Date(fill.filledAt) !== Date.parse(payload.settlement.closedAt)
  )
    throw new Error("Exit trigger fill mismatch");
  return {
    status: "matched" as const,
    model: executionExitPolicyVersion,
    triggerSource: payload.triggerSource,
    reason: payload.settlement.exitReason,
    triggerLevel: payload.triggerLevel,
    triggerPrice: payload.triggerPrice,
    fillPrice: payload.settlement.exitPrice,
  };
}
