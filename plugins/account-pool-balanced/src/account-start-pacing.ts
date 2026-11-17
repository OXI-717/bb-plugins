/**
 * Local preventive start pacing, independent of upstream quota and cooldown.
 *
 * Normal operation: a burst no larger than `burst` may start together, after which
 * starts continue at one per interval. After a provider hold the account recovers
 * conservatively: for a minute its starts leave one by one, at least a second apart,
 * so the requests the hold was delaying never return as a burst.
 */
interface Bucket { tokens: number; at: number }

/** Spacing floor and duration applied after a provider hold. Not a provider limit. */
export const RECOVERY_INTERVAL_MS = 1_000;
export const RECOVERY_WINDOW_MS = 60_000;

export class AccountStartPacing {
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    private readonly interval: () => number,
    private readonly now: () => number,
    /** Starts that may leave together after an idle period. One keeps strict spacing. */
    private readonly burst: () => number = () => 1,
  ) {}

  private recovering(heldUntil: number | null, now: number): boolean {
    return heldUntil !== null && now < heldUntil + RECOVERY_WINDOW_MS;
  }

  /** A disabled interval stays disabled: recovery never introduces pacing by itself. */
  private spacing(heldUntil: number | null, now: number): number {
    const interval = this.interval();
    if (!(interval > 0)) return 0;
    return this.recovering(heldUntil, now) ? Math.max(interval, RECOVERY_INTERVAL_MS) : interval;
  }

  private capacity(heldUntil: number | null, now: number): number {
    if (this.recovering(heldUntil, now)) return 1;
    const value = Math.floor(this.burst());
    return Number.isFinite(value) && value >= 1 ? value : 1;
  }

  /** `heldUntil` is the account's current or latest provider hold, when one is known. */
  readyAt(id: string, heldUntil: number | null = null): number | null {
    const bucket = this.buckets.get(id);
    if (bucket === undefined) return null;
    const now = this.now();
    const spacing = this.spacing(heldUntil, now);
    if (spacing === 0) return bucket.at;
    // Credit saved before a hold is forfeited by that hold.
    const tokens = Math.min(bucket.tokens, this.capacity(heldUntil, now) - 1);
    return bucket.at + Math.ceil((1 - tokens) * spacing);
  }

  /** Called synchronously under the account snapshot, immediately before dispatch. */
  dispatched(id: string, heldUntil: number | null = null): void {
    const now = this.now();
    const spacing = this.spacing(heldUntil, now);
    const capacity = this.capacity(heldUntil, now);
    // A refilled bucket carries no information: forget it instead of growing without bound.
    const idle = Math.max(RECOVERY_WINDOW_MS, this.interval() * Math.max(1, Math.floor(this.burst()) || 1));
    for (const [key, bucket] of this.buckets) if (now - bucket.at >= idle) this.buckets.delete(key);
    const bucket = this.buckets.get(id);
    const level = bucket === undefined || spacing === 0
      ? capacity
      : Math.min(capacity, Math.min(bucket.tokens, capacity - 1) + (now - bucket.at) / spacing);
    this.buckets.set(id, { tokens: level - 1, at: now });
  }

  clear(): void { this.buckets.clear(); }
}
