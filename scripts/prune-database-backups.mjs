import console from "node:console";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const retentionCount = 3;
const backupIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export async function pruneDatabaseBackups(directory, { dryRun = false } = {}) {
  const entries = await readdir(directory);
  const backups = [];
  for (const name of entries.filter((entry) => entry.endsWith(".manifest.json"))) {
    const manifestPath = path.join(directory, name);
    if (!(await lstat(manifestPath)).isFile()) continue;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) continue;
    const id = manifest.backupId;
    if (
      manifest.schemaVersion !== 1 ||
      !backupIdPattern.test(id ?? "") ||
      name !== `cryptoanal-${id}.manifest.json` ||
      manifest.dump?.file !== `cryptoanal-${id}.dump` ||
      !/^[a-f0-9]{64}$/.test(manifest.dump?.sha256 ?? "") ||
      !Number.isSafeInteger(manifest.dump?.bytes) ||
      manifest.dump.bytes <= 0 ||
      typeof manifest.source?.database !== "string" ||
      !manifest.source.database
    )
      continue;
    const dumpPath = path.join(directory, manifest.dump.file);
    const dumpStat = await lstat(dumpPath).catch(() => null);
    if (!dumpStat?.isFile()) continue;
    const reportPath = path.join(directory, `${id}.restore-check.json`);
    let report = null;
    const reportStat = await lstat(reportPath).catch(() => null);
    if (reportStat?.isFile()) {
      try {
        report = JSON.parse(await readFile(reportPath, "utf8"));
      } catch {
        // An invalid report never counts as successful verification.
      }
    }
    const verified =
      report?.schemaVersion === 1 &&
      report.backupId === id &&
      report.result === "passed" &&
      report.dumpSha256 === manifest.dump.sha256 &&
      report.migrations?.failed === 0;
    backups.push({
      id,
      manifest,
      manifestPath,
      dumpPath,
      reportPath,
      reportExists: !!reportStat?.isFile(),
      bytes: dumpStat.size,
      verified,
    });
  }
  const kept = [];
  const obsolete = [];
  // A copy of another database cannot replace a recovery point for this database.
  for (const database of new Set(backups.map((backup) => backup.manifest.source.database))) {
    const group = backups
      .filter((backup) => backup.manifest.source.database === database)
      .sort((left, right) => right.id.localeCompare(left.id));
    const retained = group.filter((backup) => backup.verified).slice(0, retentionCount);
    for (const backup of retained) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(backup.dumpPath)) hash.update(chunk);
      if (
        backup.bytes !== backup.manifest.dump.bytes ||
        hash.digest("hex") !== backup.manifest.dump.sha256
      )
        throw new Error(`Retained backup ${backup.id} failed integrity check; nothing deleted`);
    }
    kept.push(...retained);
    if (retained.length < retentionCount) continue;
    const oldestRetained = retained.at(-1).id;
    // Preserve a newer unverified copy until its restore check has completed.
    obsolete.push(...group.filter((backup) => backup.id < oldestRetained));
  }
  for (const backup of obsolete) {
    if (dryRun) continue;
    await rm(backup.dumpPath, { force: true });
    await rm(backup.manifestPath, { force: true });
    if (backup.reportExists) await rm(backup.reportPath, { force: true });
  }
  return {
    dryRun,
    kept: kept.map((backup) => backup.id),
    removed: obsolete.map((backup) => backup.id),
    reclaimedBytes: obsolete.reduce((total, backup) => total + backup.bytes, 0),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.some((arg) => arg !== "--dry-run")) throw new Error("Only --dry-run is supported");
  console.log(
    JSON.stringify(
      await pruneDatabaseBackups(path.resolve("var/backups"), {
        dryRun: args.includes("--dry-run"),
      }),
      null,
      2,
    ),
  );
}
