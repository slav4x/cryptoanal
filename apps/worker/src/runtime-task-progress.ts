type Lane = "position" | "entry" | "funding";
type Active = { lane: Lane; key: string; startedAt: string; tick: number };
type Completed = {
  completed: number;
  failed: number;
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
};
export class RuntimeTaskProgress {
  private readonly active = new Map<string, Active>();
  private readonly lanes = new Map<Lane, Completed>();
  public constructor(
    private readonly clock = Date.now,
    private readonly tick = () => performance.now(),
  ) {}
  public async during<T>(lane: Lane, key: string, work: () => Promise<T>): Promise<T> {
    const id = `${lane}:${key}`;
    if (this.active.has(id)) throw new Error("Duplicate runtime task");
    const item = { lane, key, startedAt: new Date(this.clock()).toISOString(), tick: this.tick() };
    this.active.set(id, item);
    const totals = this.lanes.get(lane) ?? {
      completed: 0,
      failed: 0,
      lastCompletedAt: null,
      lastFailedAt: null,
    };
    this.lanes.set(lane, totals);
    try {
      const result = await work();
      totals.completed++;
      totals.lastCompletedAt = new Date(this.clock()).toISOString();
      return result;
    } catch (error) {
      totals.failed++;
      totals.lastFailedAt = new Date(this.clock()).toISOString();
      throw error;
    } finally {
      this.active.delete(id);
    }
  }
  public snapshot() {
    const now = this.tick();
    return {
      sampledAt: new Date(this.clock()).toISOString(),
      active: [...this.active.values()].map(({ tick, ...item }) => ({
        ...item,
        ageMs: Math.max(0, now - tick),
      })),
      lanes: Object.fromEntries([...this.lanes].map(([lane, value]) => [lane, { ...value }])),
    };
  }
}
