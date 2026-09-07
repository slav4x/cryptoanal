import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { dockerText, postgresJson, postgresText, waitForPostgres } from "./database-docker.mjs";

const backupDirectory = path.resolve("var/backups");
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const containerName = `cryptoanal-restore-check-${suffix}`;
const volumeName = `cryptoanal-restore-check-${suffix}`;
let containerCreated = false;
let volumeCreated = false;

try {
  const manifestPath = await resolveManifestPath(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);
  const dumpPath = path.resolve(path.dirname(manifestPath), manifest.dump.file);
  const actualHash = await sha256File(dumpPath);
  if (actualHash !== manifest.dump.sha256) {
    throw new Error(
      `Backup checksum mismatch: expected ${manifest.dump.sha256}, got ${actualHash}.`,
    );
  }

  await dockerText(["volume", "create", volumeName]);
  volumeCreated = true;
  await dockerText([
    "run",
    "-d",
    "--name",
    containerName,
    "-e",
    "POSTGRES_DB=restore_check",
    "-e",
    "POSTGRES_USER=restore_check",
    "-e",
    "POSTGRES_PASSWORD=restore_check_ephemeral",
    "-v",
    `${volumeName}:/var/lib/postgresql/data`,
    manifest.source.image,
  ]);
  containerCreated = true;
  await waitForPostgres(containerName);
  await restoreDatabase(containerName, dumpPath);

  const tables = await postgresJson(
    containerName,
    "SELECT coalesce(json_agg(table_name ORDER BY table_name), '[]'::json) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  );
  const expectedTables = [...manifest.schema.tables].sort();
  const actualTables = [...tables].sort();
  if (JSON.stringify(expectedTables) !== JSON.stringify(actualTables)) {
    throw new Error("Restored table set does not match the backup manifest.");
  }

  const failedMigrations = Number(
    await postgresText(
      containerName,
      'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL',
    ),
  );
  if (failedMigrations !== 0)
    throw new Error(`Restored database has ${failedMigrations} failed migrations.`);

  const rowCounts = await countRows(containerName, actualTables);
  const report = {
    schemaVersion: 1,
    backupId: manifest.backupId,
    verifiedAt: new Date().toISOString(),
    dumpSha256: actualHash,
    postgresImage: manifest.source.image,
    tables: actualTables,
    rowCounts,
    migrations: { total: manifest.schema.migrations.length, failed: failedMigrations },
    result: "passed",
    isolation: "ephemeral container and volume; source database was not connected",
  };
  const reportPath = path.join(
    path.dirname(manifestPath),
    `${manifest.backupId}.restore-check.json`,
  );
  await writeAtomically(reportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`));

  console.log(`Restore check passed for ${manifest.backupId}.`);
  console.log(`Tables: ${actualTables.length}; migrations: ${manifest.schema.migrations.length}.`);
  console.log(`Report: ${reportPath}`);
} finally {
  if (containerCreated) await dockerText(["rm", "-f", containerName]).catch(() => undefined);
  if (volumeCreated) await dockerText(["volume", "rm", volumeName]).catch(() => undefined);
}

async function resolveManifestPath(arguments_) {
  const filtered = arguments_.filter((argument) => argument !== "--");
  const optionIndex = filtered.indexOf("--manifest");
  if (optionIndex >= 0) {
    const value = filtered[optionIndex + 1];
    if (!value) throw new Error("Missing value for --manifest.");
    return path.resolve(value);
  }
  if (filtered.length > 0) throw new Error(`Unknown argument: ${filtered[0]}`);
  const files = (await readdir(backupDirectory))
    .filter((file) => file.endsWith(".manifest.json"))
    .sort();
  const latest = files.at(-1);
  if (!latest) throw new Error("No backup manifest found. Run `pnpm db:backup` first.");
  return path.join(backupDirectory, latest);
}

async function restoreDatabase(container, dumpPath) {
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      container,
      "pg_restore",
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-privileges",
      "-U",
      "restore_check",
      "-d",
      "restore_check",
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let standardError = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    standardError = `${standardError}${chunk}`.slice(-20_000);
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const streamingError = await pipeline(createReadStream(dumpPath), child.stdin).then(
    () => null,
    (error) => error,
  );
  const exitCode = await completion;
  if (exitCode !== 0) throw new Error(`pg_restore failed: ${standardError.trim()}`);
  if (streamingError) throw streamingError;
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) throw new Error("Unsupported backup manifest schema.");
  if (
    typeof manifest.backupId !== "string" ||
    typeof manifest.dump?.file !== "string" ||
    manifest.dump.file !== path.basename(manifest.dump.file) ||
    !/^[a-f0-9]{64}$/.test(manifest.dump.sha256) ||
    typeof manifest.source?.image !== "string" ||
    !/^(postgres:[A-Za-z0-9._-]+|sha256:[a-f0-9]{64})$/.test(manifest.source.image) ||
    !Array.isArray(manifest.schema?.tables) ||
    !Array.isArray(manifest.schema?.migrations)
  ) {
    throw new Error("Backup manifest is malformed.");
  }
}

async function countRows(container, tables) {
  const counts = {};
  for (const table of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
    counts[table] = Number(await postgresText(container, `SELECT count(*) FROM "${table}"`));
  }
  return counts;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeAtomically(target, content) {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await rename(temporary, target);
}
