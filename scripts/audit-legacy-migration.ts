import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { gzipSync } from "node:zlib";
import { parse as parseEnv } from "dotenv";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { strategyConfigSchema } from "../packages/contracts/src/index";

const scriptVersion = 1;
const archiveTables = [
  "BotState",
  "Workspace",
  "Strategy",
  "StrategyVersion",
  "StrategyRun",
  "Position",
  "ClosedTrade",
  "Decision",
  "BacktestRun",
  "WalkForwardRun",
  "TradeTag",
  "TradeNote",
  "ReviewSession",
  "Playbook",
  "PlaybookRule",
  "PlaybookExample",
  "OiSnapshot",
] as const;
const operationalTables = ["AppLog", "WatchdogSnapshot"] as const;

type TableCount = { table: string; count: number };

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const connectionString = await resolveConnectionString(options.sourceEnv);
  const sourceUrl = new URL(connectionString);
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();

  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = await listTables(client);
    const tableCounts = await countTables(client, tables);
    const schemaFingerprint = await fingerprintSchema(client);
    const strategyValidation = await validateStrategyVersions(client, tables);
    const archive = await buildArchive(client, tables);
    await client.query("COMMIT");

    const generatedAt = new Date().toISOString();
    const batchId = `${generatedAt.replaceAll(":", "-").replace(".", "-")}-${schemaFingerprint.slice(0, 12)}`;
    const batchDirectory = path.resolve(options.output, batchId);
    const archiveBytes = gzipSync(Buffer.from(archive.content, "utf8"), { level: 9 });
    const archiveHash = sha256(archiveBytes);
    const manifest = {
      schemaVersion: 1,
      scriptVersion,
      batchId,
      generatedAt,
      source: {
        engine: "postgresql",
        host: sourceUrl.hostname,
        port: sourceUrl.port || "5432",
        database: sourceUrl.pathname.slice(1),
        schema: sourceUrl.searchParams.get("schema") ?? "public",
        schemaFingerprint,
        isolation: "repeatable read, read only",
      },
      inventory: tableCounts,
      strategyConfigValidation: strategyValidation,
      archive: {
        format: "ndjson+gzip",
        file: "archive.ndjson.gz",
        sha256: archiveHash,
        bytes: archiveBytes.byteLength,
        records: archive.records,
        includedTables: archive.includedTables,
        excludedOperationalTables: operationalTables.filter((table) => tables.has(table)),
      },
      dispositions: buildDispositions(tableCounts, strategyValidation),
      import: {
        applied: false,
        reason:
          "Audit/archive only: no legacy executable record satisfies the current strategy and execution provenance contracts.",
      },
    };

    await mkdir(batchDirectory, { recursive: true });
    await writeAtomically(path.join(batchDirectory, "archive.ndjson.gz"), archiveBytes);
    await writeAtomically(
      path.join(batchDirectory, "manifest.json"),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    );

    console.log(`Legacy snapshot: ${batchId}`);
    console.log(`Manifest: ${path.join(batchDirectory, "manifest.json")}`);
    console.log(`Archive: ${archive.records} records, sha256 ${archiveHash}`);
    console.log(
      `Strategy configs: ${strategyValidation.valid}/${strategyValidation.total} satisfy current schema`,
    );
    console.log("Target database was not connected or modified.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function parseArguments(arguments_: string[]) {
  let sourceEnv: string | undefined;
  let output = "var/legacy-migration";
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--source-env") {
      sourceEnv = requireValue(arguments_, ++index, argument);
      continue;
    }
    if (argument === "--output") {
      output = requireValue(arguments_, ++index, argument);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { sourceEnv, output };
}

