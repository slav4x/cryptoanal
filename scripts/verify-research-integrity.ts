import {
  runRuntimeReplay,
  runValidationEngine,
  runtimeReplayEngineVersion,
  validationEngineVersion,
} from "../packages/application/src/index";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import { createHash } from "node:crypto";
import { deepStrictEqual, strictEqual } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
type GoldenFixture = {
  schemaVersion: 1;
  id: string;
  datasetVersion: string;
  datasetHash: string;
  engineVersion: string;
  runtimeEngineVersion: string;
  initialCapital: number;
  config: ReturnType<typeof strategyConfigSchema.parse>;
  candles: Array<{
    symbol: string;
    openTime: string;
    open: number;
    high: number;
    low: number;
    close: number;
    turnover: number;
  }>;
  expected: { decisions: unknown[]; trades: unknown[]; metrics: Record<string, unknown> };
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const goldenRoot = path.join(root, "research", "golden");
const fixturePaths = (await findJsonFiles(goldenRoot)).sort();
if (fixturePaths.length === 0) throw new Error("Golden fixtures are missing");

const reports = [];
for (const fixturePath of fixturePaths) {
  const fixture = parseFixture(JSON.parse(await readFile(fixturePath, "utf8")));
  const candles = fixture.candles.map((candle) => ({
    ...candle,
    openTime: new Date(candle.openTime),
  }));
  const datasetHash = createHash("sha256").update(JSON.stringify(fixture.candles)).digest("hex");
  strictEqual(datasetHash, fixture.datasetHash, `${fixture.id}: dataset hash drift`);
  strictEqual(fixture.engineVersion, validationEngineVersion, `${fixture.id}: engine drift`);
  strictEqual(
    fixture.runtimeEngineVersion,
    runtimeReplayEngineVersion,
    `${fixture.id}: runtime engine drift`,
  );

  const validation = runValidationEngine({
    config: fixture.config,
    candles,
    initialCapital: fixture.initialCapital,
    kind: "backtest",
    walkForward: null,
  });
  const runtime = runRuntimeReplay({
    config: fixture.config,
    candles,
    initialCapital: fixture.initialCapital,
  });
  strictEqual(runtime.engineVersion, fixture.runtimeEngineVersion, `${fixture.id}: replay drift`);
  const validationTrades = validation.trades.map(normalizeTrade);
  const runtimeTrades = runtime.trades.map(normalizeTrade);
  deepStrictEqual(runtimeTrades, validationTrades, `${fixture.id}: runtime/backtest trades differ`);
  strictEqual(
    runtime.metrics.trades,
    validation.metrics.trades,
    `${fixture.id}: trade count differs`,
  );
  strictEqual(runtime.metrics.netPnl, validation.metrics.netPnl, `${fixture.id}: net PnL differs`);
  strictEqual(
    runtime.metrics.totalFees,
    validation.metrics.totalFees,
    `${fixture.id}: fees differ`,
  );

  const actual = {
    decisions: runtime.decisions,
    trades: validationTrades,
    metrics: validation.metrics,
  };
  if (process.argv.includes("--print")) {
    reports.push({ fixture: fixture.id, datasetHash, expected: actual });
  } else {
    deepStrictEqual(actual, fixture.expected, `${fixture.id}: golden result drift`);
    reports.push({
      fixture: fixture.id,
      datasetHash,
      trades: validation.metrics.trades,
      netPnl: validation.metrics.netPnl,
      verdict: validation.verdict,
    });
  }
}

process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);

function normalizeTrade(trade: {
  symbol: string;
  side: "long" | "short";
  openedAt: string;
  closedAt: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  netPnl: number;
  fees: number;
  exitReason: string;
}) {
  return {
    symbol: trade.symbol,
    side: trade.side,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    quantity: trade.quantity,
    netPnl: trade.netPnl,
    fees: trade.fees,
    exitReason: trade.exitReason,
  };
}

async function findJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory()
        ? findJsonFiles(target)
        : Promise.resolve(entry.name.endsWith(".json") ? [target] : []);
    }),
  );
  return files.flat();
}

function parseFixture(value: unknown): GoldenFixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Golden fixture must be an object");
  }
  const fixture = value as Record<string, unknown>;
  if (
    fixture.schemaVersion !== 1 ||
    typeof fixture.id !== "string" ||
    typeof fixture.datasetVersion !== "string" ||
    typeof fixture.datasetHash !== "string" ||
    typeof fixture.engineVersion !== "string" ||
    typeof fixture.runtimeEngineVersion !== "string" ||
    typeof fixture.initialCapital !== "number" ||
    !Array.isArray(fixture.candles) ||
    fixture.candles.length === 0 ||
    !fixture.expected ||
    typeof fixture.expected !== "object" ||
    Array.isArray(fixture.expected)
  ) {
    throw new Error("Golden fixture metadata is invalid");
  }
  for (const candle of fixture.candles) {
    if (!isGoldenCandle(candle)) throw new Error(`${fixture.id}: invalid candle`);
  }
  const expected = fixture.expected as Record<string, unknown>;
  if (!Array.isArray(expected.decisions) || !Array.isArray(expected.trades) || !expected.metrics) {
    throw new Error(`${fixture.id}: invalid expected result`);
  }
  return {
    schemaVersion: 1,
    id: fixture.id,
    datasetVersion: fixture.datasetVersion,
    datasetHash: fixture.datasetHash,
    engineVersion: fixture.engineVersion,
    runtimeEngineVersion: fixture.runtimeEngineVersion,
    initialCapital: fixture.initialCapital,
    config: strategyConfigSchema.parse(fixture.config),
    candles: fixture.candles,
    expected: {
      decisions: expected.decisions,
      trades: expected.trades,
      metrics: expected.metrics as Record<string, unknown>,
    },
  };
}

function isGoldenCandle(value: unknown): value is GoldenFixture["candles"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candle = value as Record<string, unknown>;
  return (
    typeof candle.symbol === "string" &&
    typeof candle.openTime === "string" &&
    Number.isFinite(new Date(candle.openTime).getTime()) &&
    [candle.open, candle.high, candle.low, candle.close, candle.turnover].every(
      (item) => typeof item === "number" && Number.isFinite(item),
    )
  );
}
