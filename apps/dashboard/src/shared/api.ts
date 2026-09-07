import {
  apiEnvelopeSchema,
  authSessionSchema,
  analyticsSchema,
  activitySchema,
  deploymentMutationResultSchema,
  deploymentsSchema,
  healthDashboardSchema,
  journalEntryCreatedSchema,
  journalSchema,
  marketDetailSchema,
  marketsSchema,
  overviewSchema,
  playbookMutationSchema,
  playbooksSchema,
  positionCloseResultSchema,
  requestContextSchema,
  reviewSessionCreatedSchema,
  settingsExportSchema,
  settingsMutationSchema,
  settingsSchema,
  strategyCatalogSchema,
  strategyCreatedSchema,
  strategyDetailSchema,
  strategyStatusChangedSchema,
  strategyVersionCreatedSchema,
  systemLogsSchema,
  tradeDetailSchema,
  tradingLedgerSchema,
  validationRunQueuedSchema,
  validationRunDetailSchema,
  validationsSchema,
  watchlistStateSchema,
  type AuthLoginDto,
  type AuthSessionDto,
  type MarketsDto,
  type AnalyticsDto,
  type AnalyticsQueryDto,
  type ActivityDto,
  type ActivityQueryDto,
  type MarketDetailDto,
  type DeploymentCommandInputDto,
  type DeploymentCreateDto,
  type DeploymentMutationResultDto,
  type DeploymentsDto,
  type HealthDashboardDto,
  type JournalDto,
  type JournalEntryCreateDto,
  type JournalEntryCreatedDto,
  type JournalQueryDto,
  type OverviewPeriod,
  type OverviewDto,
  type PlaybookCreateDto,
  type PlaybookMutationDto,
  type PlaybookQueryDto,
  type PlaybooksDto,
  type PlaybookStatusChangeDto,
  type PlaybookUpdateDto,
  type PositionCloseInputDto,
  type PositionCloseResultDto,
  type RequestContextDto,
  type ReviewSessionCreateDto,
  type ReviewSessionCreatedDto,
  type SettingsDto,
  type SettingsExportDto,
  type SettingsMutationDto,
  type SettingsUpdateDto,
  type StrategyCatalogDto,
  type StrategyCreateDto,
  type StrategyCreatedDto,
  type StrategyDetailDto,
  type StrategyStatusChangedDto,
  type StrategyStatusTransitionDto,
  type StrategyVersionCreateDto,
  type StrategyVersionCreatedDto,
  type SystemLogsDto,
  type SystemLogsQueryDto,
  type TradeDetailDto,
  type TradingLedgerDto,
  type ValidationRunInputDto,
  type ValidationRunDetailDto,
  type ValidationRunQueuedDto,
  type ValidationsDto,
  type WatchlistStateDto,
} from "@cryptoanal/contracts";
import type { z } from "zod";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
let csrfToken: string | null = null;

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
  const method = init?.method?.toUpperCase() ?? "GET";
  if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("x-csrf-token", csrfToken);
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
    if (response.status === 401 && path !== "/api/v1/auth/login") {
      csrfToken = null;
      window.dispatchEvent(new Event("cryptoanal:auth-required"));
    }
    throw new ApiClientError(
      errorPayload.error?.message ?? "Запрос завершился ошибкой",
      errorPayload.error?.code ?? "UNKNOWN_ERROR",
      errorPayload.error?.requestId,
    );
  }

  return schema.parse(payload);
}

const contextEnvelopeSchema = apiEnvelopeSchema(requestContextSchema);
const authSessionEnvelopeSchema = apiEnvelopeSchema(authSessionSchema);
const analyticsEnvelopeSchema = apiEnvelopeSchema(analyticsSchema);
const activityEnvelopeSchema = apiEnvelopeSchema(activitySchema);
const healthDashboardEnvelopeSchema = apiEnvelopeSchema(healthDashboardSchema);
const journalEnvelopeSchema = apiEnvelopeSchema(journalSchema);
const journalEntryCreatedEnvelopeSchema = apiEnvelopeSchema(journalEntryCreatedSchema);
const reviewSessionCreatedEnvelopeSchema = apiEnvelopeSchema(reviewSessionCreatedSchema);
const settingsEnvelopeSchema = apiEnvelopeSchema(settingsSchema);
const settingsMutationEnvelopeSchema = apiEnvelopeSchema(settingsMutationSchema);
const settingsExportEnvelopeSchema = apiEnvelopeSchema(settingsExportSchema);
const overviewEnvelopeSchema = apiEnvelopeSchema(overviewSchema);
const playbooksEnvelopeSchema = apiEnvelopeSchema(playbooksSchema);
const playbookMutationEnvelopeSchema = apiEnvelopeSchema(playbookMutationSchema);
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
const systemLogsEnvelopeSchema = apiEnvelopeSchema(systemLogsSchema);
const validationsEnvelopeSchema = apiEnvelopeSchema(validationsSchema);
const validationRunQueuedEnvelopeSchema = apiEnvelopeSchema(validationRunQueuedSchema);
const validationRunDetailEnvelopeSchema = apiEnvelopeSchema(validationRunDetailSchema);
const deploymentsEnvelopeSchema = apiEnvelopeSchema(deploymentsSchema);
const deploymentMutationResultEnvelopeSchema = apiEnvelopeSchema(deploymentMutationResultSchema);
const positionCloseResultEnvelopeSchema = apiEnvelopeSchema(positionCloseResultSchema);

