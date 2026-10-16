import { evaluateExecutionHoldingExit } from "@cryptoanal/application";
import {
  evaluateExecutionPriceExit,
  type ExecutionPosition,
  type ExecutionStrategyConfig,
} from "@cryptoanal/application";
import type { RuntimePriceEvent } from "./runtime-price-processor";

export function selectPriorityExit(input: {
  position: ExecutionPosition;
  through: Date;
  events: RuntimePriceEvent[];
  latest: RuntimePriceEvent;
  config: ExecutionStrategyConfig;
}) {
  const candidates = input.events.filter((event) => event.id <= input.latest.id);
  if (input.latest.id > (candidates.at(-1)?.id ?? 0n)) candidates.push(input.latest);
  for (const event of candidates) {
    if (event.observedAt < input.through || event.observedAt < input.position.openedAt) continue;
    const settlement =
      evaluateExecutionPriceExit(input.position, { ...event, source: "LastPrice" }, input.config) ??
      evaluateExecutionHoldingExit(input.position, { ...event, source: "LastPrice" }, input.config);
    if (settlement) return { event, settlement };
  }
  return null;
}
