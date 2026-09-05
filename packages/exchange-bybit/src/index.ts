import Decimal from "decimal.js";
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
    const url = new URL("/v5/market/kline", this.baseUrl);
    url.searchParams.set("category", "linear");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));

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
