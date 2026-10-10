import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pruneDatabaseBackups } from "../scripts/prune-database-backups.mjs";

async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cryptoanal-backup-retention-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function backup(dir, index, { verified = true, database = "cryptoanal_dev" } = {}) {
  const id = `2026-10-${String(index).padStart(2, "0")}T00-00-00-000Z`;
  const content = `database ${database} at ${id}`;
  const sha256 = createHash("sha256").update(content).digest("hex");
  const manifest = {
    schemaVersion: 1,
    backupId: id,
    source: { database },
    dump: { file: `cryptoanal-${id}.dump`, bytes: Buffer.byteLength(content), sha256 },
  };
  await writeFile(path.join(dir, manifest.dump.file), content);
  await writeFile(path.join(dir, `cryptoanal-${id}.manifest.json`), JSON.stringify(manifest));
  if (verified)
    await writeFile(
      path.join(dir, `${id}.restore-check.json`),
      JSON.stringify({
        schemaVersion: 1,
        backupId: id,
        result: "passed",
        dumpSha256: sha256,
        migrations: { failed: 0 },
      }),
    );
  return { id, manifest };
}

test("keeps latest three verified copies and a pending new copy; deletes complete older sets", async (t) => {
  const dir = await directory(t);
  const copies = [];
  for (let i = 1; i <= 5; i++) copies.push(await backup(dir, i));
  await backup(dir, 6, { verified: false });
  await writeFile(path.join(dir, "private-settings.env"), "test-setting");
  const preview = await pruneDatabaseBackups(dir, { dryRun: true });
  assert.deepEqual(preview.removed, [copies[1].id, copies[0].id]);
  assert.equal((await readdir(dir)).length, 18);
  const result = await pruneDatabaseBackups(dir);
  assert.deepEqual(result.kept, [copies[4].id, copies[3].id, copies[2].id]);
  assert.equal((await readdir(dir)).length, 12);
  assert.equal(await readFile(path.join(dir, "private-settings.env"), "utf8"), "test-setting");
  assert.equal((await pruneDatabaseBackups(dir)).removed.length, 0);
});

test("never prunes with fewer than three successfully verified copies", async (t) => {
  const dir = await directory(t);
  await backup(dir, 1, { verified: false });
  await backup(dir, 2);
  await backup(dir, 3);
  assert.equal((await pruneDatabaseBackups(dir)).removed.length, 0);
  assert.equal((await readdir(dir)).length, 8);
});

test("retained corrupt dump prevents all deletion before the first unlink", async (t) => {
  const dir = await directory(t);
  for (let i = 1; i <= 4; i++) await backup(dir, i);
  const newest = await backup(dir, 5);
  await writeFile(path.join(dir, newest.manifest.dump.file), "corruption");
  await assert.rejects(pruneDatabaseBackups(dir), /failed integrity check; nothing deleted/);
  assert.equal((await readdir(dir)).length, 15);
});

test("another database cannot replace recovery points for this database", async (t) => {
  const dir = await directory(t);
  await backup(dir, 1);
  await backup(dir, 2);
  for (let i = 3; i <= 6; i++) await backup(dir, i, { database: "another_database" });
  const result = await pruneDatabaseBackups(dir);
  assert.equal(result.removed.length, 1);
  assert.match(result.removed[0], /10-03/);
  assert.equal((await readdir(dir)).length, 15);
});

test("invalid manifests and report hash mismatch cannot authorize deletion", async (t) => {
  const dir = await directory(t);
  await backup(dir, 1);
  await backup(dir, 2);
  const third = await backup(dir, 3);
  const reportPath = path.join(dir, `${third.id}.restore-check.json`);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.dumpSha256 = "0".repeat(64);
  await writeFile(reportPath, JSON.stringify(report));
  await writeFile(path.join(dir, "invalid.manifest.json"), "null");
  await writeFile(path.join(dir, "outside.dump"), "unrelated");
  await writeFile(
    path.join(dir, "cryptoanal-2026-10-04T00-00-00-000Z.manifest.json"),
    JSON.stringify({
      ...third.manifest,
      backupId: "2026-10-04T00-00-00-000Z",
      dump: { ...third.manifest.dump, file: "../outside.dump" },
    }),
  );
  assert.equal((await pruneDatabaseBackups(dir)).removed.length, 0);
  assert.equal(await readFile(path.join(dir, "outside.dump"), "utf8"), "unrelated");
});
