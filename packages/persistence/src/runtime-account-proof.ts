import type { Prisma } from "./generated/prisma/client";
import { hashTracePayload } from "./position-trace";
import { exitDecimal } from "./liquidity-exit-model";
import { readPinnedExecutionPolicy } from "./execution-policy-repository";

export const runtimeAccountProofVersion = "cryptoanal-account-transition@1";
export type AdmissionProof = Record<string, unknown>;
export type AccountState = {
  workspaceId: string;
  exchangeAccountId: string;
  executionRunId: string;
  observedAt: string;
  initialBalance: string | null;
  ledger: { legacyNet: string; liquidityNet: string; funding: string };
  positions: Array<{
    id: string;
    side: "BUY" | "SELL";
    quantity: string;
    entryPrice: string;
    markPrice: string;
    remainingEntryFee: string;
    managedThroughAt: string | null;
    runtimeVersion: number;
  }>;
  cashPnl: string;
  markEquityPnl: string;
  cash: string | null;
  markEquity: string | null;
};
export function accountStateAmounts(
  s: Pick<AccountState, "initialBalance" | "ledger" | "positions">,
) {
  const ledger = exitDecimal(s.ledger.legacyNet).add(s.ledger.liquidityNet).sub(s.ledger.funding);
  const cashPnl = s.positions.reduce((v, p) => v.sub(p.remainingEntryFee), ledger).toFixed();
  const markEquityPnl = s.positions
    .reduce(
      (v, p) =>
        v.add(
          exitDecimal(p.markPrice)
            .sub(p.entryPrice)
            .mul(p.quantity)
            .mul(p.side === "BUY" ? 1 : -1),
        ),
      exitDecimal(cashPnl),
    )
    .toFixed();
  return {
    cashPnl,
    markEquityPnl,
    cash: s.initialBalance === null ? null : exitDecimal(s.initialBalance).add(cashPnl).toFixed(),
    markEquity:
      s.initialBalance === null ? null : exitDecimal(s.initialBalance).add(markEquityPnl).toFixed(),
  };
}
export async function captureRuntimeAccountState(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    executionRunId: string;
    positionId?: string;
    initialBalance?: number;
  },
): Promise<AccountState> {
  const run = await tx.executionRun.findUniqueOrThrow({
    where: { id: input.executionRunId },
    select: {
      workspaceId: true,
      executionPolicy: true,
      deployment: { select: { exchangeAccountId: true } },
    },
  });
  if (run.workspaceId !== input.workspaceId) throw new Error("Account proof scope mismatch");
  const accountId = run.deployment.exchangeAccountId;
  let initial =
    input.initialBalance === undefined
      ? readPinnedExecutionPolicy(run.executionPolicy)?.payload.settings.accountSafety
          .initialBalance
      : input.initialBalance;
  if (initial === undefined && input.positionId) {
    const entry = await tx.auditEvent.findUnique({
      where: { id: `account-proof:entry:${input.positionId}` },
      select: { metadata: true },
    });
    const saved = entry?.metadata as {
      payload?: { before?: { initialBalance?: string | null } };
    } | null;
    if (saved?.payload?.before?.initialBalance != null)
      initial = Number(saved.payload.before.initialBalance);
  }
  const [totals] = await tx.$queryRaw<
    Array<{ legacyNet: string; liquidityNet: string; funding: string; observedAt: Date }>
  >`
    SELECT clock_timestamp() AS "observedAt",
    (SELECT coalesce(sum(t."netPnl"),0)::text FROM "Trade" t JOIN "ExecutionRun" r ON r.id=t."executionRunId" JOIN "Deployment" d ON d.id=r."deploymentId" JOIN "Position" p ON p.id=t."positionId" WHERE t."workspaceId"=${input.workspaceId} AND t.environment='DRY_RUN' AND d."exchangeAccountId"=${accountId} AND coalesce(p."exitPolicy"->>'fillModel','')<>'l1-ioc@1') AS "legacyNet",
    (SELECT coalesce(sum(f."realizedNetPnl"),0)::text FROM "Fill" f JOIN "Order" o ON o.id=f."orderId" JOIN "ExecutionRun" r ON r.id=o."executionRunId" JOIN "Deployment" d ON d.id=r."deploymentId" WHERE f."workspaceId"=${input.workspaceId} AND r.environment='DRY_RUN' AND d."exchangeAccountId"=${accountId}) AS "liquidityNet",
    (SELECT coalesce(sum(f.amount),0)::text FROM "PositionFundingPayment" f JOIN "Position" p ON p.id=f."positionId" JOIN "ExecutionRun" r ON r.id=p."executionRunId" JOIN "Deployment" d ON d.id=r."deploymentId" WHERE f."workspaceId"=${input.workspaceId} AND p.environment='DRY_RUN' AND d."exchangeAccountId"=${accountId}) AS funding`;
  const positions = await tx.position.findMany({
    where: {
      workspaceId: input.workspaceId,
      environment: "DRY_RUN",
      status: "OPEN",
      executionRun: { deployment: { exchangeAccountId: accountId } },
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      side: true,
      quantity: true,
      remainingQuantity: true,
      entryPrice: true,
      markPrice: true,
      entryFee: true,
      remainingEntryFee: true,
      managedThroughAt: true,
      runtimeVersion: true,
    },
  });
  const base = {
    workspaceId: input.workspaceId,
    exchangeAccountId: accountId,
    executionRunId: input.executionRunId,
    observedAt: totals!.observedAt.toISOString(),
    initialBalance: initial === undefined ? null : String(initial),
    ledger: {
      legacyNet: totals!.legacyNet,
      liquidityNet: totals!.liquidityNet,
      funding: totals!.funding,
    },
    positions: positions.map((p) => ({
      id: p.id,
      side: p.side,
      quantity: (p.remainingQuantity ?? p.quantity).toFixed(),
      entryPrice: p.entryPrice.toFixed(),
      markPrice: (p.markPrice ?? p.entryPrice).toFixed(),
      remainingEntryFee: (p.remainingEntryFee ?? p.entryFee).toFixed(),
      managedThroughAt: p.managedThroughAt?.toISOString() ?? null,
      runtimeVersion: p.runtimeVersion,
    })),
  };
  return { ...base, ...accountStateAmounts(base) };
}
export async function recordRuntimeAccountProof(
  tx: Prisma.TransactionClient,
  input: {
    before: AccountState;
    positionId: string;
    kind: "entry" | "exit" | "funding" | "settlement";
    sourceIds: string[];
    admission?: AdmissionProof;
  },
) {
  const { before, positionId, kind, sourceIds } = input;
  const after = await captureRuntimeAccountState(tx, {
    workspaceId: before.workspaceId,
    executionRunId: before.executionRunId,
    positionId,
    ...(before.initialBalance === null ? {} : { initialBalance: Number(before.initialBalance) }),
  });
  const payload = JSON.parse(
    JSON.stringify({
      version: runtimeAccountProofVersion,
      positionId,
      kind,
      sourceIds: [...sourceIds].sort(),
      before,
      after,
      admission: input.admission ?? null,
    }),
  ) as {
    version: string;
    positionId: string;
    kind: string;
    sourceIds: string[];
    before: AccountState;
    after: AccountState;
    admission: AdmissionProof | null;
  };
  const id =
    kind === "entry"
      ? `account-proof:entry:${positionId}`
      : `account-proof:${hashTracePayload({ positionId, kind, sourceIds: payload.sourceIds })}`;
  await tx.auditEvent.create({
    data: {
      id,
      workspaceId: before.workspaceId,
      actorId: "worker",
      action: "runtime.account.proof",
      resourceType: "position",
      resourceId: positionId,
      outcome: "COMPLETED",
      requestId: id,
      metadata: JSON.parse(
        JSON.stringify({ payload, hash: hashTracePayload(payload) }),
      ) as Prisma.InputJsonValue,
    },
  });
}
