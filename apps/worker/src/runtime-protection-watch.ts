import { forEachConcurrent } from "./runtime-price-processor";

export class RuntimeProtectionPreempted extends Error {}
type Waiting = {
  protect: () => Promise<boolean>;
  abort: AbortController;
  running: boolean;
  preempted: boolean;
};

export class RuntimeProtectionWatch {
  private readonly waiting = new Map<string, Waiting>();
  public get size() {
    return this.waiting.size;
  }
  public async during<T>(
    key: string,
    protect: () => Promise<boolean>,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    if (this.waiting.has(key)) throw new Error("Duplicate position wait");
    const entry: Waiting = {
      protect,
      abort: new AbortController(),
      running: false,
      preempted: false,
    };
    this.waiting.set(key, entry);
    try {
      const result = await work(entry.abort.signal);
      if (entry.preempted) throw new RuntimeProtectionPreempted();
      return result;
    } catch (error) {
      if (entry.preempted) throw new RuntimeProtectionPreempted();
      throw error;
    } finally {
      this.waiting.delete(key);
    }
  }
  public async poll(concurrency: number, onError: (error: unknown) => void) {
    await forEachConcurrent([...this.waiting.values()], concurrency, async (entry) => {
      if (entry.running || entry.preempted) return;
      entry.running = true;
      try {
        if (await entry.protect()) {
          entry.preempted = true;
          entry.abort.abort();
        }
      } catch (error) {
        onError(error);
      } finally {
        entry.running = false;
      }
    });
  }
}
