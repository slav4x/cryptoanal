import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  encodePriceArchive,
  decodePriceArchive,
  type ArchivedPriceEvent,
} from "../../packages/persistence/src/price-archive-codec";
import { hashTracePayload } from "../../packages/persistence/src/position-trace";
import {
  AuditSourceUnavailable,
  auditJson,
  auditInfrastructureFailure,
  type ClosedTradeAuditSource,
  type AuditLoaders,
} from "../../apps/worker/src/closed-trade-audit";
import type { EvidenceManifest } from "./trade-audit-evidence";

export async function captureRetainedEvidence(
  root: string,
  source: ClosedTradeAuditSource,
  original: AuditLoaders,
  limits: { events?: number; bytes?: number; pages?: number; durationMs?: number } = {},
) {
  const maxBytes = limits.bytes ?? 512 * 1024 * 1024,
    reserve = Math.min(4 * 1024 * 1024, Math.floor(maxBytes / 4)),
    started = performance.now();
  let bytes = 0,
    eventsRead = 0;
  const manifest: EvidenceManifest = {
    version: 1,
    sourceHash: hashTracePayload(source),
    pages: [],
    funding: [],
  };
  const check = () => {
    if (performance.now() - started > (limits.durationMs ?? 240000))
      throw new AuditSourceUnavailable("AUDIT_TIME_BUDGET_EXCEEDED");
  };
  async function save(file: string, data: string | Buffer) {
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    if (bytes + size + reserve > maxBytes)
      throw new AuditSourceUnavailable("AUDIT_STORAGE_BUDGET_EXCEEDED");
    await writeFile(join(root, file), data, { flag: "wx", mode: 0o600 });
    bytes += size;
  }
  const json = (value: unknown) => JSON.stringify(auditJson(value)) + "\n";
  await mkdir(root, { recursive: true, mode: 0o700 });
  const encodedSource = json(source);
  if (Buffer.byteLength(encodedSource) > 32 * 1024 * 1024)
    throw new AuditSourceUnavailable("AUDIT_SOURCE_BYTE_BUDGET_EXCEEDED");
  await save("source.json", encodedSource);
  async function load(page: EvidenceManifest["pages"][number]): Promise<ArchivedPriceEvent[]> {
    if (page.unavailable) throw new AuditSourceUnavailable(page.unavailable);
    if (page.invalid) throw new Error(page.invalid);
    if (!page.chunk) return [];
    const c = page.chunk;
    return decodePriceArchive({
      ...c,
      firstEventId: BigInt(c.firstEventId),
      lastEventId: BigInt(c.lastEventId),
      payload: await readFile(join(root, c.file)),
    });
  }
  const loaders: AuditLoaders = {
    events: async (cursor, through) => {
      const cached = manifest.pages.find(
        (p) => p.cursor === String(cursor) && p.through === String(through),
      );
      if (cached) return load(cached);
      const page: EvidenceManifest["pages"][number] = {
        cursor: String(cursor),
        through: String(through),
        chunk: null,
        unavailable: null,
        invalid: null,
      };
      try {
        check();
        if (manifest.pages.length >= (limits.pages ?? 4096))
          throw new AuditSourceUnavailable("AUDIT_PAGE_BUDGET_EXCEEDED");
        if (eventsRead >= (limits.events ?? 4_000_000))
          throw new AuditSourceUnavailable("AUDIT_EVENT_BUDGET_EXCEEDED");
        const events = await original.events(cursor, through);
        check();
        if (events.length > 10000) throw new Error("Evidence page exceeds archive limit");
        if (eventsRead + events.length > (limits.events ?? 4_000_000))
          throw new AuditSourceUnavailable("AUDIT_EVENT_BUDGET_EXCEEDED");
        eventsRead += events.length;
        if (events.length) {
          const c = await encodePriceArchive(events),
            file = `events-${manifest.pages.length}.gz`;
          if (c.rawBytes > 32 * 1024 * 1024)
            throw new AuditSourceUnavailable("AUDIT_PAGE_BYTE_BUDGET_EXCEEDED");
          await save(file, c.payload);
          page.chunk = {
            file,
            firstEventId: String(c.firstEventId),
            lastEventId: String(c.lastEventId),
            symbol: c.symbol,
            eventCount: c.eventCount,
            sha256: c.sha256,
          };
        }
        manifest.pages.push(page);
        return events;
      } catch (error) {
        const missing =
          error instanceof AuditSourceUnavailable || auditInfrastructureFailure(error);
        const message =
          error instanceof AuditSourceUnavailable
            ? error.message
            : missing
              ? "SOURCE_READ_UNAVAILABLE"
              : error instanceof Error
                ? error.message
                : String(error);
        if (missing) page.unavailable = message;
        else page.invalid = message;
        manifest.pages.push(page);
        if (missing) throw new AuditSourceUnavailable(message);
        throw error;
      }
    },
    funding: async (id) => {
      const cached = manifest.funding.find((f) => f.id === id);
      if (cached) {
        if (cached.unavailable) throw new AuditSourceUnavailable(cached.unavailable);
        const value = JSON.parse(await readFile(join(root, cached.file!), "utf8"));
        if (hashTracePayload(value) !== cached.hash)
          throw new Error("Funding evidence checksum mismatch");
        return value;
      }
      try {
        check();
        const value = await original.funding(id);
        check();
        const file = `funding-${manifest.funding.length}.json`,
          text = json(value);
        if (Buffer.byteLength(text) > 32 * 1024 * 1024)
          throw new AuditSourceUnavailable("AUDIT_FUNDING_BYTE_BUDGET_EXCEEDED");
        await save(file, text);
        manifest.funding.push({ id, file, hash: hashTracePayload(value), unavailable: null });
        return value;
      } catch (error) {
        if (error instanceof AuditSourceUnavailable || auditInfrastructureFailure(error)) {
          const message =
            error instanceof AuditSourceUnavailable
              ? error.message
              : "FUNDING_SOURCE_READ_UNAVAILABLE";
          manifest.funding.push({ id, file: null, hash: null, unavailable: message });
          throw new AuditSourceUnavailable(message);
        }
        throw error;
      }
    },
  };
  return {
    loaders,
    finish: async () => {
      const text = json(manifest);
      if (bytes + Buffer.byteLength(text) > maxBytes)
        throw new AuditSourceUnavailable("AUDIT_MANIFEST_BYTE_BUDGET_EXCEEDED");
      await writeFile(join(root, "manifest.json"), text, { flag: "wx", mode: 0o600 });
      bytes += Buffer.byteLength(text);
      return { hash: hashTracePayload(manifest), pages: manifest.pages.length, eventsRead, bytes };
    },
  };
}
