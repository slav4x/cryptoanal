import {
  apiEnvelopeSchema,
  marketsSchema,
  overviewSchema,
  requestContextSchema,
  type MarketsDto,
  type OverviewDto,
  type RequestContextDto,
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

async function get<T>(path: string, schema: z.ZodType<ApiEnvelope<T>>): Promise<ApiEnvelope<T>> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { Accept: "application/json" },
    credentials: "include",
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

export function fetchRequestContext(): Promise<ApiEnvelope<RequestContextDto>> {
  return get("/api/v1/context", contextEnvelopeSchema);
}

export function fetchOverview(): Promise<ApiEnvelope<OverviewDto>> {
  return get("/api/v1/overview", overviewEnvelopeSchema);
}

export function fetchMarkets(): Promise<ApiEnvelope<MarketsDto>> {
  return get("/api/v1/markets", marketsEnvelopeSchema);
}
