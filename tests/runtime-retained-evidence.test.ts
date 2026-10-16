import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRetainedEvidence } from "../scripts/lib/retained-audit-evidence";
import { readAuditEvidence } from "../scripts/lib/trade-audit-evidence";
import { verifyRetainedEvidence } from "../scripts/lib/retained-audit-source";
import type { ClosedTradeAuditSource } from "../apps/worker/src/closed-trade-audit";
const source = { position: { id: "p" }, trade: { id: "t" } } as unknown as ClosedTradeAuditSource;
const event = {
  id: 1n,
  symbol: "BTCUSDT",
  eventKey: "event-1",
  price: "100",
  streamId: "stream",
  observedAt: new Date("2026-10-17T01:00:00Z"),
  receivedAt: new Date("2026-10-17T01:00:00Z"),
};
async function folder(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cryptoanal-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("retained price evidence remains compatible with offline replay and byte checks", async (t) => {
  const root = await folder(t);
  let reads = 0;
  const capture = await captureRetainedEvidence(root, source, {
    events: async () => {
      reads++;
      return [event];
    },
    funding: async () => null,
  });
  assert.deepEqual(await capture.loaders.events(0n, 1n), [event]);
  assert.deepEqual(await capture.loaders.events(0n, 1n), [event]);
  assert.equal(reads, 1);
  const receipt = await capture.finish(),
    offline = await readAuditEvidence(root, receipt.hash);
  assert.deepEqual(await offline.loaders.events(0n, 1n), [event]);
  await verifyRetainedEvidence(root, receipt.hash);
  const files = await readdir(root);
  assert.equal(
    receipt.bytes,
    (await Promise.all(files.map((f) => stat(join(root, f))))).reduce((s, v) => s + v.size, 0),
  );
});
test("an event budget is enforced before the crossing page is stored and repeats offline", async (t) => {
  const root = await folder(t),
    capture = await captureRetainedEvidence(
      root,
      source,
      {
        events: async () => [event, { ...event, id: 2n, eventKey: "event-2" }],
        funding: async () => null,
      },
      { events: 1 },
    );
  await assert.rejects(capture.loaders.events(0n, 2n), /EVENT_BUDGET/);
  const saved = await capture.finish();
  assert.equal(saved.eventsRead, 0);
  assert.equal(
    (await readdir(root)).some((f) => f.endsWith(".gz")),
    false,
  );
  await assert.rejects(
    (await readAuditEvidence(root, saved.hash)).loaders.events(0n, 2n),
    /EVENT_BUDGET/,
  );
});
test("compressed storage is bounded before writing a price page", async (t) => {
  const root = await folder(t),
    events = Array.from({ length: 20 }, (_, i) => ({
      ...event,
      id: BigInt(i + 1),
      eventKey: createHash("sha256").update(String(i)).digest("hex"),
      price: String(100 + i),
    }));
  const capture = await captureRetainedEvidence(
    root,
    source,
    { events: async () => events, funding: async () => null },
    { bytes: 450 },
  );
  await assert.rejects(capture.loaders.events(0n, 20n), /STORAGE_BUDGET/);
  await capture.finish();
  assert.equal(
    (await readdir(root)).some((f) => f.endsWith(".gz")),
    false,
  );
  const size = (await Promise.all((await readdir(root)).map((f) => stat(join(root, f))))).reduce(
    (s, v) => s + v.size,
    0,
  );
  assert.ok(size <= 450);
});
test("a database read failure is captured as unavailable and can be replayed without the database", async (t) => {
  const root = await folder(t),
    capture = await captureRetainedEvidence(root, source, {
      events: async () => {
        throw Object.assign(new Error("timeout"), { code: "57014" });
      },
      funding: async () => {
        throw Object.assign(new Error("offline"), { code: "ECONNRESET" });
      },
    });
  await assert.rejects(capture.loaders.events(0n, 1n), /SOURCE_READ_UNAVAILABLE/);
  await assert.rejects(capture.loaders.funding("f"), /FUNDING_SOURCE_READ_UNAVAILABLE/);
  const receipt = await capture.finish(),
    offline = await readAuditEvidence(root, receipt.hash);
  await assert.rejects(offline.loaders.events(0n, 1n), /SOURCE_READ_UNAVAILABLE/);
  await assert.rejects(offline.loaders.funding("f"), /FUNDING_SOURCE_READ_UNAVAILABLE/);
});
test("a modified retained archive is detected without loading new working data", async (t) => {
  const root = await folder(t),
    capture = await captureRetainedEvidence(root, source, {
      events: async () => [event],
      funding: async () => null,
    });
  await capture.loaders.events(0n, 1n);
  const receipt = await capture.finish();
  const file = join(root, "events-0.gz"),
    payload = await readFile(file);
  payload[10] = payload[10]! ^ 1;
  await writeFile(file, payload);
  await assert.rejects(verifyRetainedEvidence(root, receipt.hash), /checksum mismatch/);
});
