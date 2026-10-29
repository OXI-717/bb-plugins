/** Local preventive start spacing, independent of upstream quota and cooldown. */
export class AccountStartPacing {
  private readonly lastStarts = new Map<string, number>();
  constructor(private readonly interval: () => number, private readonly now: () => number) {}
  readyAt(id: string): number | null {
    const last = this.lastStarts.get(id);
    return last === undefined ? null : last + this.interval();
  }
  /** Called synchronously under the account snapshot, immediately before dispatch. */
  dispatched(id: string): void {
    const now = this.now();
    // Settings are bounded at 60 seconds: expired entries cannot affect future starts.
    for (const [key, at] of this.lastStarts) if (now - at >= 60_000) this.lastStarts.delete(key);
    this.lastStarts.set(id, now);
  }
  clear(): void { this.lastStarts.clear(); }
}