function requireValue(arguments_: string[], index: number, option: string) {
  const value = arguments_[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
}

async function resolveConnectionString(sourceEnv?: string) {
  if (process.env.LEGACY_DATABASE_URL) return process.env.LEGACY_DATABASE_URL;
  if (!sourceEnv) {
    throw new Error("Set LEGACY_DATABASE_URL or pass --source-env with a legacy env file path.");
  }
  const environment = parseEnv(await readFile(path.resolve(sourceEnv)));
  if (!environment.DATABASE_URL) throw new Error(`DATABASE_URL is missing in ${sourceEnv}`);
  return environment.DATABASE_URL;
}

async function listTables(client: PoolClient) {
  const result = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  return new Set(result.rows.map((row) => row.table_name));
}

async function countTables(client: PoolClient, tables: Set<string>): Promise<TableCount[]> {
  const counts: TableCount[] = [];
  for (const table of [...tables].filter((name) => name !== "_prisma_migrations").sort()) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${quoteIdentifier(table)}`,
    );
    counts.push({ table, count: Number(result.rows[0]?.count ?? 0) });
  }
  return counts;
}

async function fingerprintSchema(client: PoolClient) {
  const [columns, migrations] = await Promise.all([
    client.query(
      "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
    ),
    client.query(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at',
    ),
  ]);
  return sha256(
    Buffer.from(JSON.stringify({ columns: columns.rows, migrations: migrations.rows })),
  );
}

async function validateStrategyVersions(client: PoolClient, tables: Set<string>) {
  if (!tables.has("StrategyVersion")) return { total: 0, valid: 0, invalid: 0, issues: [] };
  const result = await client.query<{
    id: string;
    strategyId: string;
    version: number;
    config: unknown;
  }>(
    'SELECT id, "strategyId", version, config FROM "StrategyVersion" ORDER BY "strategyId", version',
  );
  const issues: Array<{ sourceId: string; strategyId: string; version: number; paths: string[] }> =
    [];
  let valid = 0;
  for (const row of result.rows) {
    const parsed = strategyConfigSchema.safeParse(row.config);
    if (parsed.success) {
      valid += 1;
      continue;
    }
    issues.push({
      sourceId: row.id,
      strategyId: row.strategyId,
      version: row.version,
      paths: [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].slice(0, 12),
    });
  }
  return { total: result.rowCount ?? result.rows.length, valid, invalid: issues.length, issues };
}

async function buildArchive(client: PoolClient, tables: Set<string>) {
  const lines: string[] = [];
  const includedTables: string[] = [];
  let records = 0;
  for (const table of archiveTables) {
    if (!tables.has(table)) continue;
    includedTables.push(table);
    const result = await client.query<QueryResultRow>(
      `SELECT * FROM ${quoteIdentifier(table)} ORDER BY 1`,
    );
    for (const record of result.rows) {
      lines.push(JSON.stringify({ sourceTable: table, record }));
      records += 1;
    }
  }
  return { content: `${lines.join("\n")}\n`, includedTables, records };
}

function buildDispositions(counts: TableCount[], validation: { total: number; valid: number }) {
  const count = (...tables: string[]) =>
    counts
      .filter((item) => tables.includes(item.table))
      .reduce((total, item) => total + item.count, 0);
  return [
    {
      sourceTables: ["Workspace"],
      records: count("Workspace"),
      disposition: "merge-manually",
      reason: "The target development workspace already exists and remains the ownership root.",
    },
    {
      sourceTables: ["Strategy", "StrategyVersion", "StrategyRun"],
      records: count("Strategy", "StrategyVersion", "StrategyRun"),
      disposition: validation.valid > 0 ? "manual-review" : "archive",
      reason:
        "Legacy flat configs and run snapshots do not satisfy the current sectioned config and execution-context contracts.",
    },
    {
      sourceTables: ["ClosedTrade", "Position", "Decision"],
      records: count("ClosedTrade", "Position", "Decision"),
      disposition: "archive",
      reason: "Records lack mandatory strategyVersionId and executionRunId provenance.",
    },
    {
      sourceTables: ["BacktestRun", "WalkForwardRun"],
      records: count("BacktestRun", "WalkForwardRun"),
      disposition: "archive",
      reason: "Records lack immutable dataset snapshots, config hashes and engine provenance.",
    },
    {
      sourceTables: [
        "TradeTag",
        "TradeNote",
        "ReviewSession",
        "Playbook",
        "PlaybookRule",
        "PlaybookExample",
      ],
      records: count(
        "TradeTag",
        "TradeNote",
        "ReviewSession",
        "Playbook",
        "PlaybookRule",
        "PlaybookExample",
      ),
      disposition: "archive",
      reason:
        "Research records depend on legacy trades or do not meet current required content fields.",
    },
    {
      sourceTables: [...operationalTables],
      records: count(...operationalTables),
      disposition: "exclude",
      reason:
        "High-volume operational telemetry is not product history and may contain unsafe context.",
    },
  ];
}

function quoteIdentifier(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

async function writeAtomically(target: string, content: Uint8Array) {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await rename(temporary, target);
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

await main();
