import Decimal from "decimal.js";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";

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

export type BybitMarketCandle = {
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
  public constructor(
    private readonly baseUrl: string,
    private readonly receiveWindowMs = 5_000,
  ) {}

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
    if (signal) requestInit.signal = signal;

    let response: Response;
    try {
      response = await fetch(url, requestInit);
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
  public constructor(private readonly baseUrl: string) {}

  public async getLinearTickers(signal?: AbortSignal): Promise<BybitMarketTicker[]> {
    const url = new URL("/v5/market/tickers", this.baseUrl);
    url.searchParams.set("category", "linear");

    const requestInit: RequestInit = {
      headers: { Accept: "application/json" },
    };
    if (signal) requestInit.signal = signal;

    const response = await fetch(url, requestInit);

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
    if (signal) requestInit.signal = signal;

    const response = await fetch(url, requestInit);
    if (!response.ok) {
      throw new Error(`Bybit kline request failed with HTTP ${response.status}`);
    }

    const payload = klineResponseSchema.parse(await response.json());
    if (payload.retCode !== 0) {
      throw new Error(`Bybit kline request failed: ${payload.retCode} ${payload.retMsg}`);
    }

    return payload.result.list
      .map(([openTime, open, high, low, close, volume, turnover]) => ({
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
