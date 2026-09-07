import type { CryptoAnalPrismaClient } from "./client";

export class WorkspaceRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async listOperationalIds() {
    const workspaces = await this.prisma.workspace.findMany({
      where: {
        memberships: { some: { user: { disabledAt: null } } },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    return workspaces.map((workspace) => workspace.id);
  }
}
