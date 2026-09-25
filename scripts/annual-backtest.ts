import "dotenv/config";
import { createHash } from "node:crypto";
import { runValidationEngine, validationEngineVersion } from "../packages/application/src/index";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import { BybitPublicMarketClient } from "../packages/exchange-bybit/src/index";
import { createPrismaClient } from "../packages/persistence/src/index";
import type { ValidationCandle } from "../packages/application/src/index";

const workspaceId = process.env.DEVELOPMENT_WORKSPACE_ID ?? "development";
const start = new Date("2025-09-01T00:00:00.000Z");
const endExclusive = new Date("2026-09-01T00:00:00.000Z");
const initialCapital = 10_000;
const intervalByTimeframe = { "15m": "15", "1h": "60", "4h": "240" } as const;
const minutesByTimeframe = { "15m": 15, "1h": 60, "4h": 240 } as const;

const prisma = createPrismaClient();
const marketClient = new BybitPublicMarketClient(
  process.env.BYBIT_PUBLIC_BASE_URL ?? "https://api.bybit.com",
  process.env.ANNUAL_BACKTEST_PROXY_URL,
);

try {
  const strategies = await prisma.strategy.findMany({
    where: {
      workspaceId,
      status: "DEPLOYED",
      activeVersionId: { not: null },
      deployments: { some: { status: "RUNNING" } },
    },
    select: {
      id: true,
      name: true,
      activeVersion: {
        select: { id: true, version: true, configHash: true, config: true },
      },
    },
    orderBy: { name: "asc" },
  });
  if (strategies.length === 0) throw new Error("No deployed strategies found");

  const required = new Map<keyof typeof intervalByTimeframe, Set<string>>();
  for (const strategy of strategies) {
    const config = strategyConfigSchema.parse(strategy.activeVersion?.config);
    const timeframe = config.universe.timeframe;
    if (!(timeframe in intervalByTimeframe)) {
      throw new Error(`${strategy.name}: unsupported timeframe ${timeframe}`);
    }
    const symbols = required.get(timeframe as keyof typeof intervalByTimeframe) ?? new Set();
    for (const symbol of config.universe.symbols) symbols.add(symbol);
    required.set(timeframe as keyof typeof intervalByTimeframe, symbols);
  }

  const datasets = new Map<string, ValidationCandle[]>();
  const sources = new Map<string, string>();
  for (const [timeframe, symbols] of required) {
    if (timeframe === "15m") {
      for (const symbol of [...symbols].sort()) {
        process.stderr.write(`Fetching ${symbol} ${timeframe} year from Bybit...\n`);
        const candles = await marketClient.getLinearKlinesRange(
          symbol,
          intervalByTimeframe[timeframe],
          start,
          new Date(endExclusive.getTime() - 1),
        );
        const normalized = candles.map((candle) => ({
          symbol: candle.symbol,
          openTime: candle.openTime,
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
          turnover: Number(candle.turnover),
        }));
        assertComplete(symbol, timeframe, normalized);
        datasets.set(`${timeframe}:${symbol}`, normalized);
        sources.set(`${timeframe}:${symbol}`, "bybit-public-linear-klines:fetched");
      }
      continue;
    }

    const snapshot = await prisma.datasetSnapshot.findFirst({
      where: {
        workspaceId,
        timeframe,
        source: "bybit-public-linear-klines",
        startsAt: { lte: start },
        endsAt: { gte: new Date(endExclusive.getTime() - minutesByTimeframe[timeframe] * 60_000) },
      },
      orderBy: { candleCount: "desc" },
      select: { id: true, symbols: true, contentHash: true },
    });
    if (!snapshot || !Array.isArray(snapshot.symbols)) {
      throw new Error(`No full-year ${timeframe} snapshot found`);
    }
    const available = new Set(snapshot.symbols);
    for (const symbol of symbols) {
      if (!available.has(symbol)) throw new Error(`${symbol} missing in ${timeframe} snapshot`);
    }
    const rows = await prisma.datasetSnapshotCandle.findMany({
      where: {
        datasetSnapshotId: snapshot.id,
        symbol: { in: [...symbols] },
        openTime: { gte: start, lt: endExclusive },
      },
      orderBy: [{ symbol: "asc" }, { openTime: "asc" }],
      select: {
        symbol: true,
        openTime: true,
        open: true,
        high: true,
        low: true,
        close: true,
        turnover: true,
      },
    });
    for (const symbol of symbols) {
      const candles = rows
        .filter((row) => row.symbol === symbol)
        .map((row) => ({
          symbol: row.symbol,
          openTime: row.openTime,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          turnover: Number(row.turnover),
        }));
      assertComplete(symbol, timeframe, candles);
      datasets.set(`${timeframe}:${symbol}`, candles);
      sources.set(`${timeframe}:${symbol}`, `dataset-snapshot:${snapshot.contentHash}`);
    }
  }

  const results = strategies.map((strategy) => {
    const version = strategy.activeVersion;
    if (!version) throw new Error(`${strategy.name}: active version missing`);
    const config = strategyConfigSchema.parse(version.config);
    const timeframe = config.universe.timeframe as keyof typeof intervalByTimeframe;
    const candles = config.universe.symbols.flatMap((symbol) => {
      const series = datasets.get(`${timeframe}:${symbol}`);
      if (!series) throw new Error(`${strategy.name}: missing ${symbol} ${timeframe} candles`);
      return series;
    });
    const result = runValidationEngine({
      config,
      candles,
      initialCapital,
      kind: "backtest",
      walkForward: null,
    });
    return {
      strategyId: strategy.id,
      name: strategy.name,
      version: version.version,
      configHash: version.configHash,
      family: config.signal.family,
      timeframe,
      symbols: config.universe.symbols,
      verdict: result.verdict,
      gateReasons: result.gateReasons,
      metrics: {
        trades: result.metrics.trades,
        wins: result.metrics.wins,
        winRatePercent: result.metrics.winRatePercent,
        netPnl: result.metrics.netPnl,
        returnPercent: result.metrics.returnPercent,
        profitFactor: result.metrics.profitFactor,
        maxDrawdownPercent: result.metrics.maxDrawdownPercent,
        totalFees: result.metrics.totalFees,
      },
    };
  });

  const series = [...datasets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, candles]) => ({
      key,
      source: sources.get(key),
      candles: candles.length,
      hash: createHash("sha256")
        .update(
          JSON.stringify(
            candles.map((candle) => [
              candle.openTime.toISOString(),
              candle.open,
              candle.high,
              candle.low,
              candle.close,
              candle.turnover,
            ]),
          ),
        )
        .digest("hex"),
    }));
  process.stdout.write(
    `${JSON.stringify({
      period: { start: start.toISOString(), endExclusive: endExclusive.toISOString() },
      initialCapital,
      engineVersion: validationEngineVersion,
      series,
      results,
    })}\n`,
  );
} finally {
  await prisma.$disconnect();
}

function assertComplete(
  symbol: string,
  timeframe: keyof typeof minutesByTimeframe,
  candles: ValidationCandle[],
) {
  const stepMs = minutesByTimeframe[timeframe] * 60_000;
  const expected = (endExclusive.getTime() - start.getTime()) / stepMs;
  if (candles.length !== expected) {
    throw new Error(`${symbol} ${timeframe}: expected ${expected} candles, got ${candles.length}`);
  }
  for (const [index, candle] of candles.entries()) {
    if (candle.openTime.getTime() !== start.getTime() + index * stepMs) {
      throw new Error(`${symbol} ${timeframe}: candle gap at index ${index}`);
    }
  }
}
