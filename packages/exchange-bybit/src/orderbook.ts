import Decimal from "decimal.js";
import { z } from "zod";

const decimal = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/)
  .refine((value) => {
    const parsed = new Decimal(value);
    return parsed.gt(0) && parsed.lt("1e20");
  });
const level = z.tuple([decimal, decimal]);
const messageSchema = z.object({
  topic: z.string(),
  type: z.literal("snapshot"),
  ts: z.number().int().safe().nonnegative(),
  cts: z.number().int().safe().nonnegative(),
  data: z.object({
    s: z.string().min(1),
    b: z.array(level).max(1),
    a: z.array(level).max(1),
    u: z.number().int().safe().positive(),
    seq: z.number().int().safe().nonnegative(),
  }),
});

export type BybitTopOfBook = {
  symbol: string;
  bid: [string, string];
  ask: [string, string];
  observedAt: Date;
  receivedAt: Date;
  updateId: string;
  sequence: string;
};

export class BybitOrderBookContinuityError extends Error {
  public constructor(
    public readonly reasons: string[],
    public readonly previous: BybitTopOfBook,
    public readonly current: z.infer<typeof messageSchema> & { receivedAt: Date },
  ) {
    super("Bybit orderbook regressed or changed without an update");
    this.name = "BybitOrderBookContinuityError";
  }
}

// L1 snapshot IDs may skip; unchanged heartbeats retain u while cross-sequence advances.
export class BybitOrderBookCache {
  private readonly histories = new Map<string, BybitTopOfBook[]>();

  public clear() {
    this.histories.clear();
  }

  public remove(symbol: string) {
    this.histories.delete(symbol);
  }

  public apply(payload: unknown, receivedAt: Date) {
    const message = messageSchema.parse(payload);
    const { data, topic, cts, ts } = message;
    if (topic !== `orderbook.1.${data.s}` || cts > +receivedAt + 1000 || cts > ts)
      throw new Error("Invalid Bybit orderbook topic or time");
    if (!data.b.length || !data.a.length) {
      this.remove(data.s);
      return;
    }
    const bid = data.b[0]!;
    const ask = data.a[0]!;
    if (new Decimal(bid[0]).gte(ask[0])) throw new Error("Crossed Bybit orderbook");
    let history = this.histories.get(data.s) ?? [];
    const previous = history.at(-1);
    if (data.u === 1) history = [];
    else if (previous) {
      const reasons = [
        ...(BigInt(data.u) < BigInt(previous.updateId) ? ["update-id-regressed"] : []),
        ...(BigInt(data.seq) < BigInt(previous.sequence) ? ["sequence-regressed"] : []),
        ...(cts < +previous.observedAt ? ["engine-time-regressed"] : []),
        ...(String(data.u) === previous.updateId &&
        (!new Decimal(bid[0]).eq(previous.bid[0]) ||
          !new Decimal(bid[1]).eq(previous.bid[1]) ||
          !new Decimal(ask[0]).eq(previous.ask[0]) ||
          !new Decimal(ask[1]).eq(previous.ask[1]))
          ? ["changed-without-update"]
          : []),
      ];
      if (reasons.length)
        throw new BybitOrderBookContinuityError(reasons, structuredClone(previous), {
          ...message,
          receivedAt: new Date(+receivedAt),
        });
    }
    history.push({
      symbol: data.s,
      bid,
      ask,
      observedAt: new Date(cts),
      receivedAt,
      updateId: String(data.u),
      sequence: String(data.seq),
    });
    this.histories.set(data.s, history.slice(-512));
  }

  public atTrade(symbol: string, observedAt: Date, receivedAt: Date): BybitTopOfBook | null {
    const history = this.histories.get(symbol);
    if (!history) return null;
    for (let index = history.length - 1; index >= 0; index--) {
      const book = history[index]!;
      if (book.observedAt <= observedAt && book.receivedAt <= receivedAt)
        return {
          ...book,
          bid: [...book.bid],
          ask: [...book.ask],
          observedAt: new Date(+book.observedAt),
          receivedAt: new Date(+book.receivedAt),
        };
    }
    return null;
  }
}
