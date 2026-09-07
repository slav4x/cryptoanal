import type { CryptoAnalPrismaClient } from "./client";

export class AuthWorkspaceAccessDeniedError extends Error {}

export class AuthRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async findUserForLogin(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        displayName: true,
        passwordHash: true,
        disabledAt: true,
        memberships: {
          orderBy: { createdAt: "asc" },
          select: {
            role: true,
            workspace: { select: { id: true, slug: true, name: true } },
          },
        },
      },
    });
  }

  public async createSession(input: {
    tokenHash: string;
    userId: string;
    workspaceId: string;
    expiresAt: Date;
    userAgent: string | null;
    ipAddress: string | null;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const session = await transaction.session.create({
        data: {
          tokenHash: input.tokenHash,
          userId: input.userId,
          activeWorkspaceId: input.workspaceId,
          expiresAt: input.expiresAt,
          userAgent: input.userAgent,
          ipAddress: input.ipAddress,
        },
        select: { id: true },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: "auth.session.create",
          resourceType: "session",
          resourceId: session.id,
          outcome: "COMPLETED",
          requestId: input.requestId,
        },
      });
      return session;
    });
  }

  public async findActiveSession(tokenHash: string, now = new Date()) {
    const session = await this.prisma.session.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
        user: { disabledAt: null },
      },
      select: {
        id: true,
        expiresAt: true,
        lastSeenAt: true,
        activeWorkspaceId: true,
        activeWorkspace: { select: { id: true, slug: true, name: true } },
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            memberships: {
              orderBy: { createdAt: "asc" },
              select: {
                role: true,
                workspace: { select: { id: true, slug: true, name: true } },
              },
            },
          },
        },
      },
    });
    if (!session) return null;
    const activeMembership = session.user.memberships.find(
      (membership) => membership.workspace.id === session.activeWorkspaceId,
    );
    return activeMembership ? { ...session, activeMembership } : null;
  }

  public async touchSession(sessionId: string, now = new Date()) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null, expiresAt: { gt: now } },
      data: { lastSeenAt: now },
    });
  }

  public async revokeSession(input: {
    sessionId: string;
    workspaceId: string;
    actorId: string;
    requestId: string;
  }) {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.session.updateMany({
        where: { id: input.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "auth.session.revoke",
          resourceType: "session",
          resourceId: input.sessionId,
          outcome: "COMPLETED",
          requestId: input.requestId,
        },
      });
    });
  }

  public async switchWorkspace(input: {
    sessionId: string;
    userId: string;
    workspaceId: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const membership = await transaction.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId },
        },
        select: {
          role: true,
          workspace: { select: { id: true, slug: true, name: true } },
        },
      });
      if (!membership) throw new AuthWorkspaceAccessDeniedError();
      await transaction.session.update({
        where: { id: input.sessionId },
        data: { activeWorkspaceId: input.workspaceId, lastSeenAt: new Date() },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: "auth.workspace.switch",
          resourceType: "workspace",
          resourceId: input.workspaceId,
          outcome: "COMPLETED",
          requestId: input.requestId,
        },
      });
      return membership;
    });
  }
}
