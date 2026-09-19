export class OrderedPriceJournal<T> {
  private readonly pending: T[] = [];
  private inFlight: Promise<void> | null = null;
  public healthy = true;

  public constructor(
    private readonly write: (events: T[]) => Promise<void>,
    private readonly capacity = 20_000,
  ) {}

  public enqueue(event: T): boolean {
    if (this.pending.length >= this.capacity) {
      this.healthy = false;
      return false;
    }
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
    const batch = this.pending.slice(0, 2000);
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
