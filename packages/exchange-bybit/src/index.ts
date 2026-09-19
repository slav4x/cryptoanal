import Decimal from "decimal.js";
import { createHmac, randomUUID } from "node:crypto";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";

type BybitFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function createBybitFetch(proxyUrl?: string): BybitFetch {
  if (!proxyUrl) return globalThis.fetch;
  const dispatcher = new ProxyAgent(proxyUrl);
  return (input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Promise<Response>;
}

const tickerResponseSchema = z.object({
  retCode: z.number(),
  retMsg: z.string(),
  time: z.number(),
  result: z.object({
    category: z.string(),
    list: z.array(
      z.object({
        symbol: z.string(),
        lastPrice: z.string(),
        price24hPcnt: z.string(),
        turnover24h: z.string(),
      }),
    ),
  }),
});

const instrumentInfoResponseSchema = z.object({
  retCode: z.number(),
  retMsg: z.string(),
  result: z.object({
    category: z.string(),
    nextPageCursor: z.string().default(""),
    list: z.array(
      z
        .object({
          symbol: z.string(),
          contractType: z.string(),
          status: z.string(),
          baseCoin: z.string(),
          quoteCoin: z.string(),
          settleCoin: z.string(),
          priceFilter: z.object({
            tickSize: z.string(),
          }),
          lotSizeFilter: z.object({
            minOrderQty: z.string(),
            qtyStep: z.string(),
            minNotionalValue: z.string(),
          }),
        })
        .passthrough(),
    ),
  }),
});

const klineResponseSchema = z.object({
  retCode: z.number(),
  retMsg: z.string(),
  result: z.object({
    category: z.string(),
    symbol: z.string(),
    list: z.array(
      z.tuple([z.string(), z.string(), z.string(), z.string(), z.string(), z.string(), z.string()]),
    ),
  }),
});

const streamTradeSchema = z.object({
  topic: z.string().startsWith("publicTrade."),
  data: z.array(
    z.object({
      T: z.number().int().nonnegative(),
      s: z.string(),
      p: z.string().refine((value) => Number.isFinite(Number(value)) && Number(value) > 0),
      i: z.string().min(1),
    }),
  ),
});

const streamTickerSchema = z.object({
  topic: z.string().startsWith("tickers."),
  ts: z.number(),
  data: z.union([
    z.object({ symbol: z.string(), lastPrice: z.string().optional() }).passthrough(),
    z.array(z.object({ symbol: z.string(), lastPrice: z.string().optional() }).passthrough()),
  ]),
});

const streamKlineSchema = z.object({
  topic: z.string().startsWith("kline."),
  data: z.array(
    z.object({
      start: z.number(),
      interval: z.string(),
      open: z.string(),
      high: z.string(),
      low: z.string(),
      close: z.string(),
      volume: z.string(),
      turnover: z.string(),
      confirm: z.boolean(),
    }),
  ),
});

const apiKeyInformationResultSchema = z
  .object({
    readOnly: z.union([z.literal(0), z.literal(1)]),
    permissions: z.record(z.string(), z.array(z.string())).default({}),
    ips: z.array(z.string()).default([]),
    userID: z.union([z.string(), z.number()]).optional(),
    userIDInt64: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const apiKeyInformationResponseSchema = z.object({
  retCode: z.number(),
  retMsg: z.string(),
  result: z.unknown(),
  time: z.number().optional(),
});

export type BybitMarketTicker = {
  symbol: string;
  price: string;
  change24hPercent: string;
  volume24h: string;
  observedAt: Date;
};

export type BybitLinearInstrument = {
  symbol: string;
  contractType: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  settleAsset: string;
  tickSize: string;
  qtyStep: string;
  minOrderQty: string;
  minNotional: string;
};

export type BybitLinearInstrumentStatus = "Trading" | "Closed";

export type BybitMarketCandle = {
  isClosed: boolean;
  symbol: string;
  interval: string;
  openTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  turnover: string;
};

export type BybitRealtimeQuote = {
  symbol: string;
  price: string;
  observedAt: Date;
};

export type BybitPublicStreamSubscriptions = {
  tickerSymbols: string[];
  tradeSymbols?: string[];
  klines: Array<{ symbol: string; interval: string }>;
};

export type BybitPublicStreamHandlers = {
  getSubscriptions: () => Promise<BybitPublicStreamSubscriptions>;
  onQuote: (quote: BybitRealtimeQuote) => void | Promise<void>;
  onTrade?: (quote: BybitRealtimeQuote & { tradeId: string }) => void | Promise<void>;
  onClosedCandle: (candle: BybitMarketCandle) => void | Promise<void>;
  onConnected?: (() => void) | undefined;
  onDisconnected?: ((code: number, reason: string) => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
};

export type BybitApiKeyInformation = {
  readOnly: boolean;
  permissions: Record<string, string[]>;
  ipBound: boolean;
  accountUid: string | null;
};

export function evaluateBybitPermissions(permissions: Record<string, string[]>) {
  const tradingPermissions = new Set(["order", "spottrade", "optionstrade", "derivativestrade"]);
  const withdrawalPermission = Object.entries(permissions).some(
    ([group, values]) =>
      group.toLowerCase() === "wallet" &&
      values.some((permission) => permission.toLowerCase() === "withdraw"),
  );
  const tradingPermission = Object.values(permissions).some((values) =>
    values.some((permission) => tradingPermissions.has(permission.toLowerCase())),
  );
  return { tradingPermission, withdrawalPermission };
}

export class BybitCredentialsRejectedError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function describeBybitCredentialRejection(code: string) {
  const descriptions: Record<string, string> = {
    "-2015": "Срок действия API-ключа истёк",
    "33004": "Срок действия API-ключа истёк",
    "10003": "API-ключ не существует или не соответствует выбранному контуру",
    "10004": "API secret не соответствует ключу",
    "10005": "Bybit отклонил разрешения API-ключа",
    "10007": "Bybit не подтвердил владельца API-ключа",
    "10008": "Текущий режим аккаунта не поддерживается",
    "10009": "Bybit ограничил доступ для текущего региона",
    "10010": "IP сервера отсутствует в allowlist API-ключа",
    "10024": "Проверка заблокирована compliance-правилами Bybit",
    "10027": "Операции для аккаунта заблокированы Bybit",
    HTTP_401: "Bybit отклонил API-ключ или подпись",
  };
  return descriptions[code] ?? "Bybit отклонил API credentials";
}

export class BybitPrivateApiUnavailableError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class BybitPrivateClient {
  private readonly fetchImpl: BybitFetch;

  public constructor(
    private readonly baseUrl: string,
    private readonly receiveWindowMs = 5_000,
    proxyUrl?: string,
  ) {
    this.fetchImpl = createBybitFetch(proxyUrl);
  }

  public async getApiKeyInformation(
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
  ): Promise<BybitApiKeyInformation> {
    const timestamp = String(Date.now());
    const receiveWindow = String(this.receiveWindowMs);
    const signaturePayload = `${timestamp}${apiKey}${receiveWindow}`;
    const signature = createHmac("sha256", apiSecret).update(signaturePayload).digest("hex");
    const url = new URL("/v5/user/query-api", this.baseUrl);
    const requestInit: RequestInit = {
      headers: {
        Accept: "application/json",
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": receiveWindow,
        "X-BAPI-SIGN": signature,
        "cdn-request-id": randomUUID(),
      },
    };
    requestInit.signal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);

    let response: Response;
    try {
      response = await this.fetchImpl(url, requestInit);
    } catch (error) {
      const timedOut =
        signal?.aborted === true || (error instanceof Error && error.name === "TimeoutError");
      throw new BybitPrivateApiUnavailableError(
        timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        timedOut ? "Bybit verification timed out" : "Bybit verification request failed",
      );
    }

    if (response.status === 401) {
      throw new BybitCredentialsRejectedError("HTTP_401", "Bybit rejected authentication");
    }
    if (!response.ok) {
      throw new BybitPrivateApiUnavailableError(
        `HTTP_${response.status}`,
        `Bybit verification failed with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BybitPrivateApiUnavailableError(
        "INVALID_RESPONSE",
        "Bybit returned a non-JSON response",
      );
    }
    const parsed = apiKeyInformationResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new BybitPrivateApiUnavailableError(
        "INVALID_RESPONSE",
        "Bybit returned an unexpected response",
      );
    }
    if (parsed.data.retCode !== 0) {
      const code = String(parsed.data.retCode);
      const message = sanitizeBybitMessage(parsed.data.retMsg, apiKey, apiSecret);
      if (definitiveCredentialErrorCodes.has(parsed.data.retCode)) {
        throw new BybitCredentialsRejectedError(code, message || "Bybit rejected credentials");
      }
      throw new BybitPrivateApiUnavailableError(
        code,
        message || "Bybit could not verify credentials",
      );
    }

    const result = apiKeyInformationResultSchema.safeParse(parsed.data.result);
    if (!result.success) {
      throw new BybitPrivateApiUnavailableError(
        "INVALID_RESPONSE",
        "Bybit returned incomplete API key information",
      );
    }
    const extendedAccountUid =
      result.data.userIDInt64 === undefined ? null : String(result.data.userIDInt64);
    const accountUid =
      extendedAccountUid && extendedAccountUid !== "0"
        ? extendedAccountUid
        : result.data.userID === undefined
          ? null
          : String(result.data.userID);
    return {
      readOnly: result.data.readOnly === 1,
      permissions: result.data.permissions,
      ipBound: result.data.ips.length > 0,
      accountUid,
    };
  }
}

export class BybitPublicMarketClient {
  private readonly fetchImpl: BybitFetch;

  public constructor(
    private readonly baseUrl: string,
    proxyUrl?: string,
  ) {
    this.fetchImpl = createBybitFetch(proxyUrl);
  }

  public async getLinearTickers(signal?: AbortSignal): Promise<BybitMarketTicker[]> {
    const url = new URL("/v5/market/tickers", this.baseUrl);
    url.searchParams.set("category", "linear");

    const requestInit: RequestInit = {
      headers: { Accept: "application/json" },
    };
    requestInit.signal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);

    const response = await this.fetchImpl(url, requestInit);

    if (!response.ok) {
      throw new Error(`Bybit tickers request failed with HTTP ${response.status}`);
    }

    const payload = tickerResponseSchema.parse(await response.json());
    if (payload.retCode !== 0) {
      throw new Error(`Bybit tickers request failed: ${payload.retCode} ${payload.retMsg}`);
    }

    const observedAt = new Date(payload.time);
    return payload.result.list.map((ticker) => ({
      symbol: ticker.symbol,
      price: ticker.lastPrice,
      change24hPercent: new Decimal(ticker.price24hPcnt).mul(100).toString(),
      volume24h: ticker.turnover24h,
      observedAt,
    }));
  }

  public async getLinearInstruments(signal?: AbortSignal): Promise<BybitLinearInstrument[]> {
    return this.getLinearInstrumentsByStatus("Trading", signal);
  }

  public async getLinearInstrumentsByStatuses(
    statuses: BybitLinearInstrumentStatus[],
    signal?: AbortSignal,
  ): Promise<BybitLinearInstrument[]> {
    const pages = await Promise.all(
      statuses.map((status) => this.getLinearInstrumentsByStatus(status, signal)),
    );
    const instruments = new Map<string, BybitLinearInstrument>();
    for (const page of pages) {
      for (const instrument of page) instruments.set(instrument.symbol, instrument);
    }
    return [...instruments.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
  }

  private async getLinearInstrumentsByStatus(
    status: BybitLinearInstrumentStatus,
    signal?: AbortSignal,
  ): Promise<BybitLinearInstrument[]> {
    const instruments = new Map<string, BybitLinearInstrument>();
    let cursor = "";

    for (let page = 0; page < 20; page += 1) {
      const url = new URL("/v5/market/instruments-info", this.baseUrl);
      url.searchParams.set("category", "linear");
      url.searchParams.set("status", status);
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("cursor", cursor);

      const requestInit: RequestInit = { headers: { Accept: "application/json" } };
      requestInit.signal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000);
      const response = await this.fetchImpl(url, requestInit);
      if (!response.ok) {
        throw new Error(`Bybit instruments request failed with HTTP ${response.status}`);
      }

      const payload = instrumentInfoResponseSchema.parse(await response.json());
      if (payload.retCode !== 0) {
        throw new Error(`Bybit instruments request failed: ${payload.retCode} ${payload.retMsg}`);
      }

      for (const instrument of payload.result.list) {
        instruments.set(instrument.symbol, {
          symbol: instrument.symbol,
          contractType: instrument.contractType,
          status: instrument.status,
          baseAsset: instrument.baseCoin,
          quoteAsset: instrument.quoteCoin,
          settleAsset: instrument.settleCoin,
          tickSize: instrument.priceFilter.tickSize,
          qtyStep: instrument.lotSizeFilter.qtyStep,
          minOrderQty: instrument.lotSizeFilter.minOrderQty,
          minNotional: instrument.lotSizeFilter.minNotionalValue,
        });
      }

      const nextCursor = payload.result.nextPageCursor;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }

    return [...instruments.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
  }

  public async getLinearKlines(
    symbol: string,
    interval = "15",
    limit = 200,
    signal?: AbortSignal,
  ): Promise<BybitMarketCandle[]> {
    return this.requestLinearKlines({
      symbol,
      interval,
      limit,
      ...(signal ? { signal } : {}),
    });
  }

  public async getLinearKlinesRange(
    symbol: string,
    interval: string,
    startTime: Date,
    endTime: Date,
    signal?: AbortSignal,
  ): Promise<BybitMarketCandle[]> {
    const start = startTime.getTime();
    let cursor = endTime.getTime();
    const candles = new Map<number, BybitMarketCandle>();

    while (cursor >= start) {
      const page = await this.requestLinearKlines({
        symbol,
        interval,
        limit: 1_000,
        start,
        end: cursor,
        ...(signal ? { signal } : {}),
      });
      if (page.length === 0) break;
      for (const candle of page) candles.set(candle.openTime.getTime(), candle);

      const earliest = page[0]!.openTime.getTime();
      if (earliest <= start || page.length < 1_000) break;
      cursor = earliest - 1;
      if (candles.size > 250_000) {
        throw new Error("Requested historical dataset exceeds 250000 candles per symbol");
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    return [...candles.values()]
      .filter((candle) => {
        const time = candle.openTime.getTime();
        return time >= start && time <= endTime.getTime();
      })
      .sort((left, right) => left.openTime.getTime() - right.openTime.getTime());
  }

  private async requestLinearKlines({
    symbol,
    interval,
    limit,
    start,
    end,
    signal,
  }: {
    symbol: string;
    interval: string;
    limit: number;
    start?: number;
    end?: number;
    signal?: AbortSignal;
  }): Promise<BybitMarketCandle[]> {
    const url = new URL("/v5/market/kline", this.baseUrl);
    url.searchParams.set("category", "linear");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));
    if (start !== undefined) url.searchParams.set("start", String(start));
    if (end !== undefined) url.searchParams.set("end", String(end));

    const requestInit: RequestInit = {
      headers: { Accept: "application/json" },
    };
    requestInit.signal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);

    const requestedAt = Date.now();
    const response = await this.fetchImpl(url, requestInit);
    if (!response.ok) {
      throw new Error(`Bybit kline request failed with HTTP ${response.status}`);
    }

    const payload = klineResponseSchema.parse(await response.json());
    if (payload.retCode !== 0) {
      throw new Error(`Bybit kline request failed: ${payload.retCode} ${payload.retMsg}`);
    }

    return payload.result.list
      .map(([openTime, open, high, low, close, volume, turnover]) => ({
        isClosed:
          Number.isFinite(Number(interval)) &&
          Number(interval) > 0 &&
          Number(openTime) + Number(interval) * 60_000 <= requestedAt,
        symbol: payload.result.symbol,
        interval,
        openTime: new Date(Number(openTime)),
        open,
        high,
        low,
        close,
        volume,
        turnover,
      }))
      .reverse();
  }
}

export class BybitPublicStreamClient {
  public constructor(
    private readonly url: string,
    private readonly subscriptionRefreshMs = 30_000,
    private readonly reconnectDelayMs = 2_000,
  ) {}

  public async run(handlers: BybitPublicStreamHandlers, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runConnection(handlers, signal);
      } catch (error) {
        handlers.onError?.(asError(error));
      }
      if (!signal.aborted) await abortableDelay(this.reconnectDelayMs, signal);
    }
  }

  private runConnection(handlers: BybitPublicStreamHandlers, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, { handshakeTimeout: 15_000 });
      const activeTopics = new Set<string>();
      let lastMessageAt = Date.now();
      let opened = false;
      let settled = false;
      let synchronizing = false;
      let heartbeat: NodeJS.Timeout | undefined;
      let subscriptionRefresh: NodeJS.Timeout | undefined;

      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (heartbeat) clearInterval(heartbeat);
        if (subscriptionRefresh) clearInterval(subscriptionRefresh);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const sendTopics = (op: "subscribe" | "unsubscribe", topics: string[]) => {
        if (topics.length === 0 || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ req_id: randomUUID(), op, args: topics }));
      };
      const synchronizeSubscriptions = async () => {
        if (synchronizing || socket.readyState !== WebSocket.OPEN) return;
        synchronizing = true;
        try {
          const subscriptions = await handlers.getSubscriptions();
          const desiredTopics = new Set([
            ...(subscriptions.tradeSymbols ?? []).map((symbol) => `publicTrade.${symbol}`),
            ...subscriptions.tickerSymbols.map((symbol) => `tickers.${symbol}`),
            ...subscriptions.klines.map(({ symbol, interval }) => `kline.${interval}.${symbol}`),
          ]);
          const additions = [...desiredTopics].filter((topic) => !activeTopics.has(topic));
          const removals = [...activeTopics].filter((topic) => !desiredTopics.has(topic));
          sendTopics("subscribe", additions);
          sendTopics("unsubscribe", removals);
          for (const topic of additions) activeTopics.add(topic);
          for (const topic of removals) activeTopics.delete(topic);
        } catch (error) {
          handlers.onError?.(asError(error));
        } finally {
          synchronizing = false;
        }
      };
      const onAbort = () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1000, "worker stopping");
          return;
        }
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        settle();
      };

      socket.on("open", () => {
        opened = true;
        handlers.onConnected?.();
        void synchronizeSubscriptions();
        heartbeat = setInterval(() => {
          if (Date.now() - lastMessageAt > 45_000) {
            socket.terminate();
            return;
          }
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "ping" }));
        }, 20_000);
        subscriptionRefresh = setInterval(
          () => void synchronizeSubscriptions(),
          this.subscriptionRefreshMs,
        );
      });
      socket.on("message", (raw) => {
        lastMessageAt = Date.now();
        try {
          const acknowledgement = JSON.parse(raw.toString()) as { op?: string; success?: boolean };
          if (acknowledgement.op === "subscribe" && acknowledgement.success === false) {
            handlers.onError?.(new Error("Bybit subscription rejected"));
            socket.terminate();
            return;
          }
        } catch {
          /* The message parser reports malformed JSON. */
        }
        this.handleMessage(raw, {
          ...handlers,
          onError: (error) => {
            handlers.onError?.(error);
            socket.terminate();
          },
        });
      });
      socket.on("error", (error) => {
        if (!opened) settle(asError(error));
        else handlers.onError?.(asError(error));
      });
      socket.on("close", (code, reason) => {
        handlers.onDisconnected?.(code, reason.toString());
        settle();
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private handleMessage(raw: RawData, handlers: BybitPublicStreamHandlers) {
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      handlers.onError?.(new Error("Bybit stream returned invalid JSON"));
      return;
    }

    const trades = streamTradeSchema.safeParse(payload);
    if (
      !trades.success &&
      typeof payload === "object" &&
      payload !== null &&
      "topic" in payload &&
      String(payload.topic).startsWith("publicTrade.")
    ) {
      handlers.onError?.(new Error("Bybit stream returned invalid trade data"));
      return;
    }
    if (trades.success && handlers.onTrade) {
      for (const trade of trades.data.data) {
        invokeHandler(
          handlers.onTrade,
          { symbol: trade.s, price: trade.p, observedAt: new Date(trade.T), tradeId: trade.i },
          handlers.onError,
        );
      }
      return;
    }

    const ticker = streamTickerSchema.safeParse(payload);
    if (ticker.success) {
      const values = Array.isArray(ticker.data.data) ? ticker.data.data : [ticker.data.data];
      for (const value of values) {
        if (!value.lastPrice) continue;
        invokeHandler(
          handlers.onQuote,
          { symbol: value.symbol, price: value.lastPrice, observedAt: new Date(ticker.data.ts) },
          handlers.onError,
        );
      }
      return;
    }

    const kline = streamKlineSchema.safeParse(payload);
    if (!kline.success) return;
    const [, , topicSymbol] = kline.data.topic.split(".");
    if (!topicSymbol) return;
    for (const value of kline.data.data) {
      if (!value.confirm) continue;
      invokeHandler(
        handlers.onClosedCandle,
        {
          isClosed: true,
          symbol: topicSymbol,
          interval: value.interval,
          openTime: new Date(value.start),
          open: value.open,
          high: value.high,
          low: value.low,
          close: value.close,
          volume: value.volume,
          turnover: value.turnover,
        },
        handlers.onError,
      );
    }
  }
}

const definitiveCredentialErrorCodes = new Set([
  -2015, 33004, 10003, 10004, 10005, 10007, 10008, 10009, 10010, 10024, 10027,
]);

function sanitizeBybitMessage(message: string, apiKey: string, apiSecret: string) {
  return message
    .replaceAll(apiKey, "[redacted]")
    .replaceAll(apiSecret, "[redacted]")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, 240);
}

function invokeHandler<T>(
  handler: (value: T) => void | Promise<void>,
  value: T,
  onError: ((error: Error) => void) | undefined,
) {
  try {
    Promise.resolve(handler(value)).catch((error: unknown) => onError?.(asError(error)));
  } catch (error) {
    onError?.(asError(error));
  }
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
