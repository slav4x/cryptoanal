import { forEachConcurrent } from "./runtime-price-processor";

export async function runRuntimeLane<T>(input: {
  stopping: () => boolean;
  load: () => Promise<T[]>;
  process: (item: T) => Promise<void>;
  onError: (error: unknown, item?: T) => Promise<void> | void;
  concurrency: number;
  intervalMs: number;
  wait: (milliseconds: number) => Promise<unknown>;
}) {
  while (!input.stopping()) {
    const started = performance.now();
    try {
      const items = await input.load();
      await forEachConcurrent(items, input.concurrency, async (item) => {
        try {
          await input.process(item);
        } catch (error) {
          await input.onError(error, item);
        }
      });
    } catch (error) {
      await input.onError(error);
    }
    await input.wait(Math.max(1, input.intervalMs - (performance.now() - started)));
  }
}
