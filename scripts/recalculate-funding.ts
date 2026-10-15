import "dotenv/config";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createPrismaClient,
  hashTracePayload,
  exitDecimal,
} from "../packages/persistence/src/index";
import {
  fundingAmount,
  fundingExposure,
  enabledFundingPolicy,
  type ExecutionFundingDataset,
} from "../packages/application/src/execution-funding";
import { BybitPublicMarketClient } from "../packages/exchange-bybit/src/index";
const output = process.argv.slice(2).filter((a) => a !== "--")[0];
if (!process.env.DATABASE_URL || !output)
  throw new Error("Usage: pnpm runtime:recalculate-funding <output.json>");
const prisma = createPrismaClient(process.env.DATABASE_URL);
const market = new BybitPublicMarketClient(
  process.env.BYBIT_PUBLIC_BASE_URL ?? "https://api.bybit.com",
  process.env.BYBIT_PROXY_URL,
);
try {
  const trades = await prisma.trade.findMany({
    where: { environment: "DRY_RUN" },
    orderBy: { id: "asc" },
    include: { position: { include: { orders: { include: { fills: true } } } } },
  });
  const saved = trades.map((t) => ({
    id: t.id,
    positionId: t.positionId,
    netPnl: t.netPnl.toFixed(),
    funding: t.funding.toFixed(),
    openedAt: t.openedAt.toISOString(),
    closedAt: t.closedAt.toISOString(),
    quantity: t.quantity.toFixed(),
  }));
  const datasets: ExecutionFundingDataset[] = [];
  for (const symbol of [...new Set(trades.map((t) => t.symbol))].sort()) {
    const cohort = trades.filter((t) => t.symbol === symbol),
      startsAt = new Date(cohort.reduce((m, t) => Math.min(m, +t.openedAt), Infinity)),
      throughAt = new Date(cohort.reduce((m, t) => Math.max(m, +t.closedAt), -Infinity));
    datasets.push({
      version: 1,
      policy: enabledFundingPolicy,
      symbols: [symbol],
      startsAt: startsAt.toISOString(),
      throughAt: throughAt.toISOString(),
      coverage: "complete",
      events: await market.getLinearFundingHistory(
        symbol,
        startsAt,
        throughAt,
        AbortSignal.timeout(120000),
      ),
    });
  }
  const results = trades.map((t) => {
    const data = datasets.find((d) => d.symbols.includes(t.symbol))!;
    const exposure = {
      quantity: t.quantity.toFixed(),
      openedAt: t.openedAt.toISOString(),
      exits: t.position.orders
        .filter((o) => o.side !== t.side)
        .flatMap((o) =>
          o.fills.map((f) => ({
            quantity: f.quantity.toFixed(),
            filledAt: f.filledAt.toISOString(),
          })),
        ),
    };
    const payments = data.events
      .filter(
        (e) => Date.parse(e.settledAt) > +t.openedAt && Date.parse(e.settledAt) <= +t.closedAt,
      )
      .map((event) => ({ event, quantity: fundingExposure(exposure, event.settledAt) }))
      .filter((p) => exitDecimal(p.quantity).gt(0))
      .map((p) => ({
        ...p,
        amount: fundingAmount(t.side === "BUY" ? "long" : "short", p.quantity, p.event),
      }));
    const funding = payments.reduce((sum, p) => sum.add(p.amount), exitDecimal(0));
    return {
      tradeId: t.id,
      positionId: t.positionId,
      symbol: t.symbol,
      side: t.side,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      storedNetPnl: t.netPnl.toFixed(),
      storedFunding: t.funding.toFixed(),
      scenarioFunding: funding.toFixed(),
      scenarioNetPnl: exitDecimal(t.netPnl).add(t.funding.toFixed()).sub(funding).toFixed(),
      payments,
    };
  });
  const current = await prisma.trade.findMany({
    where: { id: { in: trades.map((t) => t.id) } },
    orderBy: { id: "asc" },
  });
  const after = current.map((t) => ({
    id: t.id,
    positionId: t.positionId,
    netPnl: t.netPnl.toFixed(),
    funding: t.funding.toFixed(),
    openedAt: t.openedAt.toISOString(),
    closedAt: t.closedAt.toISOString(),
    quantity: t.quantity.toFixed(),
  }));
  if (hashTracePayload(after) !== hashTracePayload(saved))
    throw new Error("Saved trade cohort changed during funding calculation");
  const totals = {
    trades: results.length,
    payments: results.reduce((s, r) => s + r.payments.length, 0),
    funding: results.reduce((s, r) => s.add(r.scenarioFunding), exitDecimal(0)).toFixed(),
    storedNetPnl: results.reduce((s, r) => s.add(r.storedNetPnl), exitDecimal(0)).toFixed(),
    scenarioNetPnl: results.reduce((s, r) => s.add(r.scenarioNetPnl), exitDecimal(0)).toFixed(),
  };
  await mkdir(dirname(resolve(output)), { recursive: true });
  const payload = {
    version: 1,
    kind: "separate-funding-scenario",
    asOf: new Date().toISOString(),
    policy: enabledFundingPolicy,
    sourceTradeHash: hashTracePayload(saved),
    sourceTradesUnchanged: true,
    totals,
    snapshots: datasets.map((payload) => ({ payload, hash: hashTracePayload(payload) })),
    results,
  };
  await writeFile(
    output,
    JSON.stringify({ ...payload, hash: hashTracePayload(payload) }, null, 2) + "\n",
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify({ output, totals, sourceTradesUnchanged: true }) + "\n");
} finally {
  await prisma.$disconnect();
}
