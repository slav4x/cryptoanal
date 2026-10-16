import {
  captureRuntimeAccountState,
  recordRuntimeAccountProof,
  type AccountState,
} from "./runtime-account-proof";
import {
  enabledFundingPolicy,
  readExecutionFundingPolicy,
  fundingAmount,
  fundingExposure,
  validateFundingDataset,
  type ExecutionFundingDataset,
} from "../../application/src/execution-funding";
import { Prisma, type Position } from "./generated/prisma/client";
import type { CryptoAnalPrismaClient } from "./client";
import { hashTracePayload } from "./position-trace";
import { exitDecimal } from "./liquidity-exit-model";
import { lockRuntimeRisk } from "./runtime-risk";

export type PositionFundingState = {
  version: 1;
  throughAt: string;
  nextFundingAt: string;
  status: "ready" | "pending";
  reason: string | null;
};
export const initialPositionFundingState = (
  openedAt: Date,
  nextFundingAt: Date,
): PositionFundingState => ({
  version: 1,
  throughAt: openedAt.toISOString(),
  nextFundingAt: nextFundingAt.toISOString(),
  status: "ready",
  reason: null,
});
export function readPositionFundingState(value: unknown): PositionFundingState | null {
  if (value == null) return null;
  const s = value as PositionFundingState;
  if (
    s.version !== 1 ||
    ![s.throughAt, s.nextFundingAt].every((t) => Number.isFinite(Date.parse(t))) ||
    !["ready", "pending"].includes(s.status)
  )
    throw new Error("Invalid position funding state");
  return s;
}
export function fundingCovers(state: PositionFundingState, at: Date) {
  return (
    state.status === "ready" &&
    (Date.parse(state.throughAt) >= +at || Date.parse(state.nextFundingAt) > +at)
  );
}
export async function fundingSettlementReady(tx: Prisma.TransactionClient, p: Position, at: Date) {
  if (!p.fundingPolicy) return true;
  readExecutionFundingPolicy(p.fundingPolicy);
  const state = readPositionFundingState(p.fundingState);
  const market = await tx.fundingMarketState.findUnique({ where: { symbol: p.symbol } });
  return (
    !!state &&
    fundingCovers(state, at) &&
    !!market &&
    state.nextFundingAt === market.nextFundingAt.toISOString() &&
    Date.now() - +market.observedAt <= 120000 &&
    +market.observedAt <= Date.now() + 1000
  );
}
const json = (value: unknown) => value as Prisma.InputJsonValue;
export class FundingRepository {
  constructor(private readonly prisma: CryptoAnalPrismaClient) {}
  async saveHistory(data: ExecutionFundingDataset) {
    validateFundingDataset(data, data.symbols, new Date(data.startsAt), new Date(data.throughAt));
    const hash = hashTracePayload(data),
      id = `funding:${hash}`;
    await this.prisma.fundingHistorySnapshot.upsert({
      where: { id },
      create: { id, payload: json(data), payloadHash: hash },
      update: {},
    });
    return { id, hash, data };
  }
  async saveMarket(input: {
    data: ExecutionFundingDataset;
    nextFundingAt: Date;
    observedAt: Date;
  }) {
    if (
      input.data.symbols.length !== 1 ||
      !Number.isFinite(+input.nextFundingAt) ||
      input.nextFundingAt <= input.observedAt ||
      +input.observedAt > Date.now() + 1000
    )
      throw new Error("Invalid funding schedule");
    const snapshot = await this.saveHistory(input.data);
    await this.prisma.$executeRaw`
      INSERT INTO "FundingMarketState"(symbol,"nextFundingAt","observedAt","checkedFrom","checkedThrough","snapshotId")
      VALUES(${input.data.symbols[0]!},${input.nextFundingAt},${input.observedAt},${new Date(input.data.startsAt)},${new Date(input.data.throughAt)},${snapshot.id})
      ON CONFLICT(symbol) DO UPDATE SET "nextFundingAt"=EXCLUDED."nextFundingAt","observedAt"=EXCLUDED."observedAt",
        "checkedFrom"=EXCLUDED."checkedFrom","checkedThrough"=EXCLUDED."checkedThrough","snapshotId"=EXCLUDED."snapshotId"
      WHERE "FundingMarketState"."observedAt"<=EXCLUDED."observedAt"
    `;
    return snapshot;
  }
  listOpen() {
    return this.prisma.position.findMany({
      where: { status: "OPEN", environment: "DRY_RUN", fundingPolicy: { not: Prisma.DbNull } },
      select: {
        id: true,
        workspaceId: true,
        executionRunId: true,
        symbol: true,
        openedAt: true,
        fundingState: true,
      },
    });
  }
  async markUnavailable(symbol: string, reason: string) {
    for (const p of await this.prisma.position.findMany({
      where: {
        symbol,
        status: "OPEN",
        environment: "DRY_RUN",
        fundingPolicy: { not: Prisma.DbNull },
      },
      select: { id: true },
    }))
      await this.synchronizePosition(p.id, reason);
  }
  async synchronizePosition(positionId: string, failure?: string) {
    const scope = await this.prisma.position.findUniqueOrThrow({
      where: { id: positionId },
      select: { workspaceId: true, executionRunId: true },
    });
    return this.prisma.$transaction(async (tx) => {
      await lockRuntimeRisk(tx, scope.workspaceId);
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${scope.executionRunId}`}))`,
      );
      const p = await tx.position.findUniqueOrThrow({ where: { id: positionId } });
      if (p.status !== "OPEN" || !p.fundingPolicy) return { applied: false };
      readExecutionFundingPolicy(p.fundingPolicy);
      const before = readPositionFundingState(p.fundingState)!;
      const market = await tx.fundingMarketState.findUnique({
        where: { symbol: p.symbol },
        include: { snapshot: true },
      });
      const target = p.closedAt ?? p.managedThroughAt ?? p.openedAt;
      let state: PositionFundingState = {
        ...before,
        status: "pending",
        reason: failure ?? "FUNDING_DATA_UNAVAILABLE",
      };
      const accruedBefore = p.fundingAccrued?.toFixed() ?? "0",
        remainingBefore = p.fundingRemaining?.toFixed() ?? "0";
      let accrued = exitDecimal(accruedBefore),
        remaining = exitDecimal(remainingBefore);
      const payments: Array<{
        event: ExecutionFundingDataset["events"][number];
        quantity: string;
        amount: string;
        remainingApplied: string;
        closedAllocation: string;
      }> = [];
      let accountBefore: AccountState | undefined;
      const paymentIds: string[] = [];
      let snapshotId: string | null = null,
        snapshotHash: string | null = null;
      const appliedAt = (
        await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      )[0]!.now;
      const exits = await tx.fill.findMany({
        where: { order: { positionId: p.id, side: p.side === "BUY" ? "SELL" : "BUY" } },
        orderBy: { filledAt: "asc" },
        select: { quantity: true, filledAt: true },
      });
      const exposure = {
        quantity: p.quantity.toFixed(),
        openedAt: p.openedAt.toISOString(),
        exits: exits.map((f) => ({
          quantity: f.quantity.toFixed(),
          filledAt: f.filledAt.toISOString(),
        })),
      };
      if (
        !failure &&
        market &&
        Date.now() - +market.observedAt <= 120000 &&
        +market.observedAt <= Date.now() + 1000 &&
        market.checkedFrom <= p.openedAt
      ) {
        const data = market.snapshot.payload as unknown as ExecutionFundingDataset;
        if (hashTracePayload(data) !== market.snapshot.payloadHash)
          throw new Error("Funding source checksum mismatch");
        validateFundingDataset(
          data,
          [p.symbol],
          p.openedAt,
          new Date(Math.min(+target, +market.checkedThrough)),
        );
        snapshotId = market.snapshotId;
        snapshotHash = market.snapshot.payloadHash;
        const expected = Date.parse(before.nextFundingAt);
        const expectedMissing =
          expected <= +target &&
          expected > +p.openedAt &&
          fundingExposure(exposure, before.nextFundingAt) !== "0" &&
          !data.events.some((e) => e.symbol === p.symbol && Date.parse(e.settledAt) === expected);
        const covered =
          !expectedMissing &&
          (+market.checkedThrough >= +target || +market.nextFundingAt > +target);
        state = {
          version: 1,
          throughAt: covered ? target.toISOString() : before.throughAt,
          nextFundingAt: expectedMissing
            ? before.nextFundingAt
            : market.nextFundingAt.toISOString(),
          status: covered ? "ready" : "pending",
          reason: covered ? null : "FUNDING_SETTLEMENT_NOT_PUBLISHED",
        };
        const existing = await tx.positionFundingPayment.findMany({
          where: { positionId: p.id },
          select: { settledAt: true, execution: true },
        });
        const paid = new Map(existing.map((e) => [+e.settledAt, e]));
        for (const event of data.events
          .filter(
            (e) =>
              e.symbol === p.symbol &&
              Date.parse(e.settledAt) > +p.openedAt &&
              Date.parse(e.settledAt) <= +target,
          )
          .sort((a, b) => Date.parse(a.settledAt) - Date.parse(b.settledAt))) {
          const old = paid.get(Date.parse(event.settledAt));
          if (old) {
            const saved = old.execution as { payload: { event: unknown }; hash: string };
            if (hashTracePayload(saved.payload) !== saved.hash)
              throw new Error("Funding receipt checksum mismatch");
            if (hashTracePayload(saved.payload.event) !== hashTracePayload(event))
              throw new Error("Settled funding source changed; recomputation required");
            continue;
          }
          const quantity = fundingExposure(exposure, event.settledAt);
          if (!exitDecimal(quantity).gt(0)) continue;
          const amount = fundingAmount(p.side === "BUY" ? "long" : "short", quantity, event);
          accrued = accrued.add(amount);
          // Late settlement allocates the already closed share without changing its fill cash flow.
          const held = p.remainingQuantity ?? p.quantity;
          const remainder = exitDecimal(amount)
            .mul(held.toFixed())
            .div(quantity)
            .toDecimalPlaces(18, Prisma.Decimal.ROUND_DOWN);
          remaining = remaining.add(remainder);
          const closedAllocation = exitDecimal(amount).sub(remainder).toFixed();
          const payload = {
            version: enabledFundingPolicy.version,
            policy: enabledFundingPolicy,
            positionId: p.id,
            event,
            quantity,
            amount,
            remainingApplied: remainder.toFixed(),
            closedAllocation,
            exposure,
            snapshotId,
            snapshotHash,
          };
          accountBefore ??= await captureRuntimeAccountState(tx, {
            workspaceId: p.workspaceId,
            executionRunId: p.executionRunId,
            positionId: p.id,
          });
          const savedPayment = await tx.positionFundingPayment.create({
            data: {
              positionId: p.id,
              workspaceId: p.workspaceId,
              symbol: p.symbol,
              settledAt: new Date(event.settledAt),
              quantity,
              rate: event.rate,
              markPrice: event.markPrice,
              amount,
              execution: json({ payload, hash: hashTracePayload(payload) }),
            },
          });
          paymentIds.push(`FundingPayment:${savedPayment.id}`);
          payments.push({
            event,
            quantity,
            amount,
            remainingApplied: remainder.toFixed(),
            closedAllocation,
          });
        }
      }
      if (
        !payments.length &&
        state.status === before.status &&
        state.reason === before.reason &&
        state.nextFundingAt === before.nextFundingAt &&
        (!p.closedAt || state.throughAt === before.throughAt)
      )
        return { applied: false };
      const payload = {
        version: enabledFundingPolicy.version,
        positionId: p.id,
        targetAt: target.toISOString(),
        appliedAt: appliedAt.toISOString(),
        market: market
          ? {
              observedAt: market.observedAt.toISOString(),
              nextFundingAt: market.nextFundingAt.toISOString(),
              checkedThrough: market.checkedThrough.toISOString(),
            }
          : null,
        before,
        after: state,
        accruedBefore,
        accrued: accrued.toFixed(),
        remainingBefore,
        remaining: remaining.toFixed(),
        payments,
        exposure,
        snapshotId,
        snapshotHash,
      };
      await tx.positionTraceRecord.create({
        data: {
          positionId: p.id,
          runtimeVersion: p.runtimeVersion + 1,
          eventId: p.priceEventId,
          kind: "funding",
          payload: json(payload),
          payloadHash: hashTracePayload(payload),
        },
      });
      await tx.position.update({
        where: { id: p.id },
        data: {
          fundingState: json(state),
          fundingAccrued: accrued.toFixed(),
          fundingRemaining: remaining.toFixed(),
          realizedPnl: exitDecimal(p.realizedPnl.toFixed())
            .sub(accrued.sub(accruedBefore))
            .toFixed(),
          runtimeVersion: { increment: 1 },
        },
      });
      if (accountBefore)
        await recordRuntimeAccountProof(tx, {
          before: accountBefore,
          positionId: p.id,
          kind: "funding",
          sourceIds: paymentIds,
        });
      return { applied: true, payments: payments.length };
    });
  }
}
