export type RequestContext = {
  actorId: string;
  workspaceId: string;
  role: "owner" | "member" | "system";
  requestId: string;
};

export * from "./market-analysis";
export * from "./strategy-lifecycle";

export type DevelopmentIdentity = Pick<RequestContext, "actorId" | "workspaceId" | "role">;

export function createDevelopmentContext(
  identity: DevelopmentIdentity,
  requestId: string,
): RequestContext {
  return {
    ...identity,
    requestId,
  };
}
