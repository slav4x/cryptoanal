import console from "node:console";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { dockerText, postgresJson, postgresText, waitForPostgres } from "./database-docker.mjs";

const outputDirectory = path.resolve("var/backups");
const temporaryContainerName = `cryptoanal-backup-source-${process.pid}`;
let temporaryContainer = false;

try {
  const sourceContainer = await resolveSourceContainer();
  const generatedAt = new Date().toISOString();
  const backupId = generatedAt.replaceAll(":", "-").replace(".", "-");
  const dumpName = `cryptoanal-${backupId}.dump`;
  const dumpPath = path.join(outputDirectory, dumpName);
  const temporaryDumpPath = `${dumpPath}.tmp-${process.pid}`;
  const manifestPath = path.join(outputDirectory, `cryptoanal-${backupId}.manifest.json`);
  const image = await dockerText(["inspect", "--format", "{{.Config.Image}}", sourceContainer]);
  const database = await postgresText(sourceContainer, "SELECT current_database()");
  const postgresVersion = await postgresText(sourceContainer, "SHOW server_version");
  const tables = await postgresJson(
    sourceContainer,
    "SELECT coalesce(json_agg(table_name ORDER BY table_name), '[]'::json) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  );
  const migrations = await postgresJson(
    sourceContainer,
    "SELECT coalesce(json_agg(json_build_object('name', migration_name, 'checksum', checksum, 'finishedAt', finished_at) ORDER BY started_at), '[]'::json) FROM \"_prisma_migrations\" WHERE rolled_back_at IS NULL",
  );

  await mkdir(outputDirectory, { recursive: true });
  await dumpDatabase(sourceContainer, temporaryDumpPath);
  await rename(temporaryDumpPath, dumpPath);
  const dumpHash = await sha256File(dumpPath);
  const dumpStat = await stat(dumpPath);
  const manifest = {
    schemaVersion: 1,
    backupId,
    generatedAt,
    source: { database, image, postgresVersion },
    dump: {
      file: dumpName,
      format: "postgresql-custom",
      sha256: dumpHash,
      bytes: dumpStat.size,
    },
    schema: {
      tables,
      migrations,
    },
  };
  await writeAtomically(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  console.log(`Backup: ${dumpPath}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Size: ${dumpStat.size} bytes`);
  console.log(`SHA-256: ${dumpHash}`);
} finally {
  if (temporaryContainer) {
    await dockerText(["rm", "-f", temporaryContainerName]).catch(() => undefined);
  }
}

async function resolveSourceContainer() {
  const running = await dockerText(["compose", "ps", "--status", "running", "-q", "postgres"]);
  if (running) {
    await waitForPostgres(running);
    return running;
  }

  temporaryContainer = true;
  const containerId = await dockerText([
    "compose",
    "run",
    "-d",
    "--no-deps",
    "--name",
    temporaryContainerName,
    "postgres",
  ]);
  await waitForPostgres(containerId);
  return containerId;
}

async function dumpDatabase(container, destination) {
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const child = spawn(
    "docker",
    [
      "exec",
      container,
      "sh",
      "-lc",
      'pg_dump --format=custom --compress=9 --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
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
  try {
    await pipeline(child.stdout, output);
    const exitCode = await completion;
    if (exitCode !== 0) throw new Error(`pg_dump failed: ${standardError.trim()}`);
  } catch (error) {
    child.kill();
    await rm(destination, { force: true });
    throw error;
  }
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
