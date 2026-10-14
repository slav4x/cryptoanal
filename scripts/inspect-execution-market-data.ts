import "dotenv/config";
import { Client } from "pg";
import {
  executionBookFailure,
  readExecutionMarketData,
} from "../packages/application/src/execution-market-data";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = new Client({ connectionString: process.env.DATABASE_URL });
const quantiles = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (p: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
  return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
};
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '15s'");
  const { rows } = await client.query<{
    symbol: string;
    observedAt: Date;
    receivedAt: Date;
    executionData: unknown;
    bytes: number;
  }>(`
    SELECT symbol, "observedAt", "receivedAt", "executionData", coalesce(pg_column_size("executionData"),0) AS bytes
    FROM "MarketPriceEvent" ORDER BY id DESC LIMIT 20000`);
  const groups = [...new Set(rows.map((row) => row.symbol))].map((symbol) => {
    const sample = rows.filter((row) => row.symbol === symbol);
    const counts = {
      total: sample.length,
      captured: 0,
      legacy: 0,
      usableBook: 0,
      missingBook: 0,
      staleBook: 0,
      futureBook: 0,
      invalid: 0,
      blockTrades: 0,
      rpiTrades: 0,
    };
    const spreads: number[] = [],
      observedAges: number[] = [],
      receivedAges: number[] = [],
      transport: number[] = [];
    let bytes = 0;
    for (const row of sample) {
      if (row.executionData === null) {
        counts.legacy++;
        continue;
      }
      counts.captured++;
      bytes += row.bytes;
      transport.push(+row.receivedAt - +row.observedAt);
      try {
        const data = readExecutionMarketData(row.executionData);
        if (data.trade.blockTrade) counts.blockTrades++;
        if (data.trade.rpiTrade) counts.rpiTrades++;
        const failure = executionBookFailure(data, row, 1000);
        if (failure === "BOOK_UNAVAILABLE") counts.missingBook++;
        else if (failure === "BOOK_STALE") counts.staleBook++;
        else if (failure === "BOOK_FROM_FUTURE") counts.futureBook++;
        else counts.usableBook++;
        if (data.book) {
          const bid = Number(data.book.bid[0]),
            ask = Number(data.book.ask[0]);
          spreads.push(((ask - bid) * 20000) / (ask + bid));
          observedAges.push(+row.observedAt - data.book.observedAt);
          receivedAges.push(+row.receivedAt - data.book.receivedAt);
        }
      } catch {
        counts.invalid++;
      }
    }
    return {
      symbol,
      ...counts,
      newestReceivedAt: sample[0]?.receivedAt ?? null,
      oldestReceivedAt: sample.at(-1)?.receivedAt ?? null,
      spreadBps: quantiles(spreads),
      bookObservedAgeMs: quantiles(observedAges),
      bookReceivedAgeMs: quantiles(receivedAges),
      tradeTransportMs: quantiles(transport),
      averageExecutionDataBytes: counts.captured ? bytes / counts.captured : null,
    };
  });
  const storage = (
    await client.query(`SELECT pg_total_relation_size('"MarketPriceEvent"')::text AS "hotBytes",
    pg_total_relation_size('"MarketPriceArchiveChunk"')::text AS "archiveBytes"`)
  ).rows[0];
  process.stdout.write(
    `${JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope: "public-market-inputs-only",
        depth: 1,
        bookMaximumAgeMs: 1000,
        sampleLimit: 20000,
        groups,
        storage,
      },
      null,
      2,
    )}\n`,
  );
  if (groups.some((group) => group.invalid || group.futureBook)) process.exitCode = 1;
  await client.query("COMMIT");
} finally {
  await client.end();
}
