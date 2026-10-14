import { compareExecutionDecimals } from "./execution-instrument";

export type ExecutionMarketData = {
  source: "bybit-public";
  depth: 1;
  trade: {
    quantity: string;
    takerSide: "Buy" | "Sell";
    blockTrade: boolean | null;
    rpiTrade: boolean | null;
  };
  book: null | {
    bid: [string, string];
    ask: [string, string];
    observedAt: number;
    receivedAt: number;
    updateId: string;
    sequence: string;
  };
};

// Compact, versioned storage avoids repeating field names in every public trade.
export type StoredExecutionMarketData = [
  1,
  string,
  "Buy" | "Sell",
  boolean | null,
  boolean | null,
  null | [string, string, string, string, number, number, string, string],
];

export function readExecutionMarketData(value: unknown): ExecutionMarketData {
  const fail = (): never => {
    throw new Error("Invalid execution market data");
  };
  const decimal = (part: unknown): part is string =>
    typeof part === "string" &&
    /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(part) &&
    compareExecutionDecimals(part, "0") > 0;
  const flag = (part: unknown) => part === null || typeof part === "boolean";
  const time = (part: unknown): part is number =>
    typeof part === "number" &&
    Number.isSafeInteger(part) &&
    part >= 0 &&
    part <= 8_640_000_000_000_000;
  if (
    !Array.isArray(value) ||
    value.length !== 6 ||
    value[0] !== 1 ||
    !decimal(value[1]) ||
    (value[2] !== "Buy" && value[2] !== "Sell") ||
    !flag(value[3]) ||
    !flag(value[4])
  )
    return fail();
  const book = value[5];
  if (
    book !== null &&
    (!Array.isArray(book) ||
      book.length !== 8 ||
      !book.slice(0, 4).every(decimal) ||
      !time(book[4]) ||
      !time(book[5]) ||
      typeof book[6] !== "string" ||
      !/^[1-9]\d*$/.test(book[6]) ||
      typeof book[7] !== "string" ||
      !/^(?:0|[1-9]\d*)$/.test(book[7]) ||
      compareExecutionDecimals(book[0], book[2]) >= 0)
  )
    return fail();
  return {
    source: "bybit-public",
    depth: 1,
    trade: { quantity: value[1], takerSide: value[2], blockTrade: value[3], rpiTrade: value[4] },
    book:
      book === null
        ? null
        : {
            bid: [book[0], book[1]],
            ask: [book[2], book[3]],
            observedAt: book[4],
            receivedAt: book[5],
            updateId: book[6],
            sequence: book[7],
          },
  };
}

export function storeExecutionMarketData(data: ExecutionMarketData): StoredExecutionMarketData {
  if (data.source !== "bybit-public" || data.depth !== 1)
    throw new Error("Unsupported market data source");
  const book = data.book;
  const result: StoredExecutionMarketData = [
    1,
    data.trade.quantity,
    data.trade.takerSide,
    data.trade.blockTrade,
    data.trade.rpiTrade,
    book
      ? [
          book.bid[0],
          book.bid[1],
          book.ask[0],
          book.ask[1],
          book.observedAt,
          book.receivedAt,
          book.updateId,
          book.sequence,
        ]
      : null,
  ];
  readExecutionMarketData(result);
  return result;
}

export function executionBookFailure(
  data: ExecutionMarketData,
  event: {
    observedAt: Date;
    receivedAt: Date;
  },
  maximumAgeMs: number,
): "BOOK_UNAVAILABLE" | "BOOK_FROM_FUTURE" | "BOOK_STALE" | null {
  if (
    !Number.isFinite(maximumAgeMs) ||
    maximumAgeMs < 0 ||
    !Number.isFinite(+event.observedAt) ||
    !Number.isFinite(+event.receivedAt)
  )
    throw new Error("Invalid book freshness policy or event time");
  const book = data.book;
  if (!book) return "BOOK_UNAVAILABLE";
  if (book.observedAt > +event.observedAt || book.receivedAt > +event.receivedAt)
    return "BOOK_FROM_FUTURE";
  return +event.observedAt - book.observedAt > maximumAgeMs ||
    +event.receivedAt - book.receivedAt > maximumAgeMs
    ? "BOOK_STALE"
    : null;
}
