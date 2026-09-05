export const strategyStatuses = [
  "draft",
  "validating",
  "approved",
  "deployed",
  "paused",
  "archived",
] as const;

export type StrategyLifecycleStatus = (typeof strategyStatuses)[number];

export const strategyStatusTransitions: Record<
  StrategyLifecycleStatus,
  readonly StrategyLifecycleStatus[]
> = {
  draft: ["validating", "archived"],
  validating: ["draft", "approved", "archived"],
  approved: ["draft", "deployed", "archived"],
  deployed: ["paused", "approved"],
  paused: ["deployed", "approved", "archived"],
  archived: ["draft"],
};

export function canTransitionStrategyStatus(
  from: StrategyLifecycleStatus,
  to: StrategyLifecycleStatus,
): boolean {
  return strategyStatusTransitions[from].includes(to);
}
