type Entry<T> = {
  promise?: Promise<T>;
  value?: T;
  expiresAt: number;
  retryAt: number;
  failures: number;
  error?: unknown;
};

export class RecoveryRequestCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  public constructor(
    private readonly now = Date.now,
    private readonly capacity = 128,
    private readonly ttlMs = 10_000,
  ) {}

  public get(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry?.promise) return entry.promise;
    if (entry?.value !== undefined && entry.expiresAt > now) return Promise.resolve(entry.value);
    if (entry && entry.retryAt > now) return Promise.reject(entry.error);
    if (!entry) {
      for (const [oldKey, old] of this.entries) {
        if (!old.promise && old.expiresAt <= now && old.retryAt <= now) this.entries.delete(oldKey);
      }
      if (this.entries.size >= this.capacity) {
        const idle = [...this.entries].find(([, item]) => !item.promise);
        if (!idle) return Promise.reject(new Error("Recovery request capacity reached"));
        this.entries.delete(idle[0]);
      }
      entry = { expiresAt: 0, retryAt: 0, failures: 0 };
      this.entries.set(key, entry);
    }
    const current = entry;
    current.promise = Promise.resolve()
      .then(load)
      .then((value) => {
        current.value = value;
        current.expiresAt = this.now() + this.ttlMs;
        current.retryAt = 0;
        current.failures = 0;
        return value;
      })
      .catch((error: unknown) => {
        current.error = error;
        current.failures += 1;
        current.retryAt =
          this.now() + Math.min(30_000, 2000 * 2 ** Math.min(current.failures - 1, 4));
        throw error;
      })
      .finally(() => {
        delete current.promise;
      });
    return current.promise;
  }
}
