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
  createdAt: true,
  updatedAt: true,
} as const;

export class ExchangeConnectionNotFoundError extends Error {}

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
      const existing = await transaction.exchangeConnection.findFirst({
        where: { id: input.connectionId, workspaceId: input.workspaceId, revokedAt: null },
        select: { id: true },
      });
      if (!existing) throw new ExchangeConnectionNotFoundError();
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
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.exchangeConnection.findFirst({
        where: { id: input.connectionId, workspaceId: input.workspaceId, revokedAt: null },
        select: { id: true },
      });
      if (!existing) throw new ExchangeConnectionNotFoundError();
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
        },
        select: exchangeConnectionSelect,
      });
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
          },
        },
      });
      return connection;
    });
  }

  public async revoke(input: {
    workspaceId: string;
    connectionId: string;
    actorId: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const revoked = await transaction.exchangeConnection.updateMany({
        where: { id: input.connectionId, workspaceId: input.workspaceId, revokedAt: null },
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
