import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";

type PersistedEnvironment = "DEMO" | "LIVE";

const exchangeConnectionSelect = {
  id: true,
  exchange: true,
  label: true,
  environment: true,
  status: true,
  apiKeyHint: true,
  readOnly: true,
  tradingPermission: true,
  ipBound: true,
  permissions: true,
  lastVerificationCode: true,
  lastVerificationMessage: true,
  lastVerifiedAt: true,
  lastVerificationAttemptAt: true,
  nextVerificationAt: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      deployments: { where: { status: { in: ["READY", "RUNNING", "PAUSED"] } } },
    },
  },
} satisfies Prisma.ExchangeConnectionSelect;

export class ExchangeConnectionNotFoundError extends Error {}
export class ExchangeConnectionInUseError extends Error {}
export class ExchangeConnectionVerificationConflictError extends Error {}
export class ExchangeConnectionVerificationLeaseLostError extends Error {}

export class ExchangeConnectionRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public list(workspaceId: string) {
    return this.prisma.exchangeConnection.findMany({
      where: { workspaceId, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: exchangeConnectionSelect,
    });
  }

  public find(workspaceId: string, connectionId: string) {
    return this.prisma.exchangeConnection.findFirst({
      where: { id: connectionId, workspaceId, revokedAt: null },
      select: {
        id: true,
        exchange: true,
        label: true,
        environment: true,
      },
    });
  }

  public findWithCredentials(workspaceId: string, connectionId: string) {
    return this.prisma.exchangeConnection.findFirst({
      where: { id: connectionId, workspaceId, revokedAt: null },
      select: {
        id: true,
        exchange: true,
        label: true,
        environment: true,
        encryptedApiKey: true,
        encryptedApiSecret: true,
        credentialRevision: true,
      },
    });
  }

