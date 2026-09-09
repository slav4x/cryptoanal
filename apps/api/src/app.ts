import {
  calculateMarketAnalysis,
  buildPerformanceAnalytics,
  evaluateHealth,
  canTransitionStrategyStatus,
  executionEngineVersion,
  evaluateStrategyLifecycle,
  getDeploymentCommands,
  settleExecutionPosition,
  validationDatasetSource,
  validationEngineVersion,
} from "@cryptoanal/application";
import type { ServerConfig } from "@cryptoanal/config";
import {
  apiEnvelopeSchema,
  authLoginSchema,
  authPasswordChangedSchema,
  authPasswordChangeSchema,
  authPasswordRecoveredSchema,
  authPasswordRecoverySchema,
  authRecoveryDetailsSchema,
  authRecoveryTokenParamsSchema,
  authSessionParamsSchema,
  authSessionRevokedSchema,
  authSessionSchema,
  authSessionsSchema,
  invitationAcceptSchema,
  invitationDetailsSchema,
  invitationTokenParamsSchema,
  analyticsQuerySchema,
  analyticsSchema,
  activityQuerySchema,
  activitySchema,
  deploymentCommandInputSchema,
  deploymentCreateSchema,
  deploymentIdParamsSchema,
  deploymentMutationResultSchema,
  deploymentsSchema,
  errorEnvelopeSchema,
  exchangeConnectionCreateSchema,
  exchangeConnectionCreatedSchema,
  exchangeConnectionCredentialsSchema,
  exchangeConnectionParamsSchema,
  exchangeConnectionsSchema,
  healthSchema,
  healthDashboardSchema,
  journalEntryCreateSchema,
  journalEntryCreatedSchema,
  journalQuerySchema,
  journalSchema,
  marketDetailSchema,
  marketSymbolParamsSchema,
  marketsSchema,
  overviewQuerySchema,
  overviewSchema,
  playbookCreateSchema,
  playbookIdParamsSchema,
  playbookMutationSchema,
  playbookQuerySchema,
  playbookStatusChangeSchema,
  playbooksSchema,
  playbookUpdateSchema,
  positionCloseInputSchema,
  positionCloseResultSchema,
  positionIdParamsSchema,
  requestContextSchema,
  reviewSessionCreateSchema,
  reviewSessionCreatedSchema,
  settingsExportSchema,
  settingsMutationSchema,
  settingsSchema,
  settingsUpdateSchema,
  strategyCatalogSchema,
  strategyConfigSchema,
  strategyCreateSchema,
  strategyCreatedSchema,
  strategyDetailSchema,
  strategyIdParamsSchema,
  strategyStatusChangedSchema,
  strategyStatusTransitionSchema,
  strategyVersionCreateSchema,
  strategyVersionCreatedSchema,
  systemLogsQuerySchema,
  systemLogsSchema,
  tradeDetailSchema,
  tradeIdParamsSchema,
  tradingLedgerSchema,
  validationExecutionInputSchema,
  validationMetricsSchema,
  validationMetricsSummarySchema,
  validationRunDetailSchema,
  validationRunDetailQuerySchema,
  validationRunIdParamsSchema,
  validationRunInputSchema,
  validationRunQueuedSchema,
  validationsSchema,
  watchlistStateSchema,
  workspaceCreateSchema,
  workspaceAccessSchema,
  workspaceIdParamsSchema,
  workspaceInvitationCreateSchema,
  workspaceInvitationCreatedSchema,
  workspaceInvitationParamsSchema,
  workspaceMemberParamsSchema,
  workspaceMemberRoleUpdateSchema,
  mutationAcceptedSchema,
  workspaceSwitchSchema,
} from "@cryptoanal/contracts";
import {
  BybitCredentialsRejectedError,
  BybitPrivateApiUnavailableError,
  BybitPrivateClient,
  describeBybitCredentialRejection,
  evaluateBybitPermissions,
} from "@cryptoanal/exchange-bybit";
import {
  ActiveDeploymentExistsError,
  ActivityCursorNotFoundError,
  ActivityRepository,
  AnalyticsRepository,
  AuthRepository,
  AuthInvitationInvalidError,
  AuthInvitationMembershipExistsError,
  AuthLastOwnerError,
  AuthMemberNotFoundError,
  AuthPasswordConflictError,
  AuthRecoveryInvalidError,
  AuthWorkspaceAccessDeniedError,
  AuthWorkspaceLimitReachedError,
  AuthSessionNotFoundError,
  type CryptoAnalPrismaClient,
  DashboardRepository,
  CredentialCipher,
  DeploymentCommandNotAllowedError,
  DeploymentExchangeConnectionNotFoundError,
  DeploymentExchangeConnectionNotReadyError,
  DeploymentHasOpenPositionsError,
  DeploymentIdempotencyConflictError,
  DeploymentNotEligibleError,
  DeploymentNotFoundError,
  DeploymentRepository,
  DeploymentStatusConflictError,
  DeploymentStrategyNotFoundError,
  DeploymentValidationRequiredError,
  DeploymentVersionMismatchError,
  ExchangeConnectionNotFoundError,
  ExchangeConnectionInUseError,
  ExchangeConnectionRepository,
  ExchangeConnectionVerificationConflictError,
  HealthRepository,
  JournalCursorNotFoundError,
  JournalRepository,
  JournalTargetNotFoundError,
  PlaybookLinkNotFoundError,
  PlaybookNameConflictError,
  PlaybookNotFoundError,
  PlaybookRepository,
  PlaybookStatusConflictError,
  PlaybookUpdateConflictError,
  RuntimeIdempotencyConflictError,
  RuntimeManualCloseNotAllowedError,
  RuntimeMarketPriceUnavailableError,
  RuntimePositionNotFoundError,
  RuntimePositionStatusConflictError,
  RuntimeRepository,
  SettingsRepository,
  StrategyNameConflictError,
  StrategyConfigUnchangedError,
  StrategyNotFoundError,
  StrategyRepository,
  StrategyStatusConflictError,
  StrategyVersionNotAllowedError,
  redactSystemLogMetadata,
  SystemLogCursorNotFoundError,
  SystemLogRepository,
  WorkspaceSettingsConflictError,
  WorkspaceSettingsNotFoundError,
  WorkspaceTimezoneInvalidError,
  ValidationAlreadyActiveError,
  ValidationNotEligibleError,
  ValidationRepository,
  ValidationStrategyNotFoundError,
  ValidationVersionMismatchError,
  exchangeCredentialContext,
} from "@cryptoanal/persistence";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { argon2id, hash, verify } from "argon2";
import Fastify, { type FastifyRequest } from "fastify";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

const applicationVersion = "0.1.0";

type CreateAppDependencies = {
  config: ServerConfig;
  prisma: CryptoAnalPrismaClient;
};

type AuthenticatedContext = {
  sessionId: string;
  actorId: string;
  user: { id: string; email: string; displayName: string };
  workspace: { id: string; slug: string; name: string; role: "owner" | "member" };
  workspaces: Array<{ id: string; slug: string; name: string; role: "owner" | "member" }>;
  csrfToken: string;
  expiresAt: Date;
};

const sessionCookieName = "cryptoanal_session";

class ApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function createApp({ config, prisma }: CreateAppDependencies) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  const repository = new DashboardRepository(prisma);
  const credentialCipher = new CredentialCipher(config.EXCHANGE_CREDENTIALS_KEY);
  const exchangeConnectionRepository = new ExchangeConnectionRepository(prisma);
  const bybitPrivateClients = {
    DEMO: new BybitPrivateClient(config.BYBIT_DEMO_BASE_URL),
    LIVE: new BybitPrivateClient(config.BYBIT_LIVE_BASE_URL),
  } as const;
  const authRepository = new AuthRepository(prisma);
  const analyticsRepository = new AnalyticsRepository(prisma);
  const activityRepository = new ActivityRepository(prisma);
  const healthRepository = new HealthRepository(prisma);
  const journalRepository = new JournalRepository(prisma);
  const playbookRepository = new PlaybookRepository(prisma);
  const deploymentRepository = new DeploymentRepository(prisma);
  const runtimeRepository = new RuntimeRepository(prisma);
  const settingsRepository = new SettingsRepository(prisma);
  const systemLogRepository = new SystemLogRepository(prisma);
  const strategyRepository = new StrategyRepository(prisma);
  const validationRepository = new ValidationRepository(prisma);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  await app.register(helmet);
  await app.register(rateLimit, { global: false });

  await app.register(cors, {
    origin: config.DASHBOARD_ORIGIN,
    credentials: true,
  });

  const requestContexts = new WeakMap<FastifyRequest, AuthenticatedContext>();
  const invalidPasswordHash = await hash(randomBytes(32), { type: argon2id });

  async function resolveSessionToken(rawToken: string) {
    const session = await authRepository.findActiveSession(hashSessionToken(rawToken));
    if (!session) return null;
    if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
      await authRepository.touchSession(session.id);
    }
    return {
      sessionId: session.id,
      actorId: session.user.id,
      user: {
        id: session.user.id,
        email: session.user.email,
        displayName: session.user.displayName,
      },
      workspace: serializeAuthWorkspace(session.activeMembership),
      workspaces: session.user.memberships.map(serializeAuthWorkspace),
      csrfToken: createCsrfToken(config.AUTH_SECRET, rawToken),
      expiresAt: session.expiresAt,
    } satisfies AuthenticatedContext;
  }

  async function resolveSession(request: FastifyRequest) {
    const rawToken = request.cookies[sessionCookieName];
    return rawToken ? resolveSessionToken(rawToken) : null;
  }

  app.addHook("onRequest", async (request) => {
    if (request.method === "OPTIONS" || isPublicRoute(request.url)) return;
    const context = await resolveSession(request);
    if (!context) throw new ApiError(401, "AUTH_REQUIRED", "Необходим вход в систему");
    requestContexts.set(request, context);
    if (isMutatingMethod(request.method)) {
      assertCsrfToken(request.headers["x-csrf-token"], context.csrfToken);
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url;
    const excluded = route === "/health" || route === "/api/v1/system/logs";
    const readOnlySuccess = request.method === "GET" && reply.statusCode < 400;
    if (excluded || readOnlySuccess || request.method === "OPTIONS" || request.method === "HEAD") {
      return;
    }
    try {
      const context = requestContexts.get(request);
      if (!context) return;
      await systemLogRepository.write({
        workspaceId: context.workspace.id,
        level: reply.statusCode >= 500 ? "ERROR" : reply.statusCode >= 400 ? "WARNING" : "INFO",
        service: "api",
        event: "http.request.completed",
        message: `${request.method} ${route} completed with ${reply.statusCode}`,
        correlationId: request.id,
        metadata: {
          method: request.method,
          route,
          statusCode: reply.statusCode,
          durationMs: Math.round(reply.elapsedTime * 100) / 100,
        },
      });
    } catch (error) {
      request.log.error({ err: error }, "Failed to persist structured system log");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const validationMessages = getValidationMessages(error);
    const rateLimited = !(error instanceof ApiError) && hasStatusCode(error, 429);
    const statusCode =
      error instanceof ApiError
        ? error.statusCode
        : rateLimited
          ? 429
          : validationMessages
            ? 400
            : 500;
    const code =
      error instanceof ApiError
        ? error.code
        : rateLimited
          ? "AUTH_RATE_LIMITED"
          : validationMessages
            ? "VALIDATION_ERROR"
            : "INTERNAL_ERROR";
    const message =
      error instanceof ApiError
        ? error.message
        : rateLimited
          ? "Слишком много попыток. Повторите позже"
          : validationMessages
            ? "Параметры запроса не прошли проверку"
            : "Внутренняя ошибка сервера";

    if (!(error instanceof ApiError) && !validationMessages && !rateLimited) {
      request.log.error({ err: error }, "Unhandled API error");
    }

    return reply.status(statusCode).send({
      error: {
        code,
        message,
        ...(validationMessages ? { fields: { request: validationMessages } } : {}),
        requestId: request.id,
      },
    });
  });

  function requireContext(request: FastifyRequest) {
    const context = requestContexts.get(request);
    if (!context) throw new ApiError(401, "AUTH_REQUIRED", "Необходим вход в систему");
    return context;
  }

  function requireWorkspace(request: FastifyRequest) {
    return requireContext(request).workspace;
  }

  function requireActiveWorkspace(request: FastifyRequest, workspaceId: string) {
    const context = requireContext(request);
    if (context.workspace.id !== workspaceId) {
      throw new ApiError(403, "WORKSPACE_ACCESS_DENIED", "Сначала переключитесь в этот workspace");
    }
    return context;
  }

  function requireWorkspaceOwner(request: FastifyRequest, workspaceId: string) {
    const context = requireActiveWorkspace(request, workspaceId);
    if (context.workspace.role !== "owner") {
      throw new ApiError(403, "WORKSPACE_OWNER_REQUIRED", "Действие доступно только владельцу");
    }
    return context;
  }

  app.get(
    "/health",
    {
      schema: {
        response: {
          200: healthSchema,
          503: healthSchema,
        },
      },
    },
    async (_request, reply) => {
      const databaseConnected = await repository.ping();
      const payload = {
        status: databaseConnected ? ("ok" as const) : ("degraded" as const),
        service: "api" as const,
        version: applicationVersion,
        database: databaseConnected ? ("connected" as const) : ("unavailable" as const),
        timestamp: new Date().toISOString(),
      };

      return reply.status(databaseConnected ? 200 : 503).send(payload);
    },
  );

  app.get(
    "/api/v1/auth/session",
    {
      schema: {
        response: { 200: apiEnvelopeSchema(authSessionSchema) },
      },
    },
    async (request, reply) => {
      const context = await resolveSession(request);
      if (!context) {
        reply.clearCookie(sessionCookieName, sessionCookieOptions(config));
        return { data: { authenticated: false as const }, meta: createMeta(request.id, "fresh") };
      }
      return { data: serializeAuthSession(context), meta: createMeta(request.id, "fresh") };
    },
  );

  app.post(
    "/api/v1/auth/login",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        body: authLoginSchema,
        response: {
          200: apiEnvelopeSchema(authSessionSchema),
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim().toLowerCase();
      const user = await authRepository.findUserForLogin(email);
      const passwordMatches = await verify(
        user?.passwordHash ?? invalidPasswordHash,
        request.body.password,
      );
      if (!user || !passwordMatches || user.disabledAt) {
        throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "Неверный email или пароль");
      }
      const membership = user.memberships[0];
      if (!membership) {
        throw new ApiError(403, "AUTH_WORKSPACE_REQUIRED", "Пользователь не состоит в workspace");
      }
      const rawToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + config.AUTH_SESSION_TTL_HOURS * 60 * 60_000);
      let createdSession: { id: string };
      try {
        createdSession = await authRepository.createSession({
          tokenHash: hashSessionToken(rawToken),
          userId: user.id,
          workspaceId: membership.workspace.id,
          expiresAt,
          userAgent: normalizeHeader(request.headers["user-agent"]),
          ipAddress: request.ip,
          requestId: request.id,
          maxActiveSessions: config.AUTH_MAX_ACTIVE_SESSIONS,
          expectedPasswordHash: user.passwordHash,
        });
      } catch (error) {
        if (error instanceof AuthPasswordConflictError) {
          throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "Неверный email или пароль");
        }
        throw error;
      }
      reply.setCookie(sessionCookieName, rawToken, sessionCookieOptions(config));
      const context = {
        sessionId: createdSession.id,
        actorId: user.id,
        user: { id: user.id, email: user.email, displayName: user.displayName },
        workspace: serializeAuthWorkspace(membership),
        workspaces: user.memberships.map(serializeAuthWorkspace),
        csrfToken: createCsrfToken(config.AUTH_SECRET, rawToken),
        expiresAt,
      } satisfies AuthenticatedContext;
      return { data: serializeAuthSession(context), meta: createMeta(request.id, "fresh") };
    },
  );

  app.post(
    "/api/v1/auth/logout",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(authSessionSchema),
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const context = requireContext(request);
      await authRepository.revokeSession({
        sessionId: context.sessionId,
        workspaceId: context.workspace.id,
        actorId: context.actorId,
        requestId: request.id,
      });
      reply.clearCookie(sessionCookieName, sessionCookieOptions(config));
      return { data: { authenticated: false as const }, meta: createMeta(request.id, "fresh") };
    },
  );

  app.get(
    "/api/v1/auth/sessions",
    {
      schema: {
        response: { 200: apiEnvelopeSchema(authSessionsSchema) },
      },
    },
    async (request) => {
      const context = requireContext(request);
      const sessions = await authRepository.listSessions(context.user.id, context.sessionId);
      return {
        data: {
          sessions: sessions.map((session) => ({
            ...session,
            createdAt: session.createdAt.toISOString(),
            lastSeenAt: session.lastSeenAt.toISOString(),
            expiresAt: session.expiresAt.toISOString(),
          })),
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.delete(
    "/api/v1/auth/sessions/:sessionId",
    {
      schema: {
        params: authSessionParamsSchema,
        response: {
          200: apiEnvelopeSchema(authSessionRevokedSchema),
          404: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const context = requireContext(request);
      try {
        const result = await authRepository.revokeUserSession({
          sessionId: request.params.sessionId,
          currentSessionId: context.sessionId,
          userId: context.user.id,
          workspaceId: context.workspace.id,
          requestId: request.id,
        });
        if (result.current) {
          reply.clearCookie(sessionCookieName, sessionCookieOptions(config));
        }
        return {
          data: { revoked: true as const, current: result.current },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        if (error instanceof AuthSessionNotFoundError) {
          throw new ApiError(404, "AUTH_SESSION_NOT_FOUND", "Сессия не найдена или уже завершена");
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/auth/password",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        body: authPasswordChangeSchema,
        response: {
          200: apiEnvelopeSchema(authPasswordChangedSchema),
          403: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const context = requireContext(request);
      const user = await authRepository.findUserForLogin(context.user.email);
      if (!user || !(await verify(user.passwordHash, request.body.currentPassword))) {
        throw new ApiError(403, "AUTH_CURRENT_PASSWORD_INVALID", "Текущий пароль указан неверно");
      }
      try {
        const result = await authRepository.changePassword({
          userId: context.user.id,
          currentSessionId: context.sessionId,
          workspaceId: context.workspace.id,
          expectedPasswordHash: user.passwordHash,
          passwordHash: await hash(request.body.newPassword, { type: argon2id }),
          requestId: request.id,
        });
        return {
          data: { changed: true as const, revokedSessions: result.revokedSessions },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        if (error instanceof AuthPasswordConflictError) {
          throw new ApiError(
            409,
            "AUTH_PASSWORD_CONFLICT",
            "Пароль уже изменился. Обновите страницу и повторите вход",
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/auth/recovery/:token",
    {
      schema: {
        params: authRecoveryTokenParamsSchema,
        response: {
          200: apiEnvelopeSchema(authRecoveryDetailsSchema),
          404: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const recovery = await authRepository.findPasswordRecovery(
        hashSessionToken(request.params.token),
      );
      if (!recovery || recovery.user.disabledAt) {
        throw new ApiError(404, "AUTH_RECOVERY_INVALID", "Ссылка недействительна или истекла");
      }
      return {
        data: {
          emailHint: maskEmail(recovery.user.email),
          expiresAt: recovery.expiresAt.toISOString(),
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/auth/recovery/:token",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        params: authRecoveryTokenParamsSchema,
        body: authPasswordRecoverySchema,
        response: {
          200: apiEnvelopeSchema(authPasswordRecoveredSchema),
          404: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await authRepository.recoverPassword({
          tokenHash: hashSessionToken(request.params.token),
          passwordHash: await hash(request.body.newPassword, { type: argon2id }),
          requestId: request.id,
        });
      } catch (error) {
        if (error instanceof AuthRecoveryInvalidError) {
          throw new ApiError(404, "AUTH_RECOVERY_INVALID", "Ссылка недействительна или истекла");
        }
        throw error;
      }
      reply.clearCookie(sessionCookieName, sessionCookieOptions(config));
      return { data: { recovered: true as const }, meta: createMeta(request.id, "fresh") };
    },
  );

  app.post(
    "/api/v1/auth/workspace",
    {
      schema: {
        body: workspaceSwitchSchema,
        response: {
          200: apiEnvelopeSchema(authSessionSchema),
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const context = requireContext(request);
      try {
        await authRepository.switchWorkspace({
          sessionId: context.sessionId,
          userId: context.user.id,
          workspaceId: request.body.workspaceId,
          requestId: request.id,
        });
      } catch (error) {
        if (error instanceof AuthWorkspaceAccessDeniedError) {
          throw new ApiError(403, "WORKSPACE_ACCESS_DENIED", "Нет доступа к workspace");
        }
        throw error;
      }
      const refreshed = await resolveSession(request);
      if (!refreshed) throw new ApiError(401, "AUTH_REQUIRED", "Необходим вход в систему");
      requestContexts.set(request, refreshed);
      return { data: serializeAuthSession(refreshed), meta: createMeta(request.id, "fresh") };
    },
  );

  app.post(
    "/api/v1/workspaces",
    {
      schema: {
        body: workspaceCreateSchema,
        response: {
          201: apiEnvelopeSchema(authSessionSchema),
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const context = requireContext(request);
      try {
        await authRepository.createWorkspace({
          sessionId: context.sessionId,
          userId: context.user.id,
          name: request.body.name,
          slug: createWorkspaceSlug(request.body.name),
          requestId: request.id,
        });
      } catch (error) {
        if (error instanceof AuthWorkspaceLimitReachedError) {
          throw new ApiError(409, "WORKSPACE_LIMIT_REACHED", "Достигнут лимит рабочих пространств");
        }
        throw error;
      }
      const refreshed = await resolveSession(request);
      if (!refreshed) throw new ApiError(401, "AUTH_REQUIRED", "Необходим вход в систему");
      requestContexts.set(request, refreshed);
      return reply
        .status(201)
        .send({ data: serializeAuthSession(refreshed), meta: createMeta(request.id, "fresh") });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspaceId/access",
    {
      schema: {
        params: workspaceIdParamsSchema,
        response: { 200: apiEnvelopeSchema(workspaceAccessSchema), 403: errorEnvelopeSchema },
      },
    },
    async (request) => {
      const context = requireActiveWorkspace(request, request.params.workspaceId);
      const access = await authRepository.getWorkspaceAccess(context.workspace.id);
      return {
        data: {
          members: access.members.map((membership) => ({
            id: membership.user.id,
            email: membership.user.email,
            displayName: membership.user.displayName,
            role: serializeWorkspaceRole(membership.role),
            disabled: Boolean(membership.user.disabledAt),
            joinedAt: membership.createdAt.toISOString(),
          })),
          invitations: access.invitations.map(serializeInvitation),
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/invitations",
    {
      schema: {
        params: workspaceIdParamsSchema,
        body: workspaceInvitationCreateSchema,
        response: {
          201: apiEnvelopeSchema(workspaceInvitationCreatedSchema),
          403: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const context = requireWorkspaceOwner(request, request.params.workspaceId);
      const rawToken = randomBytes(32).toString("base64url");
      try {
        const invitation = await authRepository.createInvitation({
          workspaceId: context.workspace.id,
          email: request.body.email.trim().toLowerCase(),
          role: persistedWorkspaceRole(request.body.role),
          tokenHash: hashSessionToken(rawToken),
          invitedByUserId: context.user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
          requestId: request.id,
        });
        return reply.status(201).send({
          data: { invitation: serializeInvitation(invitation), token: rawToken },
          meta: createMeta(request.id, "fresh"),
        });
      } catch (error) {
        if (error instanceof AuthInvitationMembershipExistsError) {
          throw new ApiError(409, "MEMBERSHIP_EXISTS", "Пользователь уже состоит в workspace");
        }
        throw error;
      }
    },
  );

  app.delete(
    "/api/v1/workspaces/:workspaceId/invitations/:invitationId",
    {
      schema: {
        params: workspaceInvitationParamsSchema,
        response: {
          200: apiEnvelopeSchema(mutationAcceptedSchema),
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const context = requireWorkspaceOwner(request, request.params.workspaceId);
      try {
        await authRepository.revokeInvitation({
          workspaceId: context.workspace.id,
          invitationId: request.params.invitationId,
          actorId: context.actorId,
          requestId: request.id,
        });
      } catch (error) {
        if (error instanceof AuthInvitationInvalidError) {
          throw new ApiError(404, "INVITATION_NOT_FOUND", "Приглашение не найдено");
        }
        throw error;
      }
      return { data: { accepted: true as const }, meta: createMeta(request.id, "fresh") };
    },
  );

  app.patch(
    "/api/v1/workspaces/:workspaceId/members/:userId",
    {
      schema: {
        params: workspaceMemberParamsSchema,
        body: workspaceMemberRoleUpdateSchema,
        response: {
          200: apiEnvelopeSchema(mutationAcceptedSchema),
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const context = requireWorkspaceOwner(request, request.params.workspaceId);
      try {
        await authRepository.updateMemberRole({
          workspaceId: context.workspace.id,
          userId: request.params.userId,
          role: persistedWorkspaceRole(request.body.role),
          actorId: context.actorId,
          requestId: request.id,
        });
      } catch (error) {
        throwMemberApiError(error);
      }
      return { data: { accepted: true as const }, meta: createMeta(request.id, "fresh") };
    },
  );

  app.delete(
    "/api/v1/workspaces/:workspaceId/members/:userId",
    {
      schema: {
        params: workspaceMemberParamsSchema,
        response: {
          200: apiEnvelopeSchema(mutationAcceptedSchema),
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const context = requireWorkspaceOwner(request, request.params.workspaceId);
      if (context.user.id === request.params.userId) {
        throw new ApiError(
          409,
          "MEMBER_SELF_REMOVE_BLOCKED",
          "Нельзя удалить себя из текущего workspace",
        );
      }
      try {
        await authRepository.removeMember({
          workspaceId: context.workspace.id,
          userId: request.params.userId,
          actorId: context.actorId,
          requestId: request.id,
        });
      } catch (error) {
        throwMemberApiError(error);
      }
      return { data: { accepted: true as const }, meta: createMeta(request.id, "fresh") };
    },
  );

  app.get(
    "/api/v1/invitations/:token",
    {
      schema: {
        params: invitationTokenParamsSchema,
        response: { 200: apiEnvelopeSchema(invitationDetailsSchema), 404: errorEnvelopeSchema },
      },
    },
    async (request) => {
      const invitation = await authRepository.findPendingInvitation(
        hashSessionToken(request.params.token),
      );
      if (!invitation)
        throw new ApiError(404, "INVITATION_INVALID", "Приглашение недействительно или истекло");
      const existingUser = await authRepository.findUserForLogin(invitation.email);
      return {
        data: {
          email: invitation.email,
          role: serializeWorkspaceRole(invitation.role),
          workspace: invitation.workspace,
          expiresAt: invitation.expiresAt.toISOString(),
          existingUser: Boolean(existingUser),
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/invitations/:token/accept",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        params: invitationTokenParamsSchema,
        body: invitationAcceptSchema,
        response: {
          200: apiEnvelopeSchema(authSessionSchema),
          400: errorEnvelopeSchema,
          401: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const invitationTokenHash = hashSessionToken(request.params.token);
      const invitation = await authRepository.findPendingInvitation(invitationTokenHash);
      if (!invitation)
        throw new ApiError(404, "INVITATION_INVALID", "Приглашение недействительно или истекло");

      const existingUser = await authRepository.findUserForLogin(invitation.email);
      if (existingUser) {
        const passwordMatches = await verify(existingUser.passwordHash, request.body.password);
        if (!passwordMatches || existingUser.disabledAt) {
          throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "Неверный пароль");
        }
      } else if (!request.body.displayName) {
        throw new ApiError(400, "DISPLAY_NAME_REQUIRED", "Укажите имя нового пользователя");
      }

      const rawSessionToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + config.AUTH_SESSION_TTL_HOURS * 60 * 60_000);
      try {
        await authRepository.acceptInvitation({
          invitationId: invitation.id,
          tokenHash: invitationTokenHash,
          existingUserId: existingUser?.id ?? null,
          newUser: existingUser
            ? null
            : {
                email: invitation.email,
                displayName: request.body.displayName!,
                passwordHash: await hash(request.body.password, { type: argon2id }),
              },
          sessionTokenHash: hashSessionToken(rawSessionToken),
          sessionExpiresAt: expiresAt,
          userAgent: normalizeHeader(request.headers["user-agent"]),
          ipAddress: request.ip,
          requestId: request.id,
          maxActiveSessions: config.AUTH_MAX_ACTIVE_SESSIONS,
          expectedPasswordHash: existingUser?.passwordHash ?? null,
        });
      } catch (error) {
        if (error instanceof AuthInvitationInvalidError) {
          throw new ApiError(404, "INVITATION_INVALID", "Приглашение недействительно или истекло");
        }
        if (error instanceof AuthPasswordConflictError) {
          throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "Пароль изменился. Повторите вход");
        }
        throw error;
      }
      reply.setCookie(sessionCookieName, rawSessionToken, sessionCookieOptions(config));
      const context = await resolveSessionToken(rawSessionToken);
      if (!context) throw new ApiError(500, "AUTH_SESSION_FAILED", "Не удалось создать сессию");
      return { data: serializeAuthSession(context), meta: createMeta(request.id, "fresh") };
    },
  );

  app.get(
    "/api/v1/context",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(requestContextSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const context = requireContext(request);

      return {
        data: {
          actorId: context.actorId,
          workspaceId: context.workspace.id,
          workspaceName: workspace.name,
          role: context.workspace.role,
          environment: config.NODE_ENV,
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.get(
    "/api/v1/overview",
    {
      schema: {
        querystring: overviewQuerySchema,
        response: {
          200: apiEnvelopeSchema(overviewSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const period = request.query.period;
      const periodConfig = overviewPeriodConfig[period];
      const overview = await repository.getOverview(
        workspace.id,
        {
          startsAt: new Date(Date.now() - periodConfig.durationMs),
          bucketSeconds: periodConfig.bucketSeconds,
        },
        `${config.DRY_RUN_ACCOUNT_ID}:portfolio`,
      );
      const now = Date.now();
      const workerHealthy = overview.workerLastSeenAt
        ? now - overview.workerLastSeenAt.getTime() < 45_000
        : false;
      const accountFresh = overview.account
        ? now - overview.account.observedAt.getTime() < config.ACCOUNT_SNAPSHOT_INTERVAL_MS * 2
        : false;

      const alerts = [];
      if (!workerHealthy) {
        alerts.push({
          id: "worker-offline",
          severity: "critical" as const,
          title: "Worker не отвечает",
          description: "Нет свежего heartbeat. Торговые и фоновые задачи не выполняются.",
        });
      }
      if (!overview.account) {
        alerts.push({
          id: "account-data-unavailable",
          severity: "warning" as const,
          title: "Нет данных торгового счёта",
          description: "Worker ещё не записал account snapshot.",
        });
      } else if (!accountFresh) {
        alerts.push({
          id: "account-data-stale",
          severity: "warning" as const,
          title: "Данные торгового счёта устарели",
          description: "Последний account snapshot старше ожидаемого интервала обновления.",
        });
      }
      if (overview.runtimeHasFailures) {
        alerts.push({
          id: "runtime-cycle-failed",
          severity: "critical" as const,
          title: "Ошибка runtime-цикла",
          description: "Одна или несколько пар не обработаны. Проверьте Runtime control-plane.",
        });
      }

      const runtimeState = !workerHealthy
        ? ("offline" as const)
        : overview.runtimeHasFailures
          ? ("error" as const)
          : overview.runtimeDeploymentStatus === "RUNNING"
            ? ("running" as const)
            : overview.runtimeDeploymentStatus === "PAUSED"
              ? ("paused" as const)
              : ("idle" as const);

      return {
        data: {
          period,
          runtimeState,
          tradingEnvironment: overview.account
            ? tradingEnvironment[overview.account.environment]
            : ("dry-run" as const),
          account: overview.account
            ? {
                exchangeAccountId: overview.account.exchangeAccountId,
                environment: tradingEnvironment[overview.account.environment],
                equity: overview.account.equity,
                availableBalance: overview.account.availableBalance,
                observedAt: overview.account.observedAt.toISOString(),
              }
            : null,
          equitySeries: overview.equitySeries.map((point) => ({
            equity: point.equity,
            observedAt: point.observedAt.toISOString(),
          })),
          dayPnl: overview.dayPnl,
          totalPnl: overview.totalPnl,
          unrealizedPnl: overview.unrealizedPnl,
          openExposure: overview.openExposure,
          openPositions: overview.openPositions,
          activeStrategies: overview.activeStrategies,
          alerts,
        },
        meta: createMeta(
          request.id,
          !overview.account ? "unavailable" : accountFresh && workerHealthy ? "fresh" : "stale",
        ),
      };
    },
  );

  app.get(
    "/api/v1/activity",
    {
      schema: {
        querystring: activityQuerySchema,
        response: {
          200: apiEnvelopeSchema(activitySchema),
          400: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      try {
        const query = request.query;
        const activity = await activityRepository.list(workspace.id, {
          startsAt: getActivityStartsAt(query.period),
          action: query.action ? persistedDecisionAction[query.action] : null,
          strategyId: query.strategyId ?? null,
          symbol: query.symbol ?? null,
          reasonCode: query.reasonCode ?? null,
          cursor: query.cursor ?? null,
          limit: query.limit,
        });

        return {
          data: {
            filters: {
              period: query.period,
              action: query.action ?? null,
              strategyId: query.strategyId ?? null,
              symbol: query.symbol ?? null,
              reasonCode: query.reasonCode ?? null,
            },
            filterOptions: {
              strategies: activity.options.strategies,
              symbols: activity.options.symbols,
              reasonCodes: activity.options.reasonCodes,
              actions: activity.options.actions.map((action) => decisionAction[action]),
            },
            summary: {
              total: activity.total,
              open: activity.counts.get("OPEN") ?? 0,
              close: activity.counts.get("CLOSE") ?? 0,
              hold: activity.counts.get("HOLD") ?? 0,
              skip: activity.counts.get("SKIP") ?? 0,
              error: activity.counts.get("ERROR") ?? 0,
            },
            items: activity.items.map((item) => ({
              id: item.id,
              symbol: item.symbol,
              action: decisionAction[item.action],
              reasonCode: item.reasonCode,
              summary: item.summary,
              factors: readJsonObject(item.factors),
              marketSnapshotRef: item.marketSnapshotRef,
              correlationId: item.correlationId,
              decidedAt: item.decidedAt.toISOString(),
              strategy: {
                id: item.strategyVersion.strategy.id,
                name: item.strategyVersion.strategy.name,
                versionId: item.strategyVersion.id,
                version: item.strategyVersion.version,
              },
              execution: {
                runId: item.executionRun.id,
                deploymentId: item.executionRun.deploymentId,
                environment: tradingEnvironment[item.executionRun.environment],
                status: runStatus[item.executionRun.status],
              },
              links: { positionId: item.positionId, tradeId: item.tradeId },
            })),
            nextCursor: activity.nextCursor,
          },
          meta: createMeta(request.id, activity.total > 0 ? "fresh" : "unavailable"),
        };
      } catch (error) {
        if (error instanceof ActivityCursorNotFoundError) {
          throw new ApiError(400, "ACTIVITY_CURSOR_INVALID", "Cursor ленты недействителен");
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/journal",
    {
      schema: {
        querystring: journalQuerySchema,
        response: {
          200: apiEnvelopeSchema(journalSchema),
          400: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      try {
        const query = request.query;
        const journal = await journalRepository.list(workspace.id, {
          startsAt: getAnalyticsStartsAt(query.period),
          kind: query.kind ? persistedJournalKind[query.kind] : null,
          strategyId: query.strategyId ?? null,
          symbol: query.symbol ?? null,
          tag: query.tag?.toLocaleLowerCase() ?? null,
          cursor: query.cursor ?? null,
          limit: query.limit,
        });
        return {
          data: {
            filters: {
              period: query.period,
              kind: query.kind ?? null,
              strategyId: query.strategyId ?? null,
              symbol: query.symbol ?? null,
              tag: query.tag ?? null,
            },
            filterOptions: {
              ...journal.filterMetadata,
              kinds: [
                "hypothesis" as const,
                "observation" as const,
                "conclusion" as const,
                "decision" as const,
              ],
            },
            linkOptions: {
              strategies: journal.linkOptions.strategies.map((item) => ({
                id: item.id,
                label: item.name,
              })),
              strategyVersions: journal.linkOptions.versions.map((item) => ({
                id: item.id,
                label: `${item.strategy.name} · v${item.version}`,
              })),
              executionRuns: journal.linkOptions.executionRuns.map((item) => ({
                id: item.id,
                label: `${item.strategyVersion.strategy.name} · v${item.strategyVersion.version} · ${item.id.slice(0, 8)}`,
              })),
              validationRuns: journal.linkOptions.validationRuns.map((item) => ({
                id: item.id,
                label: `${item.strategy.name} · v${item.strategyVersion.version} · ${validationKind[item.kind]}`,
              })),
              trades: journal.linkOptions.trades.map((item) => ({
                id: item.id,
                label: `${item.symbol} · ${item.closedAt.toISOString().slice(0, 10)}`,
              })),
              decisions: journal.linkOptions.decisions.map((item) => ({
                id: item.id,
                label: `${item.symbol} · ${decisionAction[item.action]} · ${item.decidedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
              })),
              symbols: journal.linkOptions.symbols.map((item) => ({
                id: item.symbol,
                label: item.symbol,
              })),
            },
            summary: {
              total: journal.total,
              hypothesis: journal.counts.get("HYPOTHESIS") ?? 0,
              observation: journal.counts.get("OBSERVATION") ?? 0,
              conclusion: journal.counts.get("CONCLUSION") ?? 0,
              decision: journal.counts.get("DECISION") ?? 0,
              reviews: journal.reviewCount,
            },
            entries: journal.entries.map(serializeJournalEntry),
            reviews: journal.reviews.map(serializeReviewSession),
            nextCursor: journal.nextCursor,
          },
          meta: createMeta(
            request.id,
            journal.total > 0 || journal.reviewCount > 0 ? "fresh" : "unavailable",
          ),
        };
      } catch (error) {
        if (error instanceof JournalCursorNotFoundError) {
          throw new ApiError(400, "JOURNAL_CURSOR_INVALID", "Cursor журнала недействителен");
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/journal/entries",
    {
      schema: {
        body: journalEntryCreateSchema,
        response: {
          200: apiEnvelopeSchema(journalEntryCreatedSchema),
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      try {
        const entry = await journalRepository.createEntry({
          workspaceId: workspace.id,
          actorId: requireContext(request).actorId,
          requestId: request.id,
          kind: persistedJournalKind[request.body.kind],
          title: request.body.title,
          body: request.body.body,
          tags: request.body.tags,
          occurredAt: request.body.occurredAt ? new Date(request.body.occurredAt) : new Date(),
          links: request.body.links.map((link) => ({
            type: persistedJournalLinkType[link.type],
            targetId: link.targetId,
          })),
        });
        return {
          data: { entry: serializeJournalEntry(entry) },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        if (error instanceof JournalTargetNotFoundError) {
          throw new ApiError(
            404,
            "JOURNAL_TARGET_NOT_FOUND",
            "Связанный объект не найден в текущем workspace",
          );
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/journal/reviews",
    {
      schema: {
        body: reviewSessionCreateSchema,
        response: {
          200: apiEnvelopeSchema(reviewSessionCreatedSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const review = await journalRepository.createReview({
        workspaceId: workspace.id,
        actorId: requireContext(request).actorId,
        requestId: request.id,
        title: request.body.title,
        startsAt: new Date(request.body.startsAt),
        endsAt: new Date(request.body.endsAt),
        summary: request.body.summary,
        learnings: request.body.learnings,
        nextActions: request.body.nextActions,
        tags: request.body.tags,
      });
      return {
        data: { review: serializeReviewSession(review) },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.get(
    "/api/v1/playbooks",
    {
      schema: {
        querystring: playbookQuerySchema,
        response: {
          200: apiEnvelopeSchema(playbooksSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = request.query;
      const library = await playbookRepository.list(workspace.id, {
        status: query.status ? persistedPlaybookStatus[query.status] : null,
        strategyId: query.strategyId ?? null,
        tag: query.tag?.toLocaleLowerCase() ?? null,
        query: query.query ?? null,
      });
      const active = library.counts.get("ACTIVE") ?? 0;
      const archived = library.counts.get("ARCHIVED") ?? 0;
      return {
        data: {
          filters: {
            status: query.status ?? null,
            strategyId: query.strategyId ?? null,
            tag: query.tag ?? null,
            query: query.query ?? null,
          },
          filterOptions: {
            statuses: ["active" as const, "archived" as const],
            strategies: library.strategies,
            tags: library.tags,
          },
          linkOptions: {
            strategies: library.strategies.map((strategy) => ({
              id: strategy.id,
              label: strategy.name,
            })),
            trades: library.trades.map((trade) => ({
              id: trade.id,
              label: `${trade.symbol} · ${orderSide[trade.side]} · ${trade.closedAt.toISOString().slice(0, 10)} · ${trade.netPnl.toFixed()} USDT`,
            })),
          },
          summary: {
            total: active + archived,
            active,
            archived,
            linkedStrategies: library.strategyLinks,
            exampleTrades: library.tradeLinks,
          },
          items: library.items.map(serializePlaybook),
        },
        meta: createMeta(request.id, active + archived > 0 ? "fresh" : "unavailable"),
      };
    },
  );

  app.post(
    "/api/v1/playbooks",
    {
      schema: {
        body: playbookCreateSchema,
        response: {
          201: apiEnvelopeSchema(playbookMutationSchema),
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      try {
        const playbook = await playbookRepository.create({
          ...request.body,
          workspaceId: workspace.id,
          actorId: requireContext(request).actorId,
          requestId: request.id,
        });
        return reply.status(201).send({
          data: { playbook: serializePlaybook(playbook) },
          meta: createMeta(request.id, "fresh"),
        });
      } catch (error) {
        throwPlaybookApiError(error);
      }
    },
  );

  app.put(
    "/api/v1/playbooks/:playbookId",
    {
      schema: {
        params: playbookIdParamsSchema,
        body: playbookUpdateSchema,
        response: {
          200: apiEnvelopeSchema(playbookMutationSchema),
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      try {
        const playbook = await playbookRepository.update({
          ...request.body,
          expectedUpdatedAt: new Date(request.body.expectedUpdatedAt),
          playbookId: request.params.playbookId,
          workspaceId: workspace.id,
          actorId: requireContext(request).actorId,
          requestId: request.id,
        });
        return {
          data: { playbook: serializePlaybook(playbook) },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        throwPlaybookApiError(error);
      }
    },
  );

  app.post(
    "/api/v1/playbooks/:playbookId/status",
    {
      schema: {
        params: playbookIdParamsSchema,
        body: playbookStatusChangeSchema,
        response: {
          200: apiEnvelopeSchema(playbookMutationSchema),
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      try {
        const playbook = await playbookRepository.changeStatus({
          workspaceId: workspace.id,
          actorId: requireContext(request).actorId,
          requestId: request.id,
          playbookId: request.params.playbookId,
          expectedStatus: persistedPlaybookStatus[request.body.expectedStatus],
          status: persistedPlaybookStatus[request.body.status],
          reason: request.body.reason,
        });
        return {
          data: { playbook: serializePlaybook(playbook) },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        throwPlaybookApiError(error);
      }
    },
  );

  app.get(
    "/api/v1/exchange-connections",
    {
      schema: {
        response: { 200: apiEnvelopeSchema(exchangeConnectionsSchema) },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const connections = await exchangeConnectionRepository.list(workspace.id);
      return {
        data: { items: connections.map(serializeExchangeConnection) },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/exchange-connections",
    {
      schema: {
        body: exchangeConnectionCreateSchema,
        response: {
          201: apiEnvelopeSchema(exchangeConnectionCreatedSchema),
          403: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const context = requireWorkspaceOwner(request, workspace.id);
      const label = request.body.label.trim();
      const environment = persistedExchangeEnvironment[request.body.environment];
      const credentialContext = exchangeCredentialContext({
        workspaceId: workspace.id,
        exchange: request.body.exchange,
        environment,
        label,
      });
      const connection = await exchangeConnectionRepository.create({
        workspaceId: workspace.id,
        actorId: context.actorId,
        requestId: request.id,
        exchange: request.body.exchange,
        label,
        environment,
        encryptedApiKey: credentialCipher.encrypt(request.body.apiKey.trim(), credentialContext),
        encryptedApiSecret: credentialCipher.encrypt(
          request.body.apiSecret.trim(),
          credentialContext,
        ),
        apiKeyHint: maskApiKey(request.body.apiKey.trim()),
      });
      return reply.status(201).send({
        data: { connection: serializeExchangeConnection(connection) },
        meta: createMeta(request.id, "fresh"),
      });
    },
  );

  app.put(
    "/api/v1/exchange-connections/:connectionId/credentials",
    {
      schema: {
        params: exchangeConnectionParamsSchema,
        body: exchangeConnectionCredentialsSchema,
        response: {
          200: apiEnvelopeSchema(exchangeConnectionCreatedSchema),
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const context = requireWorkspaceOwner(request, workspace.id);
      const current = await exchangeConnectionRepository.find(
        workspace.id,
        request.params.connectionId,
      );
      if (!current) {
        throw new ApiError(404, "EXCHANGE_CONNECTION_NOT_FOUND", "Подключение не найдено");
      }
      const credentialContext = exchangeCredentialContext({
        workspaceId: workspace.id,
        exchange: current.exchange,
        environment: current.environment,
        label: current.label,
      });
      try {
        const connection = await exchangeConnectionRepository.rotateCredentials({
          workspaceId: workspace.id,
          connectionId: current.id,
          actorId: context.actorId,
          requestId: request.id,
          encryptedApiKey: credentialCipher.encrypt(request.body.apiKey.trim(), credentialContext),
          encryptedApiSecret: credentialCipher.encrypt(
            request.body.apiSecret.trim(),
            credentialContext,
          ),
          apiKeyHint: maskApiKey(request.body.apiKey.trim()),
        });
        return {
          data: { connection: serializeExchangeConnection(connection) },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        throwExchangeConnectionApiError(error);
      }
    },
  );

  app.post(
    "/api/v1/exchange-connections/:connectionId/verify",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        params: exchangeConnectionParamsSchema,
        response: {
          200: apiEnvelopeSchema(exchangeConnectionCreatedSchema),
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const context = requireWorkspaceOwner(request, workspace.id);
      const connection = await exchangeConnectionRepository.findWithCredentials(
        workspace.id,
        request.params.connectionId,
      );
      if (!connection || !connection.encryptedApiKey || !connection.encryptedApiSecret) {
        throw new ApiError(404, "EXCHANGE_CONNECTION_NOT_FOUND", "Подключение не найдено");
      }
      const credentialContext = exchangeCredentialContext({
        workspaceId: workspace.id,
        exchange: connection.exchange,
        environment: connection.environment,
        label: connection.label,
      });
      let apiKey: string;
      let apiSecret: string;
      try {
        apiKey = credentialCipher.decrypt(connection.encryptedApiKey, credentialContext);
        apiSecret = credentialCipher.decrypt(connection.encryptedApiSecret, credentialContext);
      } catch {
        throw new ApiError(
          503,
          "EXCHANGE_CREDENTIALS_UNREADABLE",
          "Credentials не удалось расшифровать. Замените ключи подключения",
        );
      }

      const verifiedAt = new Date();
      try {
        if (connection.environment === "DRY_RUN") {
          throw new Error("DRY_RUN exchange connection violates the database invariant");
        }
        const privateClient = bybitPrivateClients[connection.environment];
        const information = await privateClient.getApiKeyInformation(
          apiKey,
          apiSecret,
          AbortSignal.timeout(config.BYBIT_PRIVATE_REQUEST_TIMEOUT_MS),
        );
        const { tradingPermission, withdrawalPermission } = evaluateBybitPermissions(
          information.permissions,
        );
        const persisted = await exchangeConnectionRepository.recordVerification({
          workspaceId: workspace.id,
          connectionId: connection.id,
          actorId: context.actorId,
          requestId: request.id,
          status: withdrawalPermission ? "INVALID" : "ACTIVE",
          code: withdrawalPermission ? "WITHDRAW_PERMISSION_NOT_ALLOWED" : "VERIFIED",
          message: withdrawalPermission
            ? "Отключите разрешение Withdraw у API-ключа"
            : information.readOnly
              ? "Ключ действителен и работает только на чтение"
              : tradingPermission
                ? "Ключ действителен; торговые разрешения доступны"
                : "Ключ действителен; торговые разрешения отсутствуют",
          readOnly: information.readOnly,
          tradingPermission,
          ipBound: information.ipBound,
          accountUid: information.accountUid,
          permissions: information.permissions,
          verifiedAt,
          nextVerificationAt: withdrawalPermission
            ? null
            : addHours(verifiedAt, config.EXCHANGE_VERIFICATION_INTERVAL_HOURS),
          expectedCredentialRevision: connection.credentialRevision,
        });
        return {
          data: { connection: serializeExchangeConnection(persisted) },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        if (error instanceof BybitCredentialsRejectedError) {
          try {
            const persisted = await exchangeConnectionRepository.recordVerification({
              workspaceId: workspace.id,
              connectionId: connection.id,
              actorId: context.actorId,
              requestId: request.id,
              status: "INVALID",
              code: `BYBIT_${error.code}`,
              message: describeBybitCredentialRejection(error.code),
              readOnly: null,
              tradingPermission: null,
              ipBound: null,
              accountUid: null,
              permissions: null,
              verifiedAt,
              nextVerificationAt: null,
              expectedCredentialRevision: connection.credentialRevision,
            });
            return {
              data: { connection: serializeExchangeConnection(persisted) },
              meta: createMeta(request.id, "fresh"),
            };
          } catch (persistenceError) {
            throwExchangeConnectionApiError(persistenceError);
          }
        }
        if (error instanceof BybitPrivateApiUnavailableError) {
          try {
            await exchangeConnectionRepository.recordVerificationUnavailable({
              workspaceId: workspace.id,
              connectionId: connection.id,
              expectedCredentialRevision: connection.credentialRevision,
              attemptedAt: verifiedAt,
              nextVerificationAt: addMinutes(
                verifiedAt,
                config.EXCHANGE_VERIFICATION_RETRY_MINUTES,
              ),
              code: "BYBIT_UNAVAILABLE",
              message: "Bybit временно не подтвердил подключение; запланирована повторная проверка",
            });
          } catch (persistenceError) {
            throwExchangeConnectionApiError(persistenceError);
          }
          throw new ApiError(
            503,
            "EXCHANGE_VERIFICATION_UNAVAILABLE",
            "Bybit сейчас не подтвердил подключение. Повторите проверку позже",
          );
        }
        throwExchangeConnectionApiError(error);
      }
    },
  );

  app.delete(
    "/api/v1/exchange-connections/:connectionId",
    {
      schema: {
        params: exchangeConnectionParamsSchema,
        response: {
          200: apiEnvelopeSchema(mutationAcceptedSchema),
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const context = requireWorkspaceOwner(request, workspace.id);
      try {
        await exchangeConnectionRepository.revoke({
          workspaceId: workspace.id,
          connectionId: request.params.connectionId,
          actorId: context.actorId,
          requestId: request.id,
        });
      } catch (error) {
        throwExchangeConnectionApiError(error);
      }
      return { data: { accepted: true as const }, meta: createMeta(request.id, "fresh") };
    },
  );

  app.get(
    "/api/v1/settings",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(settingsSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const [preferences, databaseConnected, exchangeConnections] = await Promise.all([
        settingsRepository.get(workspace.id),
        repository.ping(),
        exchangeConnectionRepository.list(workspace.id),
      ]);
      return {
        data: {
          preferences: serializeWorkspacePreferences(preferences),
          runtimeSafety: {
            environment: config.NODE_ENV,
            tradingEnvironment: "dry-run" as const,
            confirmationsRequired: true as const,
            liveTradingEnabled: false as const,
            maxActiveDeployments: 1 as const,
          },
          marketData: {
            provider: "Bybit public API" as const,
            marketPollIntervalMs: config.MARKET_POLL_INTERVAL_MS,
            candlePollIntervalMs: config.CANDLE_POLL_INTERVAL_MS,
            accountSnapshotIntervalMs: config.ACCOUNT_SNAPSHOT_INTERVAL_MS,
          },
          exchange: {
            publicConnectionConfigured: Boolean(config.BYBIT_PUBLIC_BASE_URL),
            privateConnectionConfigured: exchangeConnections.length > 0,
            accountId: config.DRY_RUN_ACCOUNT_ID,
          },
          notifications: {
            configured: false as const,
            reason:
              "Канал доставки будет добавлен после авторизации и разделения рабочих пространств.",
          },
          retention: {
            automaticCleanupEnabled: false as const,
            exportFormat: "json" as const,
            exportIncludes: [
              "настройки рабочего пространства",
              "стратегии и версии",
              "закрытые сделки",
              "журнал и разборы периода",
              "плейбуки и связи",
            ],
            exportExcludes: ["рыночные свечи", "системные логи", "секреты"],
          },
          system: {
            applicationVersion,
            workspaceId: workspace.id,
            actorId: requireContext(request).actorId,
            database: databaseConnected ? ("connected" as const) : ("unavailable" as const),
          },
        },
        meta: createMeta(request.id, databaseConnected ? "fresh" : "stale"),
      };
    },
  );

  app.put(
    "/api/v1/settings/preferences",
    {
      schema: {
        body: settingsUpdateSchema,
        response: {
          200: apiEnvelopeSchema(settingsMutationSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      try {
        const preferences = await settingsRepository.update({
          workspaceId: workspace.id,
          actorId: requireContext(request).actorId,
          requestId: request.id,
          timezone: request.body.timezone,
          tableDensity: request.body.tableDensity,
          expectedUpdatedAt: new Date(request.body.expectedUpdatedAt),
        });
        return {
          data: { preferences: serializeWorkspacePreferences(preferences) },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        throwSettingsApiError(error);
      }
    },
  );

  app.get(
    "/api/v1/settings/export",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(settingsExportSchema),
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      try {
        const exportedAt = new Date();
        const payload = await settingsRepository.exportWorkspace({
          workspaceId: workspace.id,
          actorId: requireContext(request).actorId,
          requestId: request.id,
        });
        return {
          data: {
            filename: `cryptoanal-${workspace.id}-${exportedAt.toISOString().slice(0, 10)}.json`,
            mediaType: "application/json" as const,
            content: JSON.stringify(
              { schemaVersion: 1, exportedAt: exportedAt.toISOString(), workspace: payload },
              null,
              2,
            ),
          },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        throwSettingsApiError(error);
      }
    },
  );

  app.get(
    "/api/v1/system/logs",
    {
      schema: {
        querystring: systemLogsQuerySchema,
        response: {
          200: apiEnvelopeSchema(systemLogsSchema),
          400: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = request.query;
      try {
        const logs = await systemLogRepository.list(workspace.id, {
          startsAt: getSystemLogStartsAt(query.period),
          level: query.level ? persistedSystemLogLevel[query.level] : null,
          service: query.service ?? null,
          correlationId: query.correlationId ?? null,
          query: query.query ?? null,
          cursor: query.cursor ?? null,
          limit: query.limit,
        });
        return {
          data: {
            filters: {
              period: query.period,
              level: query.level ?? null,
              service: query.service ?? null,
              correlationId: query.correlationId ?? null,
              query: query.query ?? null,
            },
            filterOptions: {
              levels: [
                "debug" as const,
                "info" as const,
                "warning" as const,
                "error" as const,
                "critical" as const,
              ],
              services: logs.services,
            },
            summary: {
              total: logs.total,
              warnings: logs.counts.get("WARNING") ?? 0,
              errors: (logs.counts.get("ERROR") ?? 0) + (logs.counts.get("CRITICAL") ?? 0),
              services: logs.serviceCount,
            },
            items: logs.items.map((item) => ({
              id: item.id,
              level: systemLogLevel[item.level],
              service: item.service,
              event: item.event,
              message: item.message,
              correlationId: item.correlationId,
              metadata: item.metadata ? redactSystemLogMetadata(item.metadata) : null,
              createdAt: item.createdAt.toISOString(),
            })),
            nextCursor: logs.nextCursor,
          },
          meta: createMeta(request.id, logs.total > 0 ? "fresh" : "unavailable"),
        };
      } catch (error) {
        if (error instanceof SystemLogCursorNotFoundError) {
          throw new ApiError(400, "SYSTEM_LOG_CURSOR_INVALID", "Cursor логов недействителен");
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/health",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(healthDashboardSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const now = new Date();
      const [signals, persistedIncidents] = await Promise.all([
        healthRepository.getSignals(workspace.id, now),
        healthRepository.listIncidents(workspace.id),
      ]);
      const health = evaluateHealth({
        ...signals,
        now,
        initialCapital: config.DRY_RUN_INITIAL_BALANCE,
        thresholds: createHealthThresholds(config),
        driftCandidates: signals.driftCandidates.map((candidate) => ({
          ...candidate,
          environment: tradingEnvironment[candidate.environment],
        })),
      });
      const persistedByFingerprint = new Map(
        persistedIncidents.map((incident) => [incident.fingerprint, incident]),
      );
      const activeIncidents = health.conditions.map((condition) => {
        const persisted = persistedByFingerprint.get(condition.fingerprint);
        return persisted
          ? serializeWatchdogIncident({ ...persisted, status: "OPEN", resolvedAt: null })
          : {
              id: `current:${condition.fingerprint}`,
              fingerprint: condition.fingerprint,
              domain: condition.domain,
              code: condition.code,
              severity: condition.severity,
              status: "open" as const,
              title: condition.title,
              description: condition.description,
              resourceType: condition.resourceType,
              resourceId: condition.resourceId,
              occurrenceCount: 1,
              firstObservedAt: now.toISOString(),
              lastObservedAt: now.toISOString(),
              resolvedAt: null,
            };
      });
      const resolvedIncidents = persistedIncidents
        .filter((incident) => incident.status === "RESOLVED")
        .map(serializeWatchdogIncident);

      return {
        data: {
          overallStatus: health.overallStatus,
          checkedAt: now.toISOString(),
          watchdogLastSeenAt: signals.watchdogLastSeenAt?.toISOString() ?? null,
          domains: health.domains.map((domain) => ({
            ...domain,
            observedAt: domain.observedAt?.toISOString() ?? null,
          })),
          incidents: [...activeIncidents, ...resolvedIncidents].slice(0, 100),
          drift: health.drift,
          notices: health.notices,
        },
        meta: createMeta(
          request.id,
          health.overallStatus === "healthy"
            ? "fresh"
            : health.overallStatus === "degraded"
              ? "stale"
              : "unavailable",
        ),
      };
    },
  );

  app.get(
    "/api/v1/analytics",
    {
      schema: {
        querystring: analyticsQuerySchema,
        response: {
          200: apiEnvelopeSchema(analyticsSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const filters = request.query;
      const dataset = await analyticsRepository.getPerformanceDataset(workspace.id, {
        startsAt: getAnalyticsStartsAt(filters.period),
        environment: filters.environment ? analyticsTradingEnvironment[filters.environment] : null,
        strategyId: filters.strategyId ?? null,
        symbol: filters.symbol ?? null,
      });
      const analytics = buildPerformanceAnalytics(
        dataset.trades.map((trade) => ({
          ...trade,
          environment: tradingEnvironment[trade.environment],
        })),
        config.DRY_RUN_INITIAL_BALANCE,
      );

      return {
        data: {
          filters: {
            period: filters.period,
            environment: filters.environment ?? null,
            strategyId: filters.strategyId ?? null,
            symbol: filters.symbol ?? null,
          },
          filterOptions: {
            strategies: dataset.options.strategies,
            symbols: dataset.options.symbols,
            environments: dataset.options.environments.map(
              (environment) => tradingEnvironment[environment],
            ),
          },
          initialCapital: String(config.DRY_RUN_INITIAL_BALANCE),
          summary: {
            ...analytics.summary,
            grossPnl: String(analytics.summary.grossPnl),
            netPnl: String(analytics.summary.netPnl),
            totalFees: String(analytics.summary.totalFees),
            totalFunding: String(analytics.summary.totalFunding),
            totalSlippage: String(analytics.summary.totalSlippage),
            expectancy: String(analytics.summary.expectancy),
            averageWin: String(analytics.summary.averageWin),
            averageLoss: String(analytics.summary.averageLoss),
            bestTrade: String(analytics.summary.bestTrade),
            worstTrade: String(analytics.summary.worstTrade),
          },
          equitySeries: analytics.equitySeries.map((point) => ({
            ...point,
            observedAt: point.observedAt.toISOString(),
            equity: String(point.equity),
            cumulativeNetPnl: String(point.cumulativeNetPnl),
          })),
          dailyPnl: analytics.dailyPnl.map((day) => ({
            ...day,
            netPnl: String(day.netPnl),
          })),
          breakdowns: {
            strategies: serializeAnalyticsBreakdown(analytics.breakdowns.strategies),
            symbols: serializeAnalyticsBreakdown(analytics.breakdowns.symbols),
            exitReasons: serializeAnalyticsBreakdown(analytics.breakdowns.exitReasons),
            regimes: serializeAnalyticsBreakdown(analytics.breakdowns.regimes),
            sessions: serializeAnalyticsBreakdown(analytics.breakdowns.sessions),
          },
          distributions: {
            pnl: analytics.distributions.pnl.map((bucket) => ({
              ...bucket,
              from: String(bucket.from),
              to: String(bucket.to),
              netPnl: String(bucket.netPnl),
            })),
            holdingTime: analytics.distributions.holdingTime.map((bucket) => ({
              ...bucket,
              netPnl: String(bucket.netPnl),
            })),
          },
        },
        meta: createMeta(request.id, analytics.summary.trades > 0 ? "fresh" : "unavailable"),
      };
    },
  );

  app.get(
    "/api/v1/markets",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(marketsSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const instruments = await repository.listMarkets(workspace.id);
      const now = Date.now();
      const items = instruments.map((instrument) => {
        const snapshot = instrument.snapshots[0];
        const analysis = calculateMarketAnalysis(
          [...instrument.candles].reverse().map((candle) => ({
            open: candle.open.toNumber(),
            high: candle.high.toNumber(),
            low: candle.low.toNumber(),
            close: candle.close.toNumber(),
          })),
        );
        const freshness = !snapshot
          ? ("unavailable" as const)
          : now - snapshot.observedAt.getTime() < 60_000
            ? ("fresh" as const)
            : ("stale" as const);

        return {
          symbol: instrument.symbol,
          baseAsset: instrument.baseAsset,
          quoteAsset: instrument.quoteAsset,
          exchange: instrument.exchange,
          instrumentType: instrument.instrumentType,
          watchlisted: instrument.watchlistItems.length > 0,
          price: snapshot?.price.toFixed() ?? null,
          change24hPercent: snapshot?.change24hPercent?.toFixed() ?? null,
          volume24h: snapshot?.volume24h?.toFixed() ?? null,
          regime: analysis.regime,
          freshness,
        };
      });

      return {
        data: { items, total: items.length },
        meta: createMeta(
          request.id,
          items.some((item) => item.freshness === "fresh") ? "fresh" : "unavailable",
        ),
      };
    },
  );

  app.get(
    "/api/v1/strategies",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(strategyCatalogSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const strategies = await repository.listStrategies(workspace.id);
      const counts = Object.fromEntries(strategyStatuses.map((status) => [status, 0])) as Record<
        (typeof strategyStatuses)[number],
        number
      >;

      const items = strategies.map((strategy) => {
        const status = strategyStatus[strategy.status];
        counts[status] += 1;
        const latestVersion = strategy.versions[0] ?? null;
        const lastValidation = strategy.validationRuns[0] ?? null;
        const deployment = strategy.deployments[0] ?? null;

        return {
          id: strategy.id,
          name: strategy.name,
          description: strategy.description,
          status,
          versionsCount: strategy._count.versions,
          activeVersion: serializeStrategyVersion(strategy.activeVersion),
          latestVersion: serializeStrategyVersion(latestVersion),
          lastValidation: lastValidation
            ? {
                id: lastValidation.id,
                kind: validationKind[lastValidation.kind],
                status: runStatus[lastValidation.status],
                verdict: validationVerdict[lastValidation.verdict],
                strategyVersion: lastValidation.strategyVersion.version,
                completedAt: lastValidation.completedAt?.toISOString() ?? null,
              }
            : null,
          deployment: deployment
            ? {
                id: deployment.id,
                environment: tradingEnvironment[deployment.environment],
                status: deploymentStatus[deployment.status],
                strategyVersion: deployment.strategyVersion.version,
                updatedAt: deployment.updatedAt.toISOString(),
              }
            : null,
          updatedAt: strategy.updatedAt.toISOString(),
        };
      });

      return {
        data: { items, total: items.length, counts },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/strategies",
    {
      schema: {
        body: strategyCreateSchema,
        response: {
          201: apiEnvelopeSchema(strategyCreatedSchema),
          400: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const configHash = createHash("sha256")
        .update(JSON.stringify(request.body.config))
        .digest("hex");

      try {
        const result = await strategyRepository.createWithInitialVersion({
          workspaceId: workspace.id,
          actorId: requireContext(request).actorId,
          name: request.body.name,
          description: request.body.description,
          configSchemaVersion: request.body.config.schemaVersion,
          config: request.body.config,
          configHash,
        });

        return reply.status(201).send({
          data: {
            id: result.strategy.id,
            name: result.strategy.name,
            status: "draft",
            version: {
              ...result.version,
              createdAt: result.version.createdAt.toISOString(),
            },
          },
          meta: createMeta(request.id, "fresh"),
        });
      } catch (error) {
        if (error instanceof StrategyNameConflictError) {
          throw new ApiError(
            409,
            "STRATEGY_NAME_CONFLICT",
            "Стратегия с таким названием уже существует",
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/strategies/:strategyId",
    {
      schema: {
        params: strategyIdParamsSchema,
        response: {
          200: apiEnvelopeSchema(strategyDetailSchema),
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const strategy = await strategyRepository.getDetail(workspace.id, request.params.strategyId);
      if (!strategy) {
        throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
      }

      const latestVersion = strategy.versions[0] ?? null;
      const lastValidation = strategy.validationRuns[0] ?? null;
      const deployment = strategy.deployments[0] ?? null;

      return {
        data: {
          id: strategy.id,
          name: strategy.name,
          description: strategy.description,
          status: strategyStatus[strategy.status],
          versionsCount: strategy._count.versions,
          activeVersion: serializeStrategyVersion(strategy.activeVersion),
          latestVersion: serializeStrategyVersion(latestVersion),
          lastValidation: lastValidation
            ? {
                id: lastValidation.id,
                kind: validationKind[lastValidation.kind],
                status: runStatus[lastValidation.status],
                verdict: validationVerdict[lastValidation.verdict],
                strategyVersion: lastValidation.strategyVersion.version,
                completedAt: lastValidation.completedAt?.toISOString() ?? null,
              }
            : null,
          deployment: deployment
            ? {
                id: deployment.id,
                environment: tradingEnvironment[deployment.environment],
                status: deploymentStatus[deployment.status],
                strategyVersion: deployment.strategyVersion.version,
                updatedAt: deployment.updatedAt.toISOString(),
              }
            : null,
          updatedAt: strategy.updatedAt.toISOString(),
          lifecycle: createStrategyLifecycleProjection(strategy),
          versions: strategy.versions.map((version) => ({
            id: version.id,
            version: version.version,
            configSchemaVersion: version.configSchemaVersion,
            config: strategyConfigSchema.parse(version.config),
            configHash: version.configHash,
            changeSummary: version.changeSummary,
            createdByActorId: version.createdByActorId,
            createdAt: version.createdAt.toISOString(),
          })),
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/strategies/:strategyId/versions",
    {
      schema: {
        params: strategyIdParamsSchema,
        body: strategyVersionCreateSchema,
        response: {
          201: apiEnvelopeSchema(strategyVersionCreatedSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const configHash = createHash("sha256")
        .update(JSON.stringify(request.body.config))
        .digest("hex");

      try {
        const version = await strategyRepository.createVersion({
          workspaceId: workspace.id,
          strategyId: request.params.strategyId,
          actorId: requireContext(request).actorId,
          configSchemaVersion: request.body.config.schemaVersion,
          config: request.body.config,
          configHash,
          changeSummary: request.body.changeSummary,
        });

        return reply.status(201).send({
          data: {
            strategyId: request.params.strategyId,
            version: {
              ...version,
              createdAt: version.createdAt.toISOString(),
            },
          },
          meta: createMeta(request.id, "fresh"),
        });
      } catch (error) {
        if (error instanceof StrategyNotFoundError) {
          throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
        }
        if (error instanceof StrategyConfigUnchangedError) {
          throw new ApiError(
            409,
            "STRATEGY_CONFIG_UNCHANGED",
            "Конфигурация не отличается от последней версии",
          );
        }
        if (error instanceof StrategyVersionNotAllowedError) {
          throw new ApiError(
            409,
            "STRATEGY_VERSION_NOT_ALLOWED",
            "Новая версия доступна только для черновика или одобренной стратегии",
          );
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/strategies/:strategyId/status",
    {
      schema: {
        params: strategyIdParamsSchema,
        body: strategyStatusTransitionSchema,
        response: {
          200: apiEnvelopeSchema(strategyStatusChangedSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const strategy = await strategyRepository.getDetail(workspace.id, request.params.strategyId);
      if (!strategy) {
        throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
      }

      const currentStatus = strategyStatus[strategy.status];
      if (currentStatus !== request.body.expectedStatus) {
        throw new ApiError(
          409,
          "STRATEGY_STATUS_CONFLICT",
          "Статус стратегии уже изменился. Обновите страницу",
        );
      }
      if (!canTransitionStrategyStatus(currentStatus, request.body.target)) {
        throw new ApiError(409, "STRATEGY_TRANSITION_INVALID", "Недопустимый переход статуса");
      }

      const lifecycle = createStrategyLifecycleProjection(strategy);
      const transition = lifecycle.transitions.find(
        (candidate) => candidate.target === request.body.target,
      );
      if (!transition?.allowed) {
        throw new ApiError(
          409,
          "STRATEGY_TRANSITION_BLOCKED",
          transition?.reason ?? "Переход должен выполняться отдельной доменной командой",
        );
      }

      try {
        const changed = await strategyRepository.transitionStatus({
          workspaceId: workspace.id,
          strategyId: strategy.id,
          actorId: requireContext(request).actorId,
          requestId: request.id,
          expectedStatus: persistedStrategyStatus[request.body.expectedStatus],
          targetStatus: persistedManualStrategyStatus[request.body.target],
          reason: request.body.reason,
        });

        return {
          data: { strategyId: changed.id, status: strategyStatus[changed.status] },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        if (error instanceof StrategyNotFoundError) {
          throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
        }
        if (error instanceof StrategyStatusConflictError) {
          throw new ApiError(
            409,
            "STRATEGY_STATUS_CONFLICT",
            "Статус стратегии уже изменился. Обновите страницу",
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/validations",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(validationsSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const runs = await validationRepository.list(workspace.id);
      const counts = {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      };
      const items = runs.map((run) => {
        counts[runStatus[run.status]] += 1;
        return serializeValidationRun(run);
      });

      return {
        data: { items, total: items.length, counts },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.get(
    "/api/v1/validations/:validationRunId",
    {
      schema: {
        params: validationRunIdParamsSchema,
        querystring: validationRunDetailQuerySchema,
        response: {
          200: apiEnvelopeSchema(validationRunDetailSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const run = await validationRepository.get(
        workspace.id,
        request.params.validationRunId,
        request.query.tradePage,
        request.query.tradeLimit,
      );
      if (!run) {
        throw new ApiError(404, "VALIDATION_RUN_NOT_FOUND", "Запуск проверки не найден");
      }

      return {
        data: {
          run: serializeValidationRunDetail(run),
          trades: run.trades.map((trade) => ({
            symbol: trade.symbol,
            side: trade.side === "BUY" ? ("long" as const) : ("short" as const),
            openedAt: trade.openedAt.toISOString(),
            closedAt: trade.closedAt.toISOString(),
            entryPrice: Number(trade.entryPrice),
            exitPrice: Number(trade.exitPrice),
            quantity: Number(trade.quantity),
            netPnl: Number(trade.netPnl),
            fees: Number(trade.fees),
            exitReason: serializeValidationExitReason(trade.exitReason),
          })),
          tradesTotal: run._count.trades,
          tradePage: request.query.tradePage,
          tradeLimit: request.query.tradeLimit,
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/strategies/:strategyId/validations",
    {
      schema: {
        params: strategyIdParamsSchema,
        body: validationRunInputSchema,
        response: {
          202: apiEnvelopeSchema(validationRunQueuedSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const strategy = await strategyRepository.getDetail(workspace.id, request.params.strategyId);
      if (!strategy) {
        throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
      }
      const version = strategy.versions[0];
      if (!version || version.id !== request.body.strategyVersionId) {
        throw new ApiError(
          409,
          "VALIDATION_VERSION_MISMATCH",
          "Для проверки нужно выбрать последнюю версию стратегии",
        );
      }
      const versionConfig = strategyConfigSchema.parse(version.config);
      const requestedSymbolsAreCompatible = request.body.dataset.symbols.every((symbol) =>
        versionConfig.universe.symbols.includes(symbol),
      );
      if (
        request.body.dataset.timeframe !== versionConfig.universe.timeframe ||
        !requestedSymbolsAreCompatible
      ) {
        throw new ApiError(
          409,
          "VALIDATION_DATASET_INCOMPATIBLE",
          "Датасет должен использовать timeframe и пары из конфигурации стратегии",
        );
      }

      const { strategyVersionId, idempotencyKey, ...executionInput } = request.body;
      const datasetHash = createHash("sha256")
        .update(JSON.stringify(executionInput.dataset))
        .digest("hex");
      const datasetStartsAt = new Date(`${executionInput.dataset.startDate}T00:00:00.000Z`);
      const datasetEndDayStartsAt = new Date(`${executionInput.dataset.endDate}T00:00:00.000Z`);
      const datasetEndDayEndsAt = new Date(`${executionInput.dataset.endDate}T23:59:59.999Z`);
      const startOfCurrentUtcDay = new Date();
      startOfCurrentUtcDay.setUTCHours(0, 0, 0, 0);
      const reusableSnapshot =
        datasetEndDayEndsAt < startOfCurrentUtcDay
          ? await validationRepository.findHistoricalDatasetSnapshot({
              workspaceId: workspace.id,
              source: validationDatasetSource,
              exchange: "bybit",
              instrumentType: "linear-perpetual",
              timeframe: executionInput.dataset.timeframe,
              symbols: executionInput.dataset.symbols,
              startsAt: datasetStartsAt,
              endDayStartsAt: datasetEndDayStartsAt,
              endDayEndsAt: datasetEndDayEndsAt,
            })
          : null;

      try {
        const queued = await validationRepository.queue({
          workspaceId: workspace.id,
          strategyId: strategy.id,
          strategyVersionId,
          actorId: requireContext(request).actorId,
          requestId: request.id,
          kind: persistedValidationKind[executionInput.kind],
          datasetId: reusableSnapshot
            ? `dataset-snapshot:${reusableSnapshot.id}`
            : `market-candles-request:${datasetHash}`,
          datasetSnapshotId: reusableSnapshot?.id ?? null,
          datasetAsOf: reusableSnapshot?.endsAt ?? new Date(),
          engineVersion: validationEngineVersion,
          configHash: version.configHash,
          input: executionInput,
          idempotencyKey,
        });

        return reply.status(202).send({
          data: {
            run: serializeValidationRun(queued.run),
            job: {
              id: queued.job.id,
              status: runStatus[queued.job.status],
              replayed: queued.replayed,
            },
          },
          meta: createMeta(request.id, "fresh"),
        });
      } catch (error) {
        if (error instanceof ValidationStrategyNotFoundError) {
          throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
        }
        if (error instanceof ValidationVersionMismatchError) {
          throw new ApiError(
            409,
            "VALIDATION_VERSION_MISMATCH",
            "Для проверки нужно выбрать последнюю версию стратегии",
          );
        }
        if (error instanceof ValidationNotEligibleError) {
          throw new ApiError(
            409,
            "VALIDATION_NOT_ELIGIBLE",
            "Текущий статус стратегии не разрешает новую проверку",
          );
        }
        if (error instanceof ValidationAlreadyActiveError) {
          throw new ApiError(
            409,
            "VALIDATION_ALREADY_ACTIVE",
            "У стратегии уже есть активная проверка",
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/deployments",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(deploymentsSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const deployments = await deploymentRepository.list(workspace.id);
      const counts = Object.fromEntries(deploymentStatuses.map((status) => [status, 0])) as Record<
        (typeof deploymentStatuses)[number],
        number
      >;
      const items = deployments.map((deployment) => {
        const status = deploymentStatus[deployment.status];
        counts[status] += 1;
        return serializeDeployment(deployment);
      });

      return {
        data: { items, total: items.length, counts },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/strategies/:strategyId/deployments",
    {
      schema: {
        params: strategyIdParamsSchema,
        body: deploymentCreateSchema,
        response: {
          201: apiEnvelopeSchema(deploymentMutationResultSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      try {
        const result = await deploymentRepository.create({
          workspaceId: workspace.id,
          strategyId: request.params.strategyId,
          strategyVersionId: request.body.strategyVersionId,
          actorId: requireContext(request).actorId,
          requestId: request.id,
          idempotencyKey: request.body.idempotencyKey,
          exchangeConnectionId: request.body.exchangeConnectionId,
          exchangeAccountId: `${config.DRY_RUN_ACCOUNT_ID}:strategy:${request.params.strategyId}`,
        });

        return reply.status(201).send({
          data: {
            deployment: serializeDeployment(result.deployment),
            replayed: result.replayed,
          },
          meta: createMeta(request.id, "fresh"),
        });
      } catch (error) {
        throwDeploymentApiError(error);
      }
    },
  );

  app.post(
    "/api/v1/deployments/:deploymentId/commands",
    {
      schema: {
        params: deploymentIdParamsSchema,
        body: deploymentCommandInputSchema,
        response: {
          200: apiEnvelopeSchema(deploymentMutationResultSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      try {
        const result = await deploymentRepository.applyCommand({
          workspaceId: workspace.id,
          deploymentId: request.params.deploymentId,
          actorId: requireContext(request).actorId,
          requestId: request.id,
          idempotencyKey: request.body.idempotencyKey,
          command: persistedDeploymentCommand[request.body.command],
          expectedStatus: persistedDeploymentStatus[request.body.expectedStatus],
          reason: request.body.reason,
          engineVersion: executionEngineVersion,
        });

        return {
          data: {
            deployment: serializeDeployment(result.deployment),
            replayed: result.replayed,
          },
          meta: createMeta(request.id, "fresh"),
        };
      } catch (error) {
        throwDeploymentApiError(error);
      }
    },
  );

  app.get(
    "/api/v1/markets/:symbol",
    {
      schema: {
        params: marketSymbolParamsSchema,
        response: {
          200: apiEnvelopeSchema(marketDetailSchema),
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const instrument = await repository.getMarket(workspace.id, request.params.symbol);
      if (!instrument) {
        throw new ApiError(404, "MARKET_NOT_FOUND", "Торговая пара не найдена");
      }

      const snapshot = instrument.snapshots[0];
      const candles = [...instrument.candles].reverse();
      const analysis = calculateMarketAnalysis(
        candles.map((candle) => ({
          open: candle.open.toNumber(),
          high: candle.high.toNumber(),
          low: candle.low.toNumber(),
          close: candle.close.toNumber(),
        })),
      );
      const now = Date.now();
      const marketFreshness = !snapshot
        ? ("unavailable" as const)
        : now - snapshot.observedAt.getTime() < 60_000
          ? ("fresh" as const)
          : ("stale" as const);
      const latestCandle = candles.at(-1);
      const candleFreshness = !latestCandle
        ? ("unavailable" as const)
        : now - latestCandle.openTime.getTime() < 30 * 60_000
          ? ("fresh" as const)
          : ("stale" as const);

      return {
        data: {
          market: {
            symbol: instrument.symbol,
            baseAsset: instrument.baseAsset,
            quoteAsset: instrument.quoteAsset,
            exchange: instrument.exchange,
            instrumentType: instrument.instrumentType,
            watchlisted: instrument.watchlistItems.length > 0,
            price: snapshot?.price.toFixed() ?? null,
            change24hPercent: snapshot?.change24hPercent?.toFixed() ?? null,
            volume24h: snapshot?.volume24h?.toFixed() ?? null,
            regime: analysis.regime,
            freshness: marketFreshness,
          },
          interval: "15" as const,
          candles: candles.map((candle) => ({
            openTime: candle.openTime.toISOString(),
            open: candle.open.toFixed(),
            high: candle.high.toFixed(),
            low: candle.low.toFixed(),
            close: candle.close.toFixed(),
            volume: candle.volume.toFixed(),
            turnover: candle.turnover.toFixed(),
          })),
          analysis: {
            regime: analysis.regime,
            ema20: serializeMetric(analysis.ema20),
            ema50: serializeMetric(analysis.ema50),
            rsi14: serializeMetric(analysis.rsi14),
            atr14: serializeMetric(analysis.atr14),
            periodChangePercent: serializeMetric(analysis.periodChangePercent),
          },
        },
        meta: createMeta(
          request.id,
          marketFreshness === "fresh" && candleFreshness === "fresh" ? "fresh" : candleFreshness,
        ),
      };
    },
  );

  app.put(
    "/api/v1/watchlist/:symbol",
    {
      schema: {
        params: marketSymbolParamsSchema,
        response: {
          200: apiEnvelopeSchema(watchlistStateSchema),
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      if (!(await repository.hasEnabledMarket(request.params.symbol))) {
        throw new ApiError(404, "MARKET_NOT_FOUND", "Торговая пара не найдена");
      }
      await repository.setWatchlisted(workspace.id, request.params.symbol, true);
      return {
        data: { symbol: request.params.symbol, watchlisted: true },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.delete(
    "/api/v1/watchlist/:symbol",
    {
      schema: {
        params: marketSymbolParamsSchema,
        response: {
          200: apiEnvelopeSchema(watchlistStateSchema),
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      if (!(await repository.hasEnabledMarket(request.params.symbol))) {
        throw new ApiError(404, "MARKET_NOT_FOUND", "Торговая пара не найдена");
      }
      await repository.setWatchlisted(workspace.id, request.params.symbol, false);
      return {
        data: { symbol: request.params.symbol, watchlisted: false },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.post(
    "/api/v1/positions/:positionId/close",
    {
      schema: {
        params: positionIdParamsSchema,
        body: positionCloseInputSchema,
        response: {
          200: apiEnvelopeSchema(positionCloseResultSchema),
          400: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      try {
        const replayed = await runtimeRepository.replayManualClose(
          workspace.id,
          request.params.positionId,
          request.body.idempotencyKey,
        );
        if (replayed) return { data: replayed, meta: createMeta(request.id, "fresh") };

        const position = await runtimeRepository.getManualCloseContext(
          workspace.id,
          request.params.positionId,
        );
        if (!position) throw new ApiError(404, "POSITION_NOT_FOUND", "Позиция не найдена");
        if (position.status !== "OPEN") {
          const concurrentReplay = await runtimeRepository.replayManualClose(
            workspace.id,
            request.params.positionId,
            request.body.idempotencyKey,
          );
          if (concurrentReplay) {
            return { data: concurrentReplay, meta: createMeta(request.id, "fresh") };
          }
          throw new ApiError(409, "POSITION_STATUS_CONFLICT", "Позиция уже закрыта");
        }
        const quote = position.instrument.snapshots[0];
        if (!quote) {
          throw new ApiError(
            503,
            "MARKET_PRICE_UNAVAILABLE",
            "Нет актуальной цены для закрытия позиции",
          );
        }
        const strategyConfig = strategyConfigSchema.parse(position.strategyVersion.config);
        const settlement = settleExecutionPosition(
          {
            symbol: position.symbol,
            side: position.side === "BUY" ? "long" : "short",
            entryRegime: marketRegime[position.entryRegime],
            entrySession: tradingSession[position.entrySession],
            openedAt: position.openedAt,
            entryPrice: position.entryPrice.toNumber(),
            quantity: position.quantity.toNumber(),
            stopPrice: position.stopPrice.toNumber(),
            takePrice: position.takePrice.toNumber(),
            trailingPrice: position.trailingPrice?.toNumber() ?? null,
            bestPrice: position.bestPrice.toNumber(),
            entryFee: position.entryFee.toNumber(),
            entrySlippage: position.entrySlippage.toNumber(),
          },
          quote.price.toNumber(),
          new Date(),
          "manual",
          strategyConfig,
        );

        const result = await runtimeRepository.closeManually({
          workspaceId: workspace.id,
          positionId: position.id,
          executionRunId: position.executionRunId,
          actorId: requireContext(request).actorId,
          requestId: request.id,
          idempotencyKey: request.body.idempotencyKey,
          reason: request.body.reason,
          quoteObservedAt: quote.observedAt,
          maximumQuoteAgeMs: config.MARKET_POLL_INTERVAL_MS * 2,
          settlement: {
            exitPrice: String(settlement.exitPrice),
            grossPnl: String(settlement.grossPnl),
            netPnl: String(settlement.netPnl),
            fees: String(settlement.fees),
            slippage: String(settlement.slippage),
            exitReason: settlement.exitReason,
            closedAt: new Date(settlement.closedAt),
          },
        });
        return { data: result, meta: createMeta(request.id, "fresh") };
      } catch (error) {
        throwManualCloseApiError(error);
      }
    },
  );

  app.get(
    "/api/v1/trades",
    {
      schema: {
        response: {
          200: apiEnvelopeSchema(tradingLedgerSchema),
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const ledger = await repository.getTradingLedger(workspace.id);
      return {
        data: {
          summary: ledger.summary,
          positions: ledger.positions.map((position) => ({
            id: position.id,
            symbol: position.symbol,
            environment: tradingEnvironment[position.environment],
            side: orderSide[position.side],
            quantity: position.quantity.toFixed(),
            entryPrice: position.entryPrice.toFixed(),
            stopPrice: position.stopPrice.toFixed(),
            takePrice: position.takePrice.toFixed(),
            trailingPrice: position.trailingPrice?.toFixed() ?? null,
            markPrice: position.markPrice?.toFixed() ?? null,
            unrealizedPnl: position.unrealizedPnl.toFixed(),
            openedAt: position.openedAt.toISOString(),
            strategy: {
              id: position.strategyVersion.strategy.id,
              name: position.strategyVersion.strategy.name,
              version: position.strategyVersion.version,
            },
          })),
          trades: ledger.trades.map((trade) => ({
            id: trade.id,
            symbol: trade.symbol,
            environment: tradingEnvironment[trade.environment],
            side: orderSide[trade.side],
            entryRegime: marketRegime[trade.entryRegime],
            entrySession: tradingSession[trade.entrySession],
            quantity: trade.quantity.toFixed(),
            averageEntryPrice: trade.averageEntryPrice.toFixed(),
            averageExitPrice: trade.averageExitPrice.toFixed(),
            stopPrice: trade.position.stopPrice.toFixed(),
            takePrice: trade.position.takePrice.toFixed(),
            trailingPrice: trade.position.trailingPrice?.toFixed() ?? null,
            grossPnl: trade.grossPnl.toFixed(),
            fees: trade.fees.toFixed(),
            funding: trade.funding.toFixed(),
            slippage: trade.slippage.toFixed(),
            netPnl: trade.netPnl.toFixed(),
            exitReason: trade.exitReason,
            openedAt: trade.openedAt.toISOString(),
            closedAt: trade.closedAt.toISOString(),
            strategy: {
              id: trade.strategyVersion.strategy.id,
              name: trade.strategyVersion.strategy.name,
              version: trade.strategyVersion.version,
            },
          })),
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.get(
    "/api/v1/trades/:tradeId",
    {
      schema: {
        params: tradeIdParamsSchema,
        response: {
          200: apiEnvelopeSchema(tradeDetailSchema),
          404: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const detail = await repository.getTradeDetail(workspace.id, request.params.tradeId);
      if (!detail) {
        throw new ApiError(404, "TRADE_NOT_FOUND", "Сделка не найдена");
      }

      return {
        data: {
          trade: {
            id: detail.id,
            symbol: detail.symbol,
            environment: tradingEnvironment[detail.environment],
            side: orderSide[detail.side],
            entryRegime: marketRegime[detail.entryRegime],
            entrySession: tradingSession[detail.entrySession],
            quantity: detail.quantity.toFixed(),
            averageEntryPrice: detail.averageEntryPrice.toFixed(),
            averageExitPrice: detail.averageExitPrice.toFixed(),
            stopPrice: detail.position.stopPrice.toFixed(),
            takePrice: detail.position.takePrice.toFixed(),
            trailingPrice: detail.position.trailingPrice?.toFixed() ?? null,
            grossPnl: detail.grossPnl.toFixed(),
            fees: detail.fees.toFixed(),
            funding: detail.funding.toFixed(),
            slippage: detail.slippage.toFixed(),
            netPnl: detail.netPnl.toFixed(),
            exitReason: detail.exitReason,
            openedAt: detail.openedAt.toISOString(),
            closedAt: detail.closedAt.toISOString(),
            strategy: {
              id: detail.strategyVersion.strategy.id,
              name: detail.strategyVersion.strategy.name,
              version: detail.strategyVersion.version,
            },
          },
          execution: {
            runId: detail.executionRun.id,
            status: runStatus[detail.executionRun.status],
            engineVersion: detail.executionRun.engineVersion,
            configHash: detail.executionRun.configHash,
          },
          orders: detail.position.orders.map((order) => ({
            id: order.id,
            clientOrderId: order.clientOrderId,
            exchangeOrderId: order.exchangeOrderId,
            side: orderSide[order.side],
            type: orderType[order.type],
            status: orderStatus[order.status],
            quantity: order.quantity.toFixed(),
            price: order.price?.toFixed() ?? null,
            createdAt: order.createdAt.toISOString(),
            updatedAt: order.updatedAt.toISOString(),
            fills: order.fills.map((fill) => ({
              id: fill.id,
              exchangeFillId: fill.exchangeFillId,
              quantity: fill.quantity.toFixed(),
              price: fill.price.toFixed(),
              fee: fill.fee.toFixed(),
              feeAsset: fill.feeAsset,
              filledAt: fill.filledAt.toISOString(),
            })),
          })),
        },
        meta: createMeta(request.id, "fresh"),
      };
    },
  );

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Маршрут не найден",
        requestId: request.id,
      },
    }),
  );

  return app;
}

const overviewPeriodConfig = {
  "24h": { durationMs: 24 * 60 * 60 * 1_000, bucketSeconds: 15 * 60 },
  "7d": { durationMs: 7 * 24 * 60 * 60 * 1_000, bucketSeconds: 2 * 60 * 60 },
  "30d": { durationMs: 30 * 24 * 60 * 60 * 1_000, bucketSeconds: 8 * 60 * 60 },
} as const;

const analyticsPeriodDurationMs = {
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
  "90d": 90 * 24 * 60 * 60 * 1_000,
  all: null,
} as const;

const activityPeriodDurationMs = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
  all: null,
} as const;

const systemLogPeriodDurationMs = {
  "1h": 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
  all: null,
} as const;

function getSystemLogStartsAt(period: keyof typeof systemLogPeriodDurationMs): Date | null {
  const durationMs = systemLogPeriodDurationMs[period];
  return durationMs === null ? null : new Date(Date.now() - durationMs);
}

function getActivityStartsAt(period: keyof typeof activityPeriodDurationMs): Date | null {
  const durationMs = activityPeriodDurationMs[period];
  return durationMs === null ? null : new Date(Date.now() - durationMs);
}

function getAnalyticsStartsAt(period: keyof typeof analyticsPeriodDurationMs): Date | null {
  const durationMs = analyticsPeriodDurationMs[period];
  return durationMs === null ? null : new Date(Date.now() - durationMs);
}

function createHealthThresholds(config: ServerConfig) {
  return {
    workerStaleMs: 45_000,
    marketStaleMs: config.MARKET_POLL_INTERVAL_MS * 3,
    accountStaleMs: config.ACCOUNT_SNAPSHOT_INTERVAL_MS * 2,
    queueLagMs: 5 * 60_000,
    outboxLagMs: 5 * 60_000,
    exchangeVerificationOverdueMs: config.EXCHANGE_VERIFICATION_POLL_INTERVAL_MS * 3,
  };
}

function serializeWatchdogIncident(incident: {
  id: string;
  fingerprint: string;
  domain: string;
  code: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  status: "OPEN" | "RESOLVED";
  title: string;
  description: string;
  resourceType: string | null;
  resourceId: string | null;
  occurrenceCount: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
  resolvedAt: Date | null;
}) {
  if (incident.severity === "INFO") {
    throw new Error("Informational watchdog events must not be serialized as incidents");
  }
  return {
    id: incident.id,
    fingerprint: incident.fingerprint,
    domain: incident.domain,
    code: incident.code,
    severity: incident.severity === "CRITICAL" ? ("critical" as const) : ("warning" as const),
    status: incident.status === "OPEN" ? ("open" as const) : ("resolved" as const),
    title: incident.title,
    description: incident.description,
    resourceType: incident.resourceType,
    resourceId: incident.resourceId,
    occurrenceCount: incident.occurrenceCount,
    firstObservedAt: incident.firstObservedAt.toISOString(),
    lastObservedAt: incident.lastObservedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
  };
}

function serializeAnalyticsBreakdown(
  items: Array<{
    key: string;
    label: string;
    trades: number;
    wins: number;
    winRatePercent: number;
    grossPnl: number;
    netPnl: number;
    costs: number;
  }>,
) {
  return items.map((item) => ({
    ...item,
    grossPnl: String(item.grossPnl),
    netPnl: String(item.netPnl),
    costs: String(item.costs),
  }));
}

type JournalEntryResult = Awaited<ReturnType<JournalRepository["createEntry"]>>;
type ReviewSessionResult = Awaited<ReturnType<JournalRepository["createReview"]>>;
type PlaybookResult = Awaited<ReturnType<PlaybookRepository["create"]>>;
type WorkspacePreferencesResult = Awaited<ReturnType<SettingsRepository["get"]>>;

function serializeWorkspacePreferences(preferences: WorkspacePreferencesResult) {
  if (preferences.currency !== "USDT") {
    throw new Error(`Unsupported workspace currency: ${preferences.currency}`);
  }
  if (preferences.tableDensity !== "compact" && preferences.tableDensity !== "comfortable") {
    throw new Error(`Unsupported table density: ${preferences.tableDensity}`);
  }
  return {
    timezone: preferences.timezone,
    currency: "USDT" as const,
    tableDensity: preferences.tableDensity as "compact" | "comfortable",
    updatedAt: preferences.updatedAt.toISOString(),
  };
}

function serializePlaybook(playbook: PlaybookResult) {
  return {
    id: playbook.id,
    name: playbook.name,
    description: playbook.description,
    status: playbookStatus[playbook.status],
    marketConditions: playbook.marketConditions,
    entryRules: playbook.entryRules,
    exitRules: playbook.exitRules,
    riskRules: playbook.riskRules,
    invalidationRules: playbook.invalidationRules,
    checklist: playbook.checklist,
    tags: playbook.tags,
    strategies: playbook.strategies.map(({ strategy }) => strategy),
    exampleTrades: playbook.exampleTrades.map(({ trade }) => ({
      id: trade.id,
      symbol: trade.symbol,
      side: orderSide[trade.side],
      netPnl: trade.netPnl.toFixed(),
      closedAt: trade.closedAt.toISOString(),
    })),
    createdAt: playbook.createdAt.toISOString(),
    updatedAt: playbook.updatedAt.toISOString(),
  };
}

function serializeJournalEntry(entry: JournalEntryResult) {
  return {
    id: entry.id,
    kind: journalKind[entry.kind],
    title: entry.title,
    body: entry.body,
    tags: entry.tags,
    occurredAt: entry.occurredAt.toISOString(),
    createdAt: entry.createdAt.toISOString(),
    links: entry.links.map((link) => {
      if (link.type === "STRATEGY") {
        return {
          type: "strategy" as const,
          targetId: link.strategyId!,
          label: link.strategy!.name,
          href: `/strategies/${link.strategyId!}`,
        };
      }
      if (link.type === "STRATEGY_VERSION") {
        return {
          type: "strategy-version" as const,
          targetId: link.strategyVersionId!,
          label: `${link.strategyVersion!.strategy.name} · v${link.strategyVersion!.version}`,
          href: `/strategies/${link.strategyVersion!.strategy.id}?tab=versions`,
        };
      }
      if (link.type === "EXECUTION_RUN") {
        return {
          type: "execution-run" as const,
          targetId: link.executionRunId!,
          label: `${link.executionRun!.strategyVersion.strategy.name} · run ${link.executionRunId!.slice(0, 8)}`,
          href: "/runtime",
        };
      }
      if (link.type === "VALIDATION_RUN") {
        return {
          type: "validation-run" as const,
          targetId: link.validationRunId!,
          label: `${link.validationRun!.strategy.name} · v${link.validationRun!.strategyVersion.version}`,
          href: `/validation/${link.validationRunId!}`,
        };
      }
      if (link.type === "TRADE") {
        return {
          type: "trade" as const,
          targetId: link.tradeId!,
          label: `${link.trade!.symbol} · ${link.trade!.closedAt.toISOString().slice(0, 10)}`,
          href: `/trades/${link.tradeId!}`,
        };
      }
      if (link.type === "DECISION") {
        return {
          type: "decision" as const,
          targetId: link.decisionId!,
          label: `${link.decision!.symbol} · ${decisionAction[link.decision!.action]}`,
          href: "/activity",
        };
      }
      return {
        type: "symbol" as const,
        targetId: link.symbol!,
        label: link.instrument!.symbol,
        href: `/markets/${link.symbol!}`,
      };
    }),
  };
}

function serializeReviewSession(review: ReviewSessionResult) {
  return {
    id: review.id,
    title: review.title,
    startsAt: review.startsAt.toISOString(),
    endsAt: review.endsAt.toISOString(),
    summary: review.summary,
    learnings: review.learnings,
    nextActions: review.nextActions,
    tags: review.tags,
    entryCount: review._count.entries,
    createdAt: review.createdAt.toISOString(),
  };
}

function serializeAuthWorkspace(membership: {
  role: "OWNER" | "MEMBER";
  workspace: { id: string; slug: string; name: string };
}) {
  return {
    ...membership.workspace,
    role: membership.role === "OWNER" ? ("owner" as const) : ("member" as const),
  };
}

function serializeAuthSession(context: AuthenticatedContext) {
  return {
    authenticated: true as const,
    user: context.user,
    activeWorkspace: context.workspace,
    workspaces: context.workspaces,
    csrfToken: context.csrfToken,
    expiresAt: context.expiresAt.toISOString(),
  };
}

function hashSessionToken(rawToken: string) {
  return createHash("sha256").update(rawToken).digest("hex");
}

function createCsrfToken(secret: string, rawToken: string) {
  return createHmac("sha256", secret).update(rawToken).digest("base64url");
}

function assertCsrfToken(received: string | string[] | undefined, expected: string) {
  if (typeof received !== "string") {
    throw new ApiError(403, "CSRF_TOKEN_INVALID", "CSRF-токен отсутствует или недействителен");
  }
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    throw new ApiError(403, "CSRF_TOKEN_INVALID", "CSRF-токен отсутствует или недействителен");
  }
}

function isMutatingMethod(method: string) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function isPublicRoute(url: string) {
  const path = url.split("?", 1)[0];
  return (
    path === "/health" ||
    path === "/api/v1/auth/login" ||
    path === "/api/v1/auth/session" ||
    (path ? /^\/api\/v1\/auth\/recovery\/[A-Za-z0-9_-]{40,128}$/.test(path) : false) ||
    (path ? /^\/api\/v1\/invitations\/[A-Za-z0-9_-]{40,128}(?:\/accept)?$/.test(path) : false)
  );
}

function normalizeHeader(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join(", ").slice(0, 500);
  return value?.slice(0, 500) ?? null;
}

function maskEmail(email: string) {
  const separator = email.lastIndexOf("@");
  if (separator <= 0) return "***";
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function createWorkspaceSlug(name: string) {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${base || "workspace"}-${randomBytes(4).toString("hex")}`;
}

function serializeWorkspaceRole(role: "OWNER" | "MEMBER") {
  return role === "OWNER" ? ("owner" as const) : ("member" as const);
}

function persistedWorkspaceRole(role: "owner" | "member") {
  return role === "owner" ? ("OWNER" as const) : ("MEMBER" as const);
}

function serializeInvitation(invitation: {
  id: string;
  email: string;
  role: "OWNER" | "MEMBER";
  expiresAt: Date;
  createdAt: Date;
}) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: serializeWorkspaceRole(invitation.role),
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
  };
}

function throwMemberApiError(error: unknown): never {
  if (error instanceof AuthMemberNotFoundError) {
    throw new ApiError(404, "MEMBER_NOT_FOUND", "Участник не найден");
  }
  if (error instanceof AuthLastOwnerError) {
    throw new ApiError(409, "WORKSPACE_OWNER_REQUIRED", "В workspace должен остаться владелец");
  }
  throw error;
}

function serializeExchangeConnection(connection: {
  id: string;
  exchange: string;
  label: string;
  environment: "DRY_RUN" | "DEMO" | "LIVE";
  status: "UNVERIFIED" | "ACTIVE" | "INVALID";
  apiKeyHint: string;
  readOnly: boolean | null;
  tradingPermission: boolean | null;
  ipBound: boolean | null;
  permissions: unknown;
  lastVerificationCode: string | null;
  lastVerificationMessage: string | null;
  lastVerifiedAt: Date | null;
  lastVerificationAttemptAt: Date | null;
  nextVerificationAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count: { deployments: number };
}) {
  return {
    id: connection.id,
    exchange: "bybit" as const,
    label: connection.label,
    environment: serializeExchangeEnvironment(connection.environment),
    status: exchangeConnectionStatus[connection.status],
    apiKeyHint: connection.apiKeyHint,
    readOnly: connection.readOnly,
    tradingPermission: connection.tradingPermission,
    ipBound: connection.ipBound,
    permissionGroups: serializePermissionGroups(connection.permissions),
    lastVerificationCode: connection.lastVerificationCode,
    lastVerificationMessage: connection.lastVerificationMessage,
    lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
    lastVerificationAttemptAt: connection.lastVerificationAttemptAt?.toISOString() ?? null,
    nextVerificationAt: connection.nextVerificationAt?.toISOString() ?? null,
    activeDeployments: connection._count.deployments,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

function serializePermissionGroups(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) && entry[1].every((permission) => typeof permission === "string"),
    )
    .map(([name, permissions]) => ({ name, permissions }))
    .filter((group) => group.permissions.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function serializeExchangeEnvironment(environment: "DRY_RUN" | "DEMO" | "LIVE") {
  if (environment === "DRY_RUN") {
    throw new Error("DRY_RUN is not a valid private exchange connection environment");
  }
  return environment === "DEMO" ? ("demo" as const) : ("live" as const);
}

function maskApiKey(apiKey: string) {
  return `••••${apiKey.slice(-4)}`;
}

function throwExchangeConnectionApiError(error: unknown): never {
  if (error instanceof ExchangeConnectionNotFoundError) {
    throw new ApiError(404, "EXCHANGE_CONNECTION_NOT_FOUND", "Подключение не найдено");
  }
  if (error instanceof ExchangeConnectionInUseError) {
    throw new ApiError(
      409,
      "EXCHANGE_CONNECTION_IN_USE",
      "Сначала остановите deployment, использующий это подключение",
    );
  }
  if (error instanceof ExchangeConnectionVerificationConflictError) {
    throw new ApiError(
      409,
      "EXCHANGE_CONNECTION_VERIFICATION_CONFLICT",
      "Credentials изменились во время проверки. Запустите проверку ещё раз",
    );
  }
  throw error;
}

function addMinutes(value: Date, minutes: number) {
  return new Date(value.getTime() + minutes * 60_000);
}

function addHours(value: Date, hours: number) {
  return addMinutes(value, hours * 60);
}

function hasStatusCode(error: unknown, statusCode: number) {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === statusCode
  );
}

function sessionCookieOptions(config: ServerConfig) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "strict" as const,
    secure: config.NODE_ENV === "production",
    maxAge: config.AUTH_SESSION_TTL_HOURS * 60 * 60,
  };
}

function createMeta(requestId: string, freshness: "fresh" | "stale" | "unavailable") {
  return {
    requestId,
    generatedAt: new Date().toISOString(),
    freshness,
  };
}

function serializeMetric(value: number | null): string | null {
  return value === null || !Number.isFinite(value) ? null : String(value);
}

function serializeStrategyVersion(
  version: { id: string; version: number; configHash: string; createdAt: Date } | null,
) {
  return version
    ? {
        id: version.id,
        version: version.version,
        configHash: version.configHash,
        createdAt: version.createdAt.toISOString(),
      }
    : null;
}

function createStrategyLifecycleProjection(strategy: {
  status: keyof typeof strategyStatus;
  versions: Array<{ id: string }>;
  validationRuns: Array<{
    status: keyof typeof runStatus;
    verdict: keyof typeof validationVerdict;
    strategyVersion: { id: string };
  }>;
  deployments: Array<{ status: keyof typeof deploymentStatus }>;
}) {
  return evaluateStrategyLifecycle({
    status: strategyStatus[strategy.status],
    latestVersionId: strategy.versions[0]?.id ?? null,
    validations: strategy.validationRuns.map((validation) => ({
      strategyVersionId: validation.strategyVersion.id,
      status: runStatus[validation.status],
      verdict: validationVerdict[validation.verdict],
    })),
    hasActiveDeployment: strategy.deployments.some(
      (deployment) =>
        deployment.status === "READY" ||
        deployment.status === "RUNNING" ||
        deployment.status === "PAUSED",
    ),
  });
}

type ValidationRunSource = {
  id: string;
  kind: keyof typeof validationKind;
  status: keyof typeof runStatus;
  verdict: keyof typeof validationVerdict;
  datasetId: string;
  datasetSnapshot: {
    id: string;
    schemaVersion: number;
    source: string;
    exchange: string;
    instrumentType: string;
    timeframe: string;
    symbols: unknown;
    startsAt: Date;
    endsAt: Date;
    candleCount: number;
    contentHash: string;
    createdAt: Date;
  } | null;
  datasetAsOf: Date;
  engineVersion: string;
  configHash: string;
  input: unknown;
  metrics: unknown;
  failureCode: string | null;
  failureMessage: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  strategy: { id: string; name: string };
  strategyVersion: { id: string; version: number };
};

function serializeValidationRunBase(run: ValidationRunSource) {
  const parsedInput = validationExecutionInputSchema.parse(run.input);
  const datasetSnapshot = run.datasetSnapshot;
  const snapshotSymbols = datasetSnapshot ? readStringArray(datasetSnapshot.symbols) : [];
  if (
    datasetSnapshot &&
    (datasetSnapshot.timeframe !== parsedInput.dataset.timeframe ||
      JSON.stringify(snapshotSymbols) !==
        JSON.stringify([...new Set(parsedInput.dataset.symbols)].sort()))
  ) {
    throw new Error("Validation dataset snapshot does not match run input");
  }
  return {
    id: run.id,
    strategy: run.strategy,
    strategyVersion: run.strategyVersion,
    kind: validationKind[run.kind],
    status: runStatus[run.status],
    verdict: validationVerdict[run.verdict],
    datasetId: run.datasetId,
    datasetSnapshot: datasetSnapshot
      ? {
          id: datasetSnapshot.id,
          schemaVersion: datasetSnapshot.schemaVersion,
          source: datasetSnapshot.source,
          exchange: datasetSnapshot.exchange,
          instrumentType: datasetSnapshot.instrumentType,
          timeframe: parsedInput.dataset.timeframe,
          symbols: snapshotSymbols,
          startsAt: datasetSnapshot.startsAt.toISOString(),
          endsAt: datasetSnapshot.endsAt.toISOString(),
          candleCount: datasetSnapshot.candleCount,
          contentHash: datasetSnapshot.contentHash,
          createdAt: datasetSnapshot.createdAt.toISOString(),
        }
      : null,
    datasetAsOf: run.datasetAsOf.toISOString(),
    engineVersion: run.engineVersion,
    configHash: run.configHash,
    input: parsedInput,
    failureCode: run.failureCode,
    failureMessage: run.failureMessage,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function serializeValidationRun(run: ValidationRunSource) {
  const metrics = run.metrics === null ? null : validationMetricsSchema.parse(run.metrics);
  return {
    ...serializeValidationRunBase(run),
    metrics: metrics === null ? null : validationMetricsSummarySchema.parse(metrics),
  };
}

function serializeValidationRunDetail(run: ValidationRunSource) {
  return {
    ...serializeValidationRunBase(run),
    metrics: run.metrics === null ? null : validationMetricsSchema.parse(run.metrics),
  };
}

type DeploymentSource = {
  id: string;
  environment: keyof typeof tradingEnvironment;
  exchangeAccountId: string;
  exchangeConnection: {
    id: string;
    exchange: string;
    label: string;
    environment: "DRY_RUN" | "DEMO" | "LIVE";
    status: keyof typeof exchangeConnectionStatus;
    readOnly: boolean | null;
    tradingPermission: boolean | null;
    ipBound: boolean | null;
    lastVerifiedAt: Date | null;
  } | null;
  status: keyof typeof deploymentStatus;
  createdAt: Date;
  updatedAt: Date;
  strategy: { id: string; name: string };
  strategyVersion: { id: string; version: number };
  executionRuns: Array<{
    id: string;
    status: keyof typeof runStatus;
    contextHash: string;
    engineVersion: string;
    startedAt: Date | null;
    stoppedAt: Date | null;
    createdAt: Date;
    runtimeCursors: Array<{
      lastEvaluatedAt: Date | null;
      consecutiveFailures: number;
    }>;
    decisions: Array<{
      symbol: string;
      action: keyof typeof decisionAction;
      reasonCode: string;
      summary: string;
      decidedAt: Date;
    }>;
    _count: { positions: number };
  }>;
};

function serializeDeployment(deployment: DeploymentSource) {
  const status = deploymentStatus[deployment.status];
  const latestExecutionRun = deployment.executionRuns[0] ?? null;
  const connectionReady =
    deployment.exchangeConnection?.status === "ACTIVE" &&
    deployment.exchangeConnection.lastVerifiedAt !== null;

  return {
    id: deployment.id,
    strategy: deployment.strategy,
    strategyVersion: deployment.strategyVersion,
    environment: tradingEnvironment[deployment.environment],
    exchangeAccountId: deployment.exchangeAccountId,
    exchangeConnection: deployment.exchangeConnection
      ? {
          ...deployment.exchangeConnection,
          exchange: "bybit" as const,
          environment: serializeExchangeEnvironment(deployment.exchangeConnection.environment),
          status: exchangeConnectionStatus[deployment.exchangeConnection.status],
          lastVerifiedAt: deployment.exchangeConnection.lastVerifiedAt?.toISOString() ?? null,
        }
      : null,
    status,
    allowedCommands: getDeploymentCommands(status).filter((command) => {
      if ((command === "start" || command === "resume") && !connectionReady) return false;
      return command !== "stop" || (latestExecutionRun?._count.positions ?? 0) === 0;
    }),
    latestExecutionRun: latestExecutionRun
      ? {
          id: latestExecutionRun.id,
          status: runStatus[latestExecutionRun.status],
          contextHash: latestExecutionRun.contextHash,
          engineVersion: latestExecutionRun.engineVersion,
          startedAt: latestExecutionRun.startedAt?.toISOString() ?? null,
          stoppedAt: latestExecutionRun.stoppedAt?.toISOString() ?? null,
          createdAt: latestExecutionRun.createdAt.toISOString(),
          openPositions: latestExecutionRun._count.positions,
          evaluatedSymbols: latestExecutionRun.runtimeCursors.filter(
            (cursor) => cursor.lastEvaluatedAt !== null,
          ).length,
          failingSymbols: latestExecutionRun.runtimeCursors.filter(
            (cursor) => cursor.consecutiveFailures > 0,
          ).length,
          lastEvaluatedAt:
            latestExecutionRun.runtimeCursors
              .find((cursor) => cursor.lastEvaluatedAt)
              ?.lastEvaluatedAt?.toISOString() ?? null,
          lastDecision: latestExecutionRun.decisions[0]
            ? {
                ...latestExecutionRun.decisions[0],
                action: decisionAction[latestExecutionRun.decisions[0].action],
                decidedAt: latestExecutionRun.decisions[0].decidedAt.toISOString(),
              }
            : null,
        }
      : null,
    createdAt: deployment.createdAt.toISOString(),
    updatedAt: deployment.updatedAt.toISOString(),
  };
}

function throwDeploymentApiError(error: unknown): never {
  if (error instanceof DeploymentStrategyNotFoundError) {
    throw new ApiError(404, "STRATEGY_NOT_FOUND", "Стратегия не найдена");
  }
  if (error instanceof DeploymentNotFoundError) {
    throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "Deployment не найден");
  }
  if (error instanceof DeploymentNotEligibleError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_NOT_ELIGIBLE",
      "Deployment доступен только для одобренной стратегии",
    );
  }
  if (error instanceof DeploymentVersionMismatchError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_VERSION_MISMATCH",
      "Deployment должен использовать активную версию стратегии",
    );
  }
  if (error instanceof DeploymentValidationRequiredError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_VALIDATION_REQUIRED",
      "Для этой версии нет успешно завершённой проверки",
    );
  }
  if (error instanceof DeploymentExchangeConnectionNotFoundError) {
    throw new ApiError(
      404,
      "DEPLOYMENT_EXCHANGE_CONNECTION_NOT_FOUND",
      "Подключение биржи не найдено в текущем workspace",
    );
  }
  if (error instanceof DeploymentExchangeConnectionNotReadyError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_EXCHANGE_CONNECTION_NOT_READY",
      "Подключение биржи должно быть успешно проверено перед запуском",
    );
  }
  if (error instanceof ActiveDeploymentExistsError) {
    throw new ApiError(
      409,
      "ACTIVE_DEPLOYMENT_EXISTS",
      "На dry-run счёте уже есть активный deployment",
    );
  }
  if (error instanceof DeploymentStatusConflictError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_STATUS_CONFLICT",
      "Статус deployment уже изменился. Обновите страницу",
    );
  }
  if (error instanceof DeploymentCommandNotAllowedError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_COMMAND_NOT_ALLOWED",
      "Команда недоступна для текущего состояния deployment",
    );
  }
  if (error instanceof DeploymentHasOpenPositionsError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_HAS_OPEN_POSITIONS",
      "Сначала закройте открытые позиции deployment",
    );
  }
  if (error instanceof DeploymentIdempotencyConflictError) {
    throw new ApiError(
      409,
      "DEPLOYMENT_IDEMPOTENCY_CONFLICT",
      "Idempotency key уже использован другой командой",
    );
  }
  throw error;
}

function throwManualCloseApiError(error: unknown): never {
  if (error instanceof RuntimePositionNotFoundError) {
    throw new ApiError(404, "POSITION_NOT_FOUND", "Позиция не найдена");
  }
  if (error instanceof RuntimePositionStatusConflictError) {
    throw new ApiError(409, "POSITION_STATUS_CONFLICT", "Позиция уже закрыта");
  }
  if (error instanceof RuntimeManualCloseNotAllowedError) {
    throw new ApiError(
      409,
      "POSITION_CLOSE_NOT_ALLOWED",
      "Ручное закрытие доступно только активной dry-run позиции",
    );
  }
  if (error instanceof RuntimeMarketPriceUnavailableError) {
    throw new ApiError(
      503,
      "MARKET_PRICE_UNAVAILABLE",
      "Цена для закрытия устарела. Дождитесь обновления рынка",
    );
  }
  if (error instanceof RuntimeIdempotencyConflictError) {
    throw new ApiError(
      409,
      "POSITION_IDEMPOTENCY_CONFLICT",
      "Idempotency key уже использован другой командой",
    );
  }
  throw error;
}

function throwPlaybookApiError(error: unknown): never {
  if (error instanceof PlaybookNotFoundError) {
    throw new ApiError(404, "PLAYBOOK_NOT_FOUND", "Плейбук не найден");
  }
  if (error instanceof PlaybookLinkNotFoundError) {
    throw new ApiError(
      404,
      "PLAYBOOK_LINK_NOT_FOUND",
      error.target === "strategy"
        ? "Связанная стратегия не найдена в текущем workspace"
        : "Связанная сделка не найдена в текущем workspace",
    );
  }
  if (error instanceof PlaybookNameConflictError) {
    throw new ApiError(409, "PLAYBOOK_NAME_CONFLICT", "Плейбук с таким названием уже существует");
  }
  if (error instanceof PlaybookUpdateConflictError) {
    throw new ApiError(
      409,
      "PLAYBOOK_UPDATE_CONFLICT",
      "Плейбук уже изменился. Обновите данные и повторите попытку",
    );
  }
  if (error instanceof PlaybookStatusConflictError) {
    throw new ApiError(
      409,
      "PLAYBOOK_STATUS_CONFLICT",
      "Статус плейбука уже изменился. Обновите данные",
    );
  }
  throw error;
}

function throwSettingsApiError(error: unknown): never {
  if (error instanceof WorkspaceTimezoneInvalidError) {
    throw new ApiError(400, "WORKSPACE_TIMEZONE_INVALID", "Укажите корректную IANA timezone");
  }
  if (error instanceof WorkspaceSettingsNotFoundError) {
    throw new ApiError(404, "WORKSPACE_SETTINGS_NOT_FOUND", "Настройки workspace не найдены");
  }
  if (error instanceof WorkspaceSettingsConflictError) {
    throw new ApiError(
      409,
      "WORKSPACE_SETTINGS_CONFLICT",
      "Настройки уже изменились. Обновите страницу",
    );
  }
  throw error;
}

function getValidationMessages(error: unknown): string[] | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("validation" in error) ||
    !Array.isArray(error.validation)
  ) {
    return null;
  }

  return error.validation.map((issue) => {
    if (issue && typeof issue === "object" && "message" in issue) {
      return String(issue.message);
    }
    return "Некорректное значение";
  });
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value].sort()
    : [];
}

function readJsonObject(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Decision factors must be a JSON object");
  }
  return value as Record<string, unknown>;
}

const tradingEnvironment = {
  DRY_RUN: "dry-run",
  DEMO: "demo",
  LIVE: "live",
} as const;

const analyticsTradingEnvironment = {
  "dry-run": "DRY_RUN",
  demo: "DEMO",
  live: "LIVE",
} as const;

const orderSide = {
  BUY: "buy",
  SELL: "sell",
} as const;

const marketRegime = {
  BULL: "bull",
  BEAR: "bear",
  NEUTRAL: "neutral",
  UNKNOWN: "unknown",
} as const;

const tradingSession = {
  ASIA: "asia",
  EUROPE: "europe",
  US: "us",
  OFF_HOURS: "off-hours",
  UNKNOWN: "unknown",
} as const;

const orderType = {
  MARKET: "market",
  LIMIT: "limit",
  STOP: "stop",
} as const;

const orderStatus = {
  PENDING: "pending",
  OPEN: "open",
  PARTIALLY_FILLED: "partially-filled",
  FILLED: "filled",
  CANCELLED: "cancelled",
  REJECTED: "rejected",
} as const;

const decisionAction = {
  OPEN: "open",
  CLOSE: "close",
  HOLD: "hold",
  SKIP: "skip",
  ERROR: "error",
} as const;

const journalKind = {
  HYPOTHESIS: "hypothesis",
  OBSERVATION: "observation",
  CONCLUSION: "conclusion",
  DECISION: "decision",
} as const;

const persistedJournalKind = {
  hypothesis: "HYPOTHESIS",
  observation: "OBSERVATION",
  conclusion: "CONCLUSION",
  decision: "DECISION",
} as const;

const persistedJournalLinkType = {
  strategy: "STRATEGY",
  "strategy-version": "STRATEGY_VERSION",
  "execution-run": "EXECUTION_RUN",
  "validation-run": "VALIDATION_RUN",
  trade: "TRADE",
  decision: "DECISION",
  symbol: "SYMBOL",
} as const;

const playbookStatus = {
  ACTIVE: "active",
  ARCHIVED: "archived",
} as const;

const persistedPlaybookStatus = {
  active: "ACTIVE",
  archived: "ARCHIVED",
} as const;

const systemLogLevel = {
  DEBUG: "debug",
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
  CRITICAL: "critical",
} as const;

const persistedSystemLogLevel = {
  debug: "DEBUG",
  info: "INFO",
  warning: "WARNING",
  error: "ERROR",
  critical: "CRITICAL",
} as const;

const persistedDecisionAction = {
  open: "OPEN",
  close: "CLOSE",
  hold: "HOLD",
  skip: "SKIP",
  error: "ERROR",
} as const;

const runStatus = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

const strategyStatuses = [
  "draft",
  "validating",
  "approved",
  "deployed",
  "paused",
  "archived",
] as const;

const strategyStatus = {
  DRAFT: "draft",
  VALIDATING: "validating",
  APPROVED: "approved",
  DEPLOYED: "deployed",
  PAUSED: "paused",
  ARCHIVED: "archived",
} as const;

const persistedStrategyStatus = {
  draft: "DRAFT",
  validating: "VALIDATING",
  approved: "APPROVED",
  deployed: "DEPLOYED",
  paused: "PAUSED",
  archived: "ARCHIVED",
} as const;

const persistedManualStrategyStatus = {
  draft: "DRAFT",
  approved: "APPROVED",
  archived: "ARCHIVED",
} as const;

const validationKind = {
  BACKTEST: "backtest",
  WALK_FORWARD: "walk-forward",
  HOLDOUT: "holdout",
} as const;

const persistedValidationKind = {
  backtest: "BACKTEST",
  "walk-forward": "WALK_FORWARD",
} as const;

const validationExitReasons: Record<
  string,
  "stop-loss" | "take-profit" | "trailing-stop" | "signal-exit" | "end-of-data"
> = {
  "stop-loss": "stop-loss",
  "take-profit": "take-profit",
  "trailing-stop": "trailing-stop",
  "signal-exit": "signal-exit",
  "end-of-data": "end-of-data",
};

function serializeValidationExitReason(
  value: string,
): "stop-loss" | "take-profit" | "trailing-stop" | "signal-exit" | "end-of-data" {
  const reason = validationExitReasons[value];
  if (!reason) throw new Error(`Unknown validation exit reason: ${value}`);
  return reason;
}

const validationVerdict = {
  PENDING: "pending",
  PASSED: "passed",
  FAILED: "failed",
  WARNING: "warning",
} as const;

const deploymentStatus = {
  DRAFT: "draft",
  READY: "ready",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPED: "stopped",
  FAILED: "failed",
} as const;

const deploymentStatuses = ["draft", "ready", "running", "paused", "stopped", "failed"] as const;

const persistedDeploymentStatus = {
  draft: "DRAFT",
  ready: "READY",
  running: "RUNNING",
  paused: "PAUSED",
  stopped: "STOPPED",
  failed: "FAILED",
} as const;

const persistedDeploymentCommand = {
  start: "START",
  pause: "PAUSE",
  resume: "RESUME",
  stop: "STOP",
} as const;

const persistedExchangeEnvironment = {
  demo: "DEMO",
  live: "LIVE",
} as const;

const exchangeConnectionStatus = {
  UNVERIFIED: "unverified",
  ACTIVE: "active",
  INVALID: "invalid",
} as const;
