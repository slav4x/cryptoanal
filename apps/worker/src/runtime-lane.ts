import { forEachConcurrent } from "./runtime-price-processor";

export type RuntimeLaneTiming = { loadMs: number; queueMs: number };

export async function runRuntimeLane<T>(input: {
  stopping: () => boolean;
  load: () => Promise<T[]>;
  process: (item: T, timing: RuntimeLaneTiming) => Promise<void>;
  onError: (error: unknown, item?: T) => Promise<void> | void;
  concurrency: number;
  intervalMs: number;
  wait: (milliseconds: number) => Promise<unknown>;
  clock?: () => number;
}) {
  const clock = input.clock ?? (() => performance.now());
  while (!input.stopping()) {
    const started = clock();
    try {
      const items = await input.load();
      const loadedAt = clock();
      await forEachConcurrent(items, input.concurrency, async (item) => {
        try {
          await input.process(item, { loadMs: loadedAt - started, queueMs: clock() - loadedAt });
        } catch (error) {
          await input.onError(error, item);
        }
      });
    } catch (error) {
      await input.onError(error);
    }
    await input.wait(Math.max(1, input.intervalMs - (clock() - started)));
  }
}
