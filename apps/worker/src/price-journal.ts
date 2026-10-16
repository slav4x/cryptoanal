export class OrderedPriceJournal<T> {
  private readonly pending: T[] = [];
  private inFlight: Promise<void> | null = null;
  private overflowing = false;
  public healthy = true;

  public constructor(
    private readonly write: (events: T[]) => Promise<void>,
    private readonly capacity = 20_000,
    private readonly batchSize = 500,
    private readonly onOverflow?: () => void,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000)
      throw new Error("Invalid journal batch size");
  }
  public get size() {
    return this.pending.length;
  }
  public get oldest() {
    return this.pending[0] ?? null;
  }

  public enqueue(event: T): boolean {
    if (this.pending.length >= this.capacity) {
      this.healthy = false;
      if (!this.overflowing) {
        this.overflowing = true;
        this.onOverflow?.();
      }
      return false;
    }
    this.overflowing = false;
    this.pending.push(event);
    return true;
  }

  public flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.drain().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  public async flushAll() {
    while (this.pending.length > 0) await this.flush();
  }

  private async drain() {
    const batch = this.pending.slice(0, this.batchSize);
    if (batch.length === 0) return;
    try {
      await this.write(batch);
      this.pending.splice(0, batch.length);
      this.healthy = this.pending.length < this.capacity;
    } catch (error) {
      this.healthy = false;
      throw error;
    }
  }
}
