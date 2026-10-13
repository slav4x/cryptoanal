import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { createPrismaClient } from "../packages/persistence/src/index";
import { Prisma } from "../packages/persistence/src/generated/prisma/client";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  applyExecutionProfitProtection,
  evaluateExecutionPriceExit,
  settleExecutionPosition,
  type ExecutionPosition,
  type ExecutionProfitProtectionState,
} from "../packages/application/src/index";

import { recoverRuntimeGap, runtimeRecoveryMinuteRange } from "../apps/worker/src/runtime-recovery";
import { BybitPublicMarketClient } from "../packages/exchange-bybit/src/index";
const market = new BybitPublicMarketClient(
  process.env.BYBIT_PUBLIC_BASE_URL ?? "https://api.bybit.com",
  process.env.BYBIT_PROXY_URL,
);
const prisma = createPrismaClient(process.env.DATABASE_URL!);
const peak = new Date("2026-10-12T07:22:28.101Z");
const enabledAt = new Date("2026-10-12T07:00:00Z");
const through = new Date();
const policy = {
  enabledAt: enabledAt.toISOString(),
  breakEvenActivationR: 0.5,
  trailingActivationR: 1,
  trailingDistanceR: 0.5,
};
try {
  const positions = await prisma.position.findMany({
    where: {
      environment: "DRY_RUN",
      openedAt: { lt: peak },
      OR: [{ closedAt: null }, { closedAt: { gt: peak } }],
    },
    select: {
      id: true,
      symbol: true,
      side: true,
      openedAt: true,
      closedAt: true,
      entryPrice: true,
      quantity: true,
      stopPrice: true,
      takePrice: true,
      entryFee: true,
      entrySlippage: true,
      strategyVersion: { select: { config: true, strategy: { select: { name: true } } } },
      trade: { select: { netPnl: true, exitReason: true } },
    },
  });
  const cohort = positions
    .map((p) => ({ stored: p, config: strategyConfigSchema.parse(p.strategyVersion.config) }))
    .filter(
      (p) => p.config.exit.trailingStopPercent === 0 && p.config.exit.breakEvenActivationR === 0,
    );
  const results = [];
  for (const symbol of [...new Set(cohort.map((p) => p.stored.symbol))].sort()) {
    const active = cohort
      .filter((p) => p.stored.symbol === symbol)
      .map(({ stored: p, config }) => ({
        stored: p,
        config,
        state: null as ExecutionProfitProtectionState | null,
        closed: false,
        guardedNet: 0,
        guardedExit: "open",
        lastPrice: 0,
        lastAt: null as Date | null,
        streamId: null as string | null,
        position: {
          symbol,
          side: p.side === "BUY" ? "long" : "short",
          openedAt: p.openedAt,
          entryPrice: Number(p.entryPrice),
          quantity: Number(p.quantity),
          stopPrice: Number(p.stopPrice),
          takePrice: Number(p.takePrice),
          trailingPrice: null,
          bestPrice: Number(p.entryPrice),
          entryFee: Number(p.entryFee),
          entrySlippage: Number(p.entrySlippage),
          entryRegime: "neutral",
          entrySession: "us",
        } as ExecutionPosition,
      }));
    let cursor = 0n;
    let events = 0;
    let recoveredGaps = 0;
    const minutesCache = new Map<string, Awaited<ReturnType<typeof market.getLinearKlinesRange>>>();
    for (;;) {
      const batch = await prisma.$queryRaw<
        Array<{ id: bigint; price: string; observedAt: Date; streamId: string }>
      >(
        Prisma.sql`SELECT id,price::text,"observedAt","streamId" FROM "MarketPriceEvent" WHERE symbol=${symbol} AND id>${cursor} AND "observedAt">=${enabledAt} AND "observedAt"<=${through} ORDER BY id LIMIT 20000`,
      );
      if (!batch.length) break;
      cursor = batch.at(-1)!.id;
      events += batch.length;
      for (const event of batch)
        for (const p of active) {
          if (event.observedAt < p.position.openedAt) continue;
          const price = Number(event.price);
          p.lastPrice = price;
          if (p.closed) continue;
          if (p.stored.closedAt && event.observedAt > p.stored.closedAt) {
            p.guardedNet = Number(p.stored.trade!.netPnl);
            p.guardedExit = p.stored.trade!.exitReason;
            p.closed = true;
            continue;
          }
          const quote = { symbol, price, observedAt: event.observedAt };
          if (p.streamId && p.streamId !== event.streamId && p.lastAt) {
            const range = runtimeRecoveryMinuteRange(p.lastAt, event.observedAt);
            const key = `${range.start.toISOString()}:${range.end.toISOString()}`;
            let minutes = minutesCache.get(key);
            if (!minutes) {
              const stored = await prisma.marketCandle.findMany({
                where: {
                  symbol,
                  interval: "1",
                  isClosed: true,
                  openTime: { gte: range.start, lte: range.end },
                },
                orderBy: { openTime: "asc" },
              });
              const count = Math.floor((+range.end - +range.start) / 60000) + 1;
              minutes =
                stored.length === count
                  ? stored.map((c) => ({
                      ...c,
                      open: String(c.open),
                      high: String(c.high),
                      low: String(c.low),
                      close: String(c.close),
                      volume: String(c.volume),
                      turnover: String(c.turnover),
                    }))
                  : await market.getLinearKlinesRange(
                      symbol,
                      "1",
                      range.start,
                      range.end,
                      AbortSignal.timeout(15000),
                    );
              minutesCache.set(key, minutes);
            }
            const recovered = recoverRuntimeGap({
              position: p.position,
              since: p.lastAt,
              quote,
              minutes: minutes.map((c) => ({
                ...c,
                open: Number(c.open),
                high: Number(c.high),
                low: Number(c.low),
                close: Number(c.close),
                turnover: Number(c.turnover),
              })),
              signals: [],
              signalIntervalMs:
                { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 }[
                  p.config.universe.timeframe
                ] * 60000,
              config: p.config,
            });
            recoveredGaps++;
            p.position = recovered.position;
            if (recovered.settlement) {
              p.closed = true;
              p.guardedNet = recovered.settlement.netPnl;
              p.guardedExit = recovered.settlement.exitReason;
              continue;
            }
          }
          p.lastAt = event.observedAt;
          p.streamId = event.streamId;
          const exit = evaluateExecutionPriceExit(p.position, quote, p.config);
          if (exit) {
            p.closed = true;
            p.guardedNet = exit.netPnl;
            p.guardedExit = exit.exitReason;
            continue;
          }
          const guard = applyExecutionProfitProtection(
            p.position,
            quote,
            p.config,
            policy,
            p.state,
          );
          p.position = guard.position;
          p.state = guard.state;
        }
    }
    for (const p of active) {
      if (!p.lastPrice) throw new Error(`Missing price history for ${symbol}`);
      const originalNet = p.stored.trade
        ? Number(p.stored.trade.netPnl)
        : settleExecutionPosition(p.position, p.lastPrice, through, "end-of-data", p.config).netPnl;
      if (!p.closed)
        p.guardedNet = settleExecutionPosition(
          p.position,
          p.lastPrice,
          through,
          "end-of-data",
          p.config,
        ).netPnl;
      results.push({
        positionId: p.stored.id,
        symbol,
        strategy: p.stored.strategyVersion.strategy.name,
        originalExit: p.stored.trade?.exitReason ?? "open",
        originalNet,
        guardedExit: p.guardedExit,
        guardedNet: p.guardedNet,
      });
    }
    console.log(
      symbol,
      "events",
      events,
      "positions",
      active.length,
      "recovered gaps",
      recoveredGaps,
    );
  }
  const report = {
    mode: "counterfactual-price-journal-replay",
    peak: peak.toISOString(),
    enabledAt: enabledAt.toISOString(),
    through: through.toISOString(),
    policy,
    limitations: [
      "Cohort selected retrospectively among positions open at the peak; this is not a strategy backtest.",
      "Journal before activation is not replayed; future entries and signal decisions are not simulated.",
      "Open positions valued with estimated closing costs; funding follows existing DRY_RUN model.",
    ],
    positions: results.length,
    originalNet: results.reduce((sum, p) => sum + p.originalNet, 0),
    guardedNet: results.reduce((sum, p) => sum + p.guardedNet, 0),
    guardedExits: results.reduce<Record<string, number>>((r, p) => {
      r[p.guardedExit] = (r[p.guardedExit] ?? 0) + 1;
      return r;
    }, {}),
    results,
  };
  await mkdir("var/analysis", { recursive: true });
  await writeFile(
    "var/analysis/profit-protection-replay-2026-10-13.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      positions: report.positions,
      originalNet: report.originalNet,
      guardedNet: report.guardedNet,
      guardedExits: report.guardedExits,
    }),
  );
} finally {
  await prisma.$disconnect();
}
