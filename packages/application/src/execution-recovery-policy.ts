export const causalRecoveryModel = "cryptoanal-recovery@causal-v2" as const;
export type ExecutionRecoveryModel = typeof causalRecoveryModel;
export function readExecutionRecoveryModel(value: unknown): ExecutionRecoveryModel | null {
  if (value == null) return null;
  if (value !== causalRecoveryModel) throw new Error("Unknown recovery model");
  return value;
}