  public async create(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    exchange: "bybit";
    label: string;
    environment: PersistedEnvironment;
    encryptedApiKey: Uint8Array<ArrayBuffer>;
    encryptedApiSecret: Uint8Array<ArrayBuffer>;
    apiKeyHint: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const connection = await transaction.exchangeConnection.create({
        data: {
          workspaceId: input.workspaceId,
          exchange: input.exchange,
          label: input.label,
          environment: input.environment,
          encryptedApiKey: input.encryptedApiKey,
          encryptedApiSecret: input.encryptedApiSecret,
          apiKeyHint: input.apiKeyHint,
          createdByActorId: input.actorId,
        },
        select: exchangeConnectionSelect,
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "exchange.connection.create",
          resourceType: "exchange-connection",
          resourceId: connection.id,
          outcome: "COMPLETED",
          requestId: input.requestId,
          metadata: {
            exchange: input.exchange,
            environment: input.environment,
            label: input.label,
          },
        },
      });
      return connection;
    });
  }

  public async rotateCredentials(input: {
    workspaceId: string;
    connectionId: string;
    actorId: string;
    requestId: string;
    encryptedApiKey: Uint8Array<ArrayBuffer>;
    encryptedApiSecret: Uint8Array<ArrayBuffer>;
    apiKeyHint: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await lockExchangeConnection(
        transaction,
        input.workspaceId,
        input.connectionId,
      );
      await assertConnectionNotInUse(transaction, input.workspaceId, existing.id);
      const connection = await transaction.exchangeConnection.update({
        where: { id: existing.id },
        data: {
          encryptedApiKey: input.encryptedApiKey,
          encryptedApiSecret: input.encryptedApiSecret,
          apiKeyHint: input.apiKeyHint,
          status: "UNVERIFIED",
          readOnly: null,
          tradingPermission: null,
          ipBound: null,
          accountUid: null,
          permissions: Prisma.DbNull,
          lastVerificationCode: null,
          lastVerificationMessage: null,
          lastVerifiedAt: null,
          lastVerificationAttemptAt: null,
          nextVerificationAt: null,
          verificationLeaseOwner: null,
          verificationLeaseExpiresAt: null,
          credentialRevision: { increment: 1 },
        },
        select: exchangeConnectionSelect,
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "exchange.connection.credentials.rotate",
          resourceType: "exchange-connection",
          resourceId: connection.id,
          outcome: "COMPLETED",
          requestId: input.requestId,
        },
      });
      return connection;
    });
  }

  public async recordVerification(input: {
    workspaceId: string;
    connectionId: string;
    actorId: string;
    requestId: string;
    status: "ACTIVE" | "INVALID";
    code: string;
    message: string;
    readOnly: boolean | null;
    tradingPermission: boolean | null;
    ipBound: boolean | null;
    accountUid: string | null;
    permissions: Record<string, string[]> | null;
    verifiedAt: Date;
    nextVerificationAt: Date | null;
    expectedCredentialRevision: number;
    leaseOwner?: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await lockExchangeConnection(
        transaction,
        input.workspaceId,
        input.connectionId,
      );
      assertVerificationOwnership(existing, input.expectedCredentialRevision, input.leaseOwner);
      const affectedDeployments =
        input.status === "INVALID"
          ? await transaction.deployment.findMany({
              where: {
                workspaceId: input.workspaceId,
                exchangeConnectionId: existing.id,
                status: { in: ["READY", "RUNNING", "PAUSED"] },
              },
              select: { id: true, strategyId: true, status: true },
            })
          : [];
      const connection = await transaction.exchangeConnection.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          readOnly: input.readOnly,
          tradingPermission: input.tradingPermission,
          ipBound: input.ipBound,
          accountUid: input.accountUid,
          permissions: input.permissions ?? Prisma.DbNull,
          lastVerificationCode: input.code,
          lastVerificationMessage: input.message,
          lastVerifiedAt: input.verifiedAt,
          lastVerificationAttemptAt: input.verifiedAt,
          nextVerificationAt: input.nextVerificationAt,
          verificationLeaseOwner: null,
          verificationLeaseExpiresAt: null,
        },
        select: exchangeConnectionSelect,
      });
      if (input.status === "INVALID" && affectedDeployments.length > 0) {
        const readyIds = affectedDeployments
          .filter((deployment) => deployment.status === "READY")
          .map((deployment) => deployment.id);
        const runningIds = affectedDeployments
          .filter((deployment) => deployment.status === "RUNNING")
          .map((deployment) => deployment.id);
        if (readyIds.length > 0) {
          await transaction.deployment.updateMany({
            where: { workspaceId: input.workspaceId, id: { in: readyIds }, status: "READY" },
            data: { status: "FAILED" },
          });
        }
        if (runningIds.length > 0) {
          await transaction.deployment.updateMany({
            where: { workspaceId: input.workspaceId, id: { in: runningIds }, status: "RUNNING" },
            data: { status: "PAUSED" },
          });
          await transaction.strategy.updateMany({
            where: {
              workspaceId: input.workspaceId,
              id: {
                in: affectedDeployments
                  .filter((deployment) => deployment.status === "RUNNING")
                  .map((deployment) => deployment.strategyId),
              },
              status: "DEPLOYED",
            },
            data: { status: "PAUSED", updatedByActorId: input.actorId },
          });
        }
      }
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "exchange.connection.verify",
          resourceType: "exchange-connection",
          resourceId: input.connectionId,
          outcome: input.status === "ACTIVE" ? "COMPLETED" : "REJECTED",
          requestId: input.requestId,
          metadata: {
            status: input.status,
            code: input.code,
            readOnly: input.readOnly,
            tradingPermission: input.tradingPermission,
            ipBound: input.ipBound,
            permissionGroups: input.permissions ? Object.keys(input.permissions) : [],
            affectedDeploymentIds: affectedDeployments.map((deployment) => deployment.id),
          },
        },
      });
      return transaction.exchangeConnection.findUniqueOrThrow({
        where: { id: connection.id },
        select: exchangeConnectionSelect,
      });
    });
  }

  public async claimDueVerification(input: { workerId: string; now: Date; leaseExpiresAt: Date }) {
    const claimed = await this.prisma.$queryRaw<
      Array<{
        id: string;
        workspaceId: string;
        exchange: string;
        label: string;
        environment: PersistedEnvironment;
        encryptedApiKey: Uint8Array | null;
        encryptedApiSecret: Uint8Array | null;
        credentialRevision: number;
      }>
    >(Prisma.sql`
      WITH candidate AS (
        SELECT "id"
        FROM "ExchangeConnection"
        WHERE "status" = 'ACTIVE'
          AND "revokedAt" IS NULL
          AND "encryptedApiKey" IS NOT NULL
          AND "encryptedApiSecret" IS NOT NULL
          AND "nextVerificationAt" IS NOT NULL
          AND "nextVerificationAt" <= ${input.now}
          AND ("verificationLeaseExpiresAt" IS NULL OR "verificationLeaseExpiresAt" <= ${input.now})
        ORDER BY "nextVerificationAt" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "ExchangeConnection" AS connection
      SET "verificationLeaseOwner" = ${input.workerId},
          "verificationLeaseExpiresAt" = ${input.leaseExpiresAt},
          "updatedAt" = ${input.now}
      FROM candidate
      WHERE connection."id" = candidate."id"
      RETURNING connection."id", connection."workspaceId", connection."exchange",
        connection."label", connection."environment", connection."encryptedApiKey",
        connection."encryptedApiSecret", connection."credentialRevision"
    `);
    return claimed[0] ?? null;
  }

  public async recordVerificationUnavailable(input: {
    workspaceId: string;
    connectionId: string;
    expectedCredentialRevision: number;
    leaseOwner?: string;
    attemptedAt: Date;
    nextVerificationAt: Date;
    code: string;
    message: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await lockExchangeConnection(
        transaction,
        input.workspaceId,
        input.connectionId,
      );
      assertVerificationOwnership(existing, input.expectedCredentialRevision, input.leaseOwner);
      return transaction.exchangeConnection.update({
        where: { id: existing.id },
        data: {
          lastVerificationCode: input.code,
          lastVerificationMessage: input.message,
          lastVerificationAttemptAt: input.attemptedAt,
          nextVerificationAt: input.nextVerificationAt,
          verificationLeaseOwner: null,
          verificationLeaseExpiresAt: null,
        },
        select: exchangeConnectionSelect,
      });
    });
  }

  public async revoke(input: {
    workspaceId: string;
    connectionId: string;
    actorId: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await lockExchangeConnection(
        transaction,
        input.workspaceId,
        input.connectionId,
      );
      await assertConnectionNotInUse(transaction, input.workspaceId, existing.id);
      const revoked = await transaction.exchangeConnection.updateMany({
        where: { id: existing.id, workspaceId: input.workspaceId, revokedAt: null },
        data: {
          revokedAt: new Date(),
          encryptedApiKey: null,
          encryptedApiSecret: null,
        },
      });
      if (revoked.count !== 1) throw new ExchangeConnectionNotFoundError();
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "exchange.connection.revoke",
          resourceType: "exchange-connection",
          resourceId: input.connectionId,
          outcome: "COMPLETED",
          requestId: input.requestId,
        },
      });
    });
  }
}

