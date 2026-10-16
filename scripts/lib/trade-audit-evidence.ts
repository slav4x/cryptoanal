import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import {
  encodePriceArchive,
  decodePriceArchive,
  type ArchivedPriceEvent,
} from "../../packages/persistence/src/price-archive-codec";
import { hashTracePayload } from "../../packages/persistence/src/position-trace";
import {
  AuditSourceUnavailable,
  type AuditLoaders,
  type ClosedTradeAuditSource,
  auditJson,
  auditInfrastructureFailure,
} from "../../apps/worker/src/closed-trade-audit";

export type EvidenceManifest = {
  version: 1;
  sourceHash: string;
  pages: Array<{
    cursor: string;
    through: string;
    chunk: null | {
      file: string;
      firstEventId: string;
      lastEventId: string;
      symbol: string;
      eventCount: number;
      sha256: string;
    };
    unavailable: string | null;
    invalid: string | null;
  }>;
  funding: Array<{
    id: string;
    file: string | null;
    hash: string | null;
    unavailable: string | null;
  }>;
};
async function writeJson(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(auditJson(value)) + "\n", { mode: 0o600, flag: "wx" });
}
function safeFile(root: string, file: string) {
  if (basename(file) !== file) throw new Error("Invalid evidence file path");
  return join(root, file);
}
async function loadPage(root: string, page: EvidenceManifest["pages"][number]) {
  if (page.unavailable) throw new AuditSourceUnavailable(page.unavailable);
  if (page.invalid) throw new Error(page.invalid);
  if (!page.chunk) return [];
  const c = page.chunk;
  return decodePriceArchive({
    ...c,
    firstEventId: BigInt(c.firstEventId),
    lastEventId: BigInt(c.lastEventId),
    payload: await readFile(safeFile(root, c.file)),
  });
}
export async function captureAuditEvidence(
  root: string,
  source: ClosedTradeAuditSource,
  original: AuditLoaders,
  maxReadEvents = 4_000_000,
) {
  await mkdir(root, { recursive: true });
  await writeJson(join(root, "source.json"), source);
  const manifest: EvidenceManifest = {
    version: 1,
    sourceHash: hashTracePayload(source),
    pages: [],
    funding: [],
  };
  let eventsRead = 0;
  const loaders: AuditLoaders = {
    events: async (cursor, through): Promise<ArchivedPriceEvent[]> => {
      const cached = manifest.pages.find(
        (p) => p.cursor === String(cursor) && p.through === String(through),
      );
      if (cached) return loadPage(root, cached);
      const entry: EvidenceManifest["pages"][number] = {
        cursor: String(cursor),
        through: String(through),
        chunk: null,
        unavailable: null,
        invalid: null,
      };
      try {
        if (eventsRead >= maxReadEvents)
          throw new AuditSourceUnavailable("AUDIT_EVENT_BUDGET_EXCEEDED");
        const page = await original.events(cursor, through);
        if (page.length > 10_000) throw new Error("Evidence page exceeds archive limit");
        eventsRead += page.length;
        if (page.length) {
          const encoded = await encodePriceArchive(page),
            file = `events-${manifest.pages.length}.gz`;
          if (encoded.rawBytes > 32 * 1024 * 1024)
            throw new AuditSourceUnavailable("AUDIT_PAGE_BYTE_BUDGET_EXCEEDED");
          await writeFile(join(root, file), encoded.payload, { mode: 0o600, flag: "wx" });
          entry.chunk = {
            file,
            firstEventId: String(encoded.firstEventId),
            lastEventId: String(encoded.lastEventId),
            symbol: encoded.symbol,
            eventCount: encoded.eventCount,
            sha256: encoded.sha256,
          };
        }
        manifest.pages.push(entry);
        return page;
      } catch (error) {
        if (auditInfrastructureFailure(error)) {
          const failure = new AuditSourceUnavailable("SOURCE_READ_UNAVAILABLE");
          entry.unavailable = failure.message;
          manifest.pages.push(entry);
          throw failure;
        }
        if (error instanceof AuditSourceUnavailable) entry.unavailable = error.message;
        else entry.invalid = error instanceof Error ? error.message : String(error);
        manifest.pages.push(entry);
        throw error;
      }
    },
    funding: async (id) => {
      const cached = manifest.funding.find((f) => f.id === id);
      if (cached) {
        if (cached.unavailable) throw new AuditSourceUnavailable(cached.unavailable);
        if (cached.file === null) throw new Error("Funding evidence file missing from manifest");
        const value = JSON.parse(await readFile(safeFile(root, cached.file), "utf8"));
        if (hashTracePayload(value) !== cached.hash)
          throw new Error("Funding evidence checksum mismatch");
        return value;
      }
      try {
        const value = await original.funding(id),
          file = `funding-${manifest.funding.length}.json`;
        await writeJson(join(root, file), value);
        manifest.funding.push({ id, file, hash: hashTracePayload(value), unavailable: null });
        return value;
      } catch (error) {
        if (auditInfrastructureFailure(error) || error instanceof AuditSourceUnavailable) {
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
      await writeJson(join(root, "manifest.json"), manifest);
      return { hash: hashTracePayload(manifest), pages: manifest.pages.length, eventsRead };
    },
  };
}
export async function readAuditEvidence(root: string, manifestHash: string) {
  const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
  ) as EvidenceManifest;
  if (manifest.version !== 1 || hashTracePayload(manifest) !== manifestHash)
    throw new Error("Evidence manifest checksum mismatch");
  const source = JSON.parse(
    await readFile(join(root, "source.json"), "utf8"),
  ) as ClosedTradeAuditSource;
  if (hashTracePayload(source) !== manifest.sourceHash)
    throw new Error("Audit source checksum mismatch");
  const loaders: AuditLoaders = {
    events: async (cursor, through) => {
      const page = manifest.pages.find(
        (p) => p.cursor === String(cursor) && p.through === String(through),
      );
      if (!page) throw new AuditSourceUnavailable("Original evidence page not captured");
      return loadPage(root, page);
    },
    funding: async (id) => {
      const item = manifest.funding.find((f) => f.id === id);
      if (!item) throw new AuditSourceUnavailable("Original funding snapshot not captured");
      if (item.unavailable) throw new AuditSourceUnavailable(item.unavailable);
      if (item.file === null) throw new Error("Funding evidence file missing from manifest");
      const value = JSON.parse(await readFile(safeFile(root, item.file), "utf8"));
      if (hashTracePayload(value) !== item.hash)
        throw new Error("Funding evidence checksum mismatch");
      return value;
    },
  };
  return { source, loaders };
}