export function fetchRequestContext(): Promise<ApiEnvelope<RequestContextDto>> {
  return request("/api/v1/context", contextEnvelopeSchema);
}

export async function fetchAuthSession(): Promise<ApiEnvelope<AuthSessionDto>> {
  const response = await request("/api/v1/auth/session", authSessionEnvelopeSchema);
  csrfToken = response.data.authenticated ? response.data.csrfToken : null;
  return response;
}

export async function login(input: AuthLoginDto): Promise<ApiEnvelope<AuthSessionDto>> {
  const response = await request("/api/v1/auth/login", authSessionEnvelopeSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });
  csrfToken = response.data.authenticated ? response.data.csrfToken : null;
  return response;
}

export async function logout(): Promise<ApiEnvelope<AuthSessionDto>> {
  const response = await request("/api/v1/auth/logout", authSessionEnvelopeSchema, {
    method: "POST",
  });
  csrfToken = null;
  return response;
}

export async function switchWorkspace(workspaceId: string): Promise<ApiEnvelope<AuthSessionDto>> {
  const response = await request("/api/v1/auth/workspace", authSessionEnvelopeSchema, {
    method: "POST",
    body: JSON.stringify({ workspaceId }),
  });
  csrfToken = response.data.authenticated ? response.data.csrfToken : null;
  return response;
}

export function fetchOverview(period: OverviewPeriod = "7d"): Promise<ApiEnvelope<OverviewDto>> {
  return request(`/api/v1/overview?period=${period}`, overviewEnvelopeSchema);
}

export function fetchAnalytics(filters: AnalyticsQueryDto): Promise<ApiEnvelope<AnalyticsDto>> {
  const query = new URLSearchParams({ period: filters.period });
  if (filters.environment) query.set("environment", filters.environment);
  if (filters.strategyId) query.set("strategyId", filters.strategyId);
  if (filters.symbol) query.set("symbol", filters.symbol);
  return request(`/api/v1/analytics?${query.toString()}`, analyticsEnvelopeSchema);
}

export function fetchHealthDashboard(): Promise<ApiEnvelope<HealthDashboardDto>> {
  return request("/api/v1/health", healthDashboardEnvelopeSchema);
}

export function fetchJournal(
  filters: JournalQueryDto,
  cursor?: string,
): Promise<ApiEnvelope<JournalDto>> {
  const query = new URLSearchParams({ period: filters.period, limit: String(filters.limit) });
  if (filters.kind) query.set("kind", filters.kind);
  if (filters.strategyId) query.set("strategyId", filters.strategyId);
  if (filters.symbol) query.set("symbol", filters.symbol);
  if (filters.tag) query.set("tag", filters.tag);
  if (cursor) query.set("cursor", cursor);
  return request(`/api/v1/journal?${query.toString()}`, journalEnvelopeSchema);
}

export function fetchPlaybooks(filters: PlaybookQueryDto): Promise<ApiEnvelope<PlaybooksDto>> {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (filters.strategyId) query.set("strategyId", filters.strategyId);
  if (filters.tag) query.set("tag", filters.tag);
  if (filters.query) query.set("query", filters.query);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return request(`/api/v1/playbooks${suffix}`, playbooksEnvelopeSchema);
}