async function lockExchangeConnection(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  connectionId: string,
) {
  const connections = await transaction.$queryRaw<
    Array<{
      id: string;
      credentialRevision: number;
      verificationLeaseOwner: string | null;
    }>
  >(Prisma.sql`
    SELECT "id", "credentialRevision", "verificationLeaseOwner"
    FROM "ExchangeConnection"
    WHERE "id" = ${connectionId} AND "workspaceId" = ${workspaceId} AND "revokedAt" IS NULL
    FOR UPDATE
  `);
  const connection = connections[0];
  if (!connection) throw new ExchangeConnectionNotFoundError();
  return connection;
}

function assertVerificationOwnership(
  connection: { credentialRevision: number; verificationLeaseOwner: string | null },
  expectedCredentialRevision: number,
  leaseOwner?: string,
) {
  if (connection.credentialRevision !== expectedCredentialRevision) {
    throw new ExchangeConnectionVerificationConflictError();
  }
  if (leaseOwner && connection.verificationLeaseOwner !== leaseOwner) {
    throw new ExchangeConnectionVerificationLeaseLostError();
  }
}

async function assertConnectionNotInUse(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  connectionId: string,
) {
  const deployment = await transaction.deployment.findFirst({
    where: {
      workspaceId,
      exchangeConnectionId: connectionId,
      status: { in: ["READY", "RUNNING", "PAUSED"] },
    },
    select: { id: true },
  });
  if (deployment) throw new ExchangeConnectionInUseError();
}
