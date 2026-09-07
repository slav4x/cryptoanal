import type { CryptoAnalPrismaClient } from "./client";

export class AuthWorkspaceAccessDeniedError extends Error {}
export class AuthWorkspaceLimitReachedError extends Error {}
export class AuthInvitationInvalidError extends Error {}
export class AuthInvitationMembershipExistsError extends Error {}
export class AuthMemberNotFoundError extends Error {}
export class AuthLastOwnerError extends Error {}

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

  public async createWorkspace(input: {
    sessionId: string;
    userId: string;
    name: string;
    slug: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const membershipCount = await transaction.workspaceMembership.count({
        where: { userId: input.userId },
      });
      if (membershipCount >= 20) throw new AuthWorkspaceLimitReachedError();

      const workspace = await transaction.workspace.create({
        data: {
          name: input.name,
          slug: input.slug,
          settings: { create: {} },
          memberships: { create: { userId: input.userId, role: "OWNER" } },
        },
        select: { id: true, slug: true, name: true },
      });
      await transaction.session.update({
        where: { id: input.sessionId, userId: input.userId },
        data: { activeWorkspaceId: workspace.id, lastSeenAt: new Date() },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: "workspace.create",
          resourceType: "workspace",
          resourceId: workspace.id,
          outcome: "COMPLETED",
          requestId: input.requestId,
          metadata: { name: workspace.name, slug: workspace.slug },
        },
      });
      return workspace;
    });
  }

  public async getWorkspaceAccess(workspaceId: string) {
    const [members, invitations] = await Promise.all([
      this.prisma.workspaceMembership.findMany({
        where: { workspaceId },
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
        select: {
          role: true,
          createdAt: true,
          user: { select: { id: true, email: true, displayName: true, disabledAt: true } },
        },
      }),
      this.prisma.workspaceInvitation.findMany({
        where: { workspaceId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      }),
    ]);
    return { members, invitations };
  }

  public async createInvitation(input: {
    workspaceId: string;
    email: string;
    role: "OWNER" | "MEMBER";
    tokenHash: string;
    invitedByUserId: string;
    expiresAt: Date;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const existingUser = await transaction.user.findUnique({
        where: { email: input.email },
        select: {
          memberships: {
            where: { workspaceId: input.workspaceId },
            select: { id: true },
          },
        },
      });
      if (existingUser?.memberships.length) throw new AuthInvitationMembershipExistsError();
      await transaction.workspaceInvitation.updateMany({
        where: {
          workspaceId: input.workspaceId,
          email: input.email,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      const invitation = await transaction.workspaceInvitation.create({
        data: {
          workspaceId: input.workspaceId,
          email: input.email,
          role: input.role,
          tokenHash: input.tokenHash,
          invitedByUserId: input.invitedByUserId,
          expiresAt: input.expiresAt,
        },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.invitedByUserId,
          action: "workspace.invitation.create",
          resourceType: "workspace-invitation",
          resourceId: invitation.id,
          outcome: "COMPLETED",
          requestId: input.requestId,
          metadata: { email: input.email, role: input.role },
        },
      });
      return invitation;
    });
  }

  public findPendingInvitation(tokenHash: string, now = new Date()) {
    return this.prisma.workspaceInvitation.findFirst({
      where: { tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      select: {
        id: true,
        email: true,
        role: true,
        tokenHash: true,
        expiresAt: true,
        workspace: { select: { id: true, name: true } },
      },
    });
  }

  public async acceptInvitation(input: {
    invitationId: string;
    tokenHash: string;
    existingUserId: string | null;
    newUser: { email: string; displayName: string; passwordHash: string } | null;
    sessionTokenHash: string;
    sessionExpiresAt: Date;
    userAgent: string | null;
    ipAddress: string | null;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const invitation = await transaction.workspaceInvitation.findFirst({
        where: {
          id: input.invitationId,
          tokenHash: input.tokenHash,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { id: true, email: true, role: true, workspaceId: true },
      });
      if (!invitation) throw new AuthInvitationInvalidError();

      const user = input.existingUserId
        ? await transaction.user.findUnique({
            where: { id: input.existingUserId, disabledAt: null },
            select: { id: true, email: true },
          })
        : input.newUser
          ? await transaction.user.create({
              data: input.newUser,
              select: { id: true, email: true },
            })
          : null;
      if (!user || user.email !== invitation.email) throw new AuthInvitationInvalidError();

      const currentMembership = await transaction.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id } },
        select: { role: true },
      });
      await transaction.workspaceMembership.upsert({
        where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id } },
        update: currentMembership?.role === "OWNER" ? {} : { role: invitation.role },
        create: { workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role },
      });
      const accepted = await transaction.workspaceInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date(), acceptedByUserId: user.id },
      });
      if (accepted.count !== 1) throw new AuthInvitationInvalidError();

      const session = await transaction.session.create({
        data: {
          tokenHash: input.sessionTokenHash,
          userId: user.id,
          activeWorkspaceId: invitation.workspaceId,
          expiresAt: input.sessionExpiresAt,
          userAgent: input.userAgent,
          ipAddress: input.ipAddress,
        },
        select: { id: true },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: invitation.workspaceId,
          actorId: user.id,
          action: "workspace.invitation.accept",
          resourceType: "workspace-invitation",
          resourceId: invitation.id,
          outcome: "COMPLETED",
          requestId: input.requestId,
          metadata: { role: invitation.role },
        },
      });
      return session;
    });
  }

  public async revokeInvitation(input: {
    workspaceId: string;
    invitationId: string;
    actorId: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const revoked = await transaction.workspaceInvitation.updateMany({
        where: {
          id: input.invitationId,
          workspaceId: input.workspaceId,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      if (revoked.count !== 1) throw new AuthInvitationInvalidError();
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "workspace.invitation.revoke",
          resourceType: "workspace-invitation",
          resourceId: input.invitationId,
          outcome: "COMPLETED",
          requestId: input.requestId,
        },
      });
    });
  }

  public async updateMemberRole(input: {
    workspaceId: string;
    userId: string;
    role: "OWNER" | "MEMBER";
    actorId: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const membership = await transaction.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
        select: { role: true },
      });
      if (!membership) throw new AuthMemberNotFoundError();
      if (membership.role === "OWNER" && input.role === "MEMBER") {
        const ownerCount = await transaction.workspaceMembership.count({
          where: { workspaceId: input.workspaceId, role: "OWNER" },
        });
        if (ownerCount <= 1) throw new AuthLastOwnerError();
      }
      await transaction.workspaceMembership.update({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
        data: { role: input.role },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "workspace.member.role.update",
          resourceType: "user",
          resourceId: input.userId,
          outcome: "COMPLETED",
          requestId: input.requestId,
          metadata: { role: input.role },
        },
      });
    });
  }

  public async removeMember(input: {
    workspaceId: string;
    userId: string;
    actorId: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const membership = await transaction.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
        select: { role: true },
      });
      if (!membership) throw new AuthMemberNotFoundError();
      if (membership.role === "OWNER") throw new AuthLastOwnerError();
      await transaction.workspaceMembership.delete({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
      });
      await transaction.session.updateMany({
        where: { userId: input.userId, activeWorkspaceId: input.workspaceId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "workspace.member.remove",
          resourceType: "user",
          resourceId: input.userId,
          outcome: "COMPLETED",
          requestId: input.requestId,
        },
      });
    });
  }
}