export function createPlaybook(
  input: PlaybookCreateDto,
): Promise<ApiEnvelope<PlaybookMutationDto>> {
  return request("/api/v1/playbooks", playbookMutationEnvelopeSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updatePlaybook(
  playbookId: string,
  input: PlaybookUpdateDto,
): Promise<ApiEnvelope<PlaybookMutationDto>> {
  return request(
    `/api/v1/playbooks/${encodeURIComponent(playbookId)}`,
    playbookMutationEnvelopeSchema,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export function changePlaybookStatus(
  playbookId: string,
  input: PlaybookStatusChangeDto,
): Promise<ApiEnvelope<PlaybookMutationDto>> {
  return request(
    `/api/v1/playbooks/${encodeURIComponent(playbookId)}/status`,
    playbookMutationEnvelopeSchema,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function fetchSettings(): Promise<ApiEnvelope<SettingsDto>> {
  return request("/api/v1/settings", settingsEnvelopeSchema);
}

export function updateWorkspacePreferences(
  input: SettingsUpdateDto,
): Promise<ApiEnvelope<SettingsMutationDto>> {
  return request("/api/v1/settings/preferences", settingsMutationEnvelopeSchema, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function exportWorkspace(): Promise<ApiEnvelope<SettingsExportDto>> {
  return request("/api/v1/settings/export", settingsExportEnvelopeSchema);
}

export function fetchSystemLogs(
  filters: SystemLogsQueryDto,
  cursor?: string,
): Promise<ApiEnvelope<SystemLogsDto>> {
  const query = new URLSearchParams({ period: filters.period, limit: String(filters.limit) });
  if (filters.level) query.set("level", filters.level);
  if (filters.service) query.set("service", filters.service);
  if (filters.correlationId) query.set("correlationId", filters.correlationId);
  if (filters.query) query.set("query", filters.query);
  if (cursor) query.set("cursor", cursor);
  return request(`/api/v1/system/logs?${query.toString()}`, systemLogsEnvelopeSchema);
}

export function createJournalEntry(
  input: JournalEntryCreateDto,
): Promise<ApiEnvelope<JournalEntryCreatedDto>> {
  return request("/api/v1/journal/entries", journalEntryCreatedEnvelopeSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function createReviewSession(
  input: ReviewSessionCreateDto,
): Promise<ApiEnvelope<ReviewSessionCreatedDto>> {
  return request("/api/v1/journal/reviews", reviewSessionCreatedEnvelopeSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchActivity(
  filters: ActivityQueryDto,
  cursor?: string,
): Promise<ApiEnvelope<ActivityDto>> {
  const query = new URLSearchParams({ period: filters.period, limit: String(filters.limit) });
  if (filters.action) query.set("action", filters.action);
  if (filters.strategyId) query.set("strategyId", filters.strategyId);
  if (filters.symbol) query.set("symbol", filters.symbol);
  if (filters.reasonCode) query.set("reasonCode", filters.reasonCode);
  if (cursor) query.set("cursor", cursor);
  return request(`/api/v1/activity?${query.toString()}`, activityEnvelopeSchema);
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

export function closePosition(
  positionId: string,
  input: PositionCloseInputDto,
): Promise<ApiEnvelope<PositionCloseResultDto>> {
  return request(
    `/api/v1/positions/${encodeURIComponent(positionId)}/close`,
    positionCloseResultEnvelopeSchema,
    { method: "POST", body: JSON.stringify(input) },
  );
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

export function fetchValidations(): Promise<ApiEnvelope<ValidationsDto>> {
  return request("/api/v1/validations", validationsEnvelopeSchema);
}

export function fetchValidationRun(
  validationRunId: string,
  tradePage = 1,
  tradeLimit = 50,
): Promise<ApiEnvelope<ValidationRunDetailDto>> {
  return request(
    `/api/v1/validations/${encodeURIComponent(validationRunId)}?tradePage=${tradePage}&tradeLimit=${tradeLimit}`,
    validationRunDetailEnvelopeSchema,
  );
}

export function queueValidationRun(
  strategyId: string,
  input: ValidationRunInputDto,
): Promise<ApiEnvelope<ValidationRunQueuedDto>> {
  return request(
    `/api/v1/strategies/${encodeURIComponent(strategyId)}/validations`,
    validationRunQueuedEnvelopeSchema,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function fetchDeployments(): Promise<ApiEnvelope<DeploymentsDto>> {
  return request("/api/v1/deployments", deploymentsEnvelopeSchema);
}

export function createDeployment(
  strategyId: string,
  input: DeploymentCreateDto,
): Promise<ApiEnvelope<DeploymentMutationResultDto>> {
  return request(
    `/api/v1/strategies/${encodeURIComponent(strategyId)}/deployments`,
    deploymentMutationResultEnvelopeSchema,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function applyDeploymentCommand(
  deploymentId: string,
  input: DeploymentCommandInputDto,
): Promise<ApiEnvelope<DeploymentMutationResultDto>> {
  return request(
    `/api/v1/deployments/${encodeURIComponent(deploymentId)}/commands`,
    deploymentMutationResultEnvelopeSchema,
    { method: "POST", body: JSON.stringify(input) },
  );
}
