import {
  apiEnvelopeSchema,
  marketDetailSchema,
  marketsSchema,
  overviewSchema,
  requestContextSchema,
  strategyCatalogSchema,
  strategyCreatedSchema,
  strategyDetailSchema,
  strategyStatusChangedSchema,
  strategyVersionCreatedSchema,
  tradeDetailSchema,
  tradingLedgerSchema,
  watchlistStateSchema,
  type MarketsDto,
  type MarketDetailDto,
  type OverviewPeriod,
  type OverviewDto,
  type RequestContextDto,
  type StrategyCatalogDto,
  type StrategyCreateDto,
  type StrategyCreatedDto,
  type StrategyDetailDto,
  type StrategyStatusChangedDto,
  type StrategyStatusTransitionDto,
  type StrategyVersionCreateDto,
  type StrategyVersionCreatedDto,
  type TradeDetailDto,
  type TradingLedgerDto,
  type WatchlistStateDto,
} from "@cryptoanal/contracts";
import type { z } from "zod";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

export class ApiClientError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

type ApiEnvelope<T> = {
  data: T;
  meta: {
    requestId: string;
    generatedAt: string;
    freshness: "fresh" | "stale" | "unavailable";
  };
};

async function request<T>(
  path: string,
  schema: z.ZodType<ApiEnvelope<T>>,
  init?: RequestInit,
): Promise<ApiEnvelope<T>> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    credentials: "include",
    ...init,
    headers,
  });
  const payload: unknown = await response.json();

  if (!response.ok) {
    const errorPayload = payload as {
      error?: { code?: string; message?: string; requestId?: string };
    };
    throw new ApiClientError(
      errorPayload.error?.message ?? "Запрос завершился ошибкой",
      errorPayload.error?.code ?? "UNKNOWN_ERROR",
      errorPayload.error?.requestId,
    );
  }

  return schema.parse(payload);
}

const contextEnvelopeSchema = apiEnvelopeSchema(requestContextSchema);
const overviewEnvelopeSchema = apiEnvelopeSchema(overviewSchema);
const marketsEnvelopeSchema = apiEnvelopeSchema(marketsSchema);
const marketDetailEnvelopeSchema = apiEnvelopeSchema(marketDetailSchema);
const watchlistStateEnvelopeSchema = apiEnvelopeSchema(watchlistStateSchema);
const tradingLedgerEnvelopeSchema = apiEnvelopeSchema(tradingLedgerSchema);
const tradeDetailEnvelopeSchema = apiEnvelopeSchema(tradeDetailSchema);
const strategyCatalogEnvelopeSchema = apiEnvelopeSchema(strategyCatalogSchema);
const strategyCreatedEnvelopeSchema = apiEnvelopeSchema(strategyCreatedSchema);
const strategyDetailEnvelopeSchema = apiEnvelopeSchema(strategyDetailSchema);
const strategyStatusChangedEnvelopeSchema = apiEnvelopeSchema(strategyStatusChangedSchema);
const strategyVersionCreatedEnvelopeSchema = apiEnvelopeSchema(strategyVersionCreatedSchema);

export function fetchRequestContext(): Promise<ApiEnvelope<RequestContextDto>> {
  return request("/api/v1/context", contextEnvelopeSchema);
}

export function fetchOverview(period: OverviewPeriod = "7d"): Promise<ApiEnvelope<OverviewDto>> {
  return request(`/api/v1/overview?period=${period}`, overviewEnvelopeSchema);
}

export function fetchMarkets(): Promise<ApiEnvelope<MarketsDto>> {
  return request("/api/v1/markets", marketsEnvelopeSchema);
}

export function fetchMarketDetail(symbol: string): Promise<ApiEnvelope<MarketDetailDto>> {
  return request(`/api/v1/markets/${encodeURIComponent(symbol)}`, marketDetailEnvelopeSchema);
}

export function setWatchlisted(
  symbol: string,
  watchlisted: boolean,
): Promise<ApiEnvelope<WatchlistStateDto>> {
  return request(`/api/v1/watchlist/${encodeURIComponent(symbol)}`, watchlistStateEnvelopeSchema, {
    method: watchlisted ? "PUT" : "DELETE",
  });
}

export function fetchTradingLedger(): Promise<ApiEnvelope<TradingLedgerDto>> {
  return request("/api/v1/trades", tradingLedgerEnvelopeSchema);
}

export function fetchTradeDetail(tradeId: string): Promise<ApiEnvelope<TradeDetailDto>> {
  return request(`/api/v1/trades/${encodeURIComponent(tradeId)}`, tradeDetailEnvelopeSchema);
}

export function fetchStrategies(): Promise<ApiEnvelope<StrategyCatalogDto>> {
  return request("/api/v1/strategies", strategyCatalogEnvelopeSchema);
}

export function createStrategy(
  strategy: StrategyCreateDto,
): Promise<ApiEnvelope<StrategyCreatedDto>> {
  return request("/api/v1/strategies", strategyCreatedEnvelopeSchema, {
    method: "POST",
    body: JSON.stringify(strategy),
  });
}

export function fetchStrategyDetail(strategyId: string): Promise<ApiEnvelope<StrategyDetailDto>> {
  return request(
    `/api/v1/strategies/${encodeURIComponent(strategyId)}`,
    strategyDetailEnvelopeSchema,
  );
}

export function createStrategyVersion(
  strategyId: string,
  version: StrategyVersionCreateDto,
): Promise<ApiEnvelope<StrategyVersionCreatedDto>> {
  return request(
    `/api/v1/strategies/${encodeURIComponent(strategyId)}/versions`,
    strategyVersionCreatedEnvelopeSchema,
    { method: "POST", body: JSON.stringify(version) },
  );
}

export function changeStrategyStatus(
  strategyId: string,
  transition: StrategyStatusTransitionDto,
): Promise<ApiEnvelope<StrategyStatusChangedDto>> {
  return request(
    `/api/v1/strategies/${encodeURIComponent(strategyId)}/status`,
    strategyStatusChangedEnvelopeSchema,
    { method: "POST", body: JSON.stringify(transition) },
  );
}
