import { createHash } from "node:crypto";
import { gzip, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import {
  readExecutionMarketData,
  storeExecutionMarketData,
  type StoredExecutionMarketData,
} from "../../application/src/execution-market-data";

export type ArchivedPriceEvent = {
  id: bigint;
  symbol: string;
  eventKey: string;
  price: string;
  observedAt: Date;
  receivedAt: Date;
  streamId: string;
  executionData?: StoredExecutionMarketData;
};
const compress = promisify(gzip);
const maximumChunkEvents = 10_000;

export function archivePriceEvent(
  event: Omit<ArchivedPriceEvent, "price" | "executionData"> & {
    price: string | { toFixed(): string };
    executionData?: unknown;
  },
): ArchivedPriceEvent {
  const { executionData, price, ...base } = event;
  if (executionData === null || executionData === undefined)
    return { ...base, price: typeof price === "string" ? price : price.toFixed() };
  const market = readExecutionMarketData(executionData);
  if (
    market.book &&
    (market.book.observedAt > +event.observedAt || market.book.receivedAt > +event.receivedAt)
  )
    throw new Error("Non-causal archived orderbook");
  return {
    ...base,
    price: typeof price === "string" ? price : price.toFixed(),
    executionData: storeExecutionMarketData(market),
  };
}

export async function encodePriceArchive(events: ArchivedPriceEvent[]) {
  if (!events.length || events.length > maximumChunkEvents) throw new Error("Invalid archive size");
  const symbol = events[0]!.symbol;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (
      event.symbol !== symbol ||
      event.id <= 0n ||
      (index > 0 && event.id <= events[index - 1]!.id)
    )
      throw new Error("Archive events must share a symbol and strict id order");
  }
  const raw = Buffer.from(
    JSON.stringify({
      version: 2,
      symbol,
      events: events.map((event) => [
        String(event.id),
        event.eventKey,
        event.price,
        event.observedAt.toISOString(),
        event.receivedAt.toISOString(),
        event.streamId,
        archivePriceEvent(event).executionData ?? null,
      ]),
    }),
  );
  const payload = await compress(raw);
  return {
    firstEventId: events[0]!.id,
    lastEventId: events.at(-1)!.id,
    symbol,
    startsAt: new Date(Math.min(...events.map((event) => +event.observedAt))),
    endsAt: new Date(Math.max(...events.map((event) => +event.observedAt))),
    eventCount: events.length,
    payload,
    sha256: createHash("sha256").update(payload).digest("hex"),
    rawBytes: raw.byteLength,
  };
}

export function decodePriceArchive(chunk: {
  firstEventId: bigint;
  lastEventId: bigint;
  symbol: string;
  eventCount: number;
  payload: Uint8Array;
  sha256: string;
}): ArchivedPriceEvent[] {
  if (createHash("sha256").update(chunk.payload).digest("hex") !== chunk.sha256)
    throw new Error("Price archive checksum mismatch");
  const data = JSON.parse(
    gunzipSync(chunk.payload, { maxOutputLength: 32 * 1024 * 1024 }).toString(),
  ) as {
    version?: unknown;
    symbol?: unknown;
    events?: unknown;
  };
  if (
    (data.version !== 1 && data.version !== 2) ||
    data.symbol !== chunk.symbol ||
    !Array.isArray(data.events) ||
    data.events.length !== chunk.eventCount ||
    data.events.length < 1 ||
    data.events.length > maximumChunkEvents
  )
    throw new Error("Invalid price archive envelope");
  const events: ArchivedPriceEvent[] = [];
  for (const row of data.events) {
    if (
      !Array.isArray(row) ||
      row.length !== (data.version === 1 ? 6 : 7) ||
      row.slice(0, 6).some((value) => typeof value !== "string") ||
      !/^[1-9][0-9]*$/.test(row[0]) ||
      !Number.isFinite(Number(row[2])) ||
      Number(row[2]) <= 0 ||
      !Number.isFinite(Date.parse(row[3])) ||
      !Number.isFinite(Date.parse(row[4])) ||
      !row[1] ||
      !row[5]
    )
      throw new Error("Invalid archived price event");
    const event = archivePriceEvent({
      id: BigInt(row[0]),
      symbol: chunk.symbol,
      eventKey: row[1],
      price: row[2],
      observedAt: new Date(row[3]),
      receivedAt: new Date(row[4]),
      streamId: row[5],
      executionData: data.version === 1 ? null : row[6],
    });
    if (events.length && event.id <= events.at(-1)!.id)
      throw new Error("Archive event order is invalid");
    events.push(event);
  }
  if (events[0]!.id !== chunk.firstEventId || events.at(-1)!.id !== chunk.lastEventId)
    throw new Error("Price archive bounds mismatch");
  return events;
}
