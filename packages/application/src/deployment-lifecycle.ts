export const deploymentStatuses = [
  "draft",
  "ready",
  "running",
  "paused",
  "stopped",
  "failed",
] as const;

export type DeploymentLifecycleStatus = (typeof deploymentStatuses)[number];

export const deploymentCommands = ["start", "pause", "resume", "stop"] as const;
export type DeploymentCommand = (typeof deploymentCommands)[number];

export const executionEngineVersion = "cryptoanal-execution@0.2.0";

const allowedCommands: Record<DeploymentLifecycleStatus, readonly DeploymentCommand[]> = {
  draft: [],
  ready: ["start"],
  running: ["pause", "stop"],
  paused: ["resume", "stop"],
  stopped: ["start"],
  failed: [],
};

export function canApplyDeploymentCommand(
  status: DeploymentLifecycleStatus,
  command: DeploymentCommand,
): boolean {
  return allowedCommands[status].includes(command);
}

export function getDeploymentCommands(status: DeploymentLifecycleStatus): DeploymentCommand[] {
  return [...allowedCommands[status]];
}
