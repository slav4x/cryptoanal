import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";

type CaptureDryRunSnapshotInput = {
  workspaceId: string;
  exchangeAccountId: string;
  initialBalance: string;
  observedAt?: Date;
};

export class AccountSnapshotRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async captureDryRunSnapshot({
    workspaceId,
    exchangeAccountId,
    initialBalance,
    observedAt = new Date(),
  }: CaptureDryRunSnapshotInput) {
    const [tradeAggregate, positions] = await Promise.all([
      this.prisma.trade.aggregate({
        where: { workspaceId, environment: "DRY_RUN" },
        _sum: { netPnl: true },
      }),
      this.prisma.position.findMany({
        where: { workspaceId, environment: "DRY_RUN", status: "OPEN" },
        select: { unrealizedPnl: true },
      }),
    ]);

    const realizedPnl = tradeAggregate._sum.netPnl ?? new Prisma.Decimal(0);
    const unrealizedPnl = positions.reduce(
      (sum, position) => sum.add(position.unrealizedPnl),
      new Prisma.Decimal(0),
    );
    const equity = new Prisma.Decimal(initialBalance).add(realizedPnl).add(unrealizedPnl);

    return this.prisma.accountSnapshot.create({
      data: {
        workspaceId,
        exchangeAccountId,
        environment: "DRY_RUN",
        equity,
        availableBalance: null,
        observedAt,
      },
      select: { equity: true, observedAt: true },
    });
  }
}
