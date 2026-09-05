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

export type StrategyValidationState = {
  strategyVersionId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  verdict: "pending" | "passed" | "failed" | "warning";
};

export type StrategyLifecycleState = {
  status: StrategyLifecycleStatus;
  latestVersionId: string | null;
  validations: readonly StrategyValidationState[];
  hasActiveDeployment: boolean;
};

export type StrategyManualTransition = "draft" | "approved" | "archived";

export function evaluateStrategyLifecycle(state: StrategyLifecycleState) {
  const activeValidation = state.validations.some(
    (validation) => validation.status === "queued" || validation.status === "running",
  );
  const latestVersionPassed = state.validations.some(
    (validation) =>
      validation.strategyVersionId === state.latestVersionId &&
      validation.status === "completed" &&
      validation.verdict === "passed",
  );
  const validationReasons: string[] = [];

  if (!state.latestVersionId) validationReasons.push("У стратегии нет версии конфигурации");
  if (state.status !== "draft") {
    validationReasons.push("Для новой проверки стратегия должна быть в статусе «Черновик»");
  }
  if (activeValidation) validationReasons.push("Проверка стратегии уже выполняется");
  if (state.hasActiveDeployment) validationReasons.push("Сначала остановите активный deployment");

  const candidateTargets = strategyStatusTransitions[state.status].filter(
    (status): status is StrategyManualTransition =>
      status === "draft" || status === "approved" || status === "archived",
  );

  return {
    validation: {
      eligible: validationReasons.length === 0,
      reasons: validationReasons,
    },
    transitions: candidateTargets.map((target) => {
      let reason: string | null = null;
      if (target === "approved" && state.hasActiveDeployment) {
        reason = "Сначала остановите активный deployment";
      } else if (target === "approved" && !latestVersionPassed) {
        reason = "Последняя версия не имеет успешно завершённой проверки";
      } else if ((target === "draft" || target === "archived") && activeValidation) {
        reason = "Дождитесь завершения активной проверки";
      } else if (target === "archived" && state.hasActiveDeployment) {
        reason = "Сначала остановите активный deployment";
      }

      return { target, allowed: reason === null, reason };
    }),
  };
}
