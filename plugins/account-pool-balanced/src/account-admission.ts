export const ACCOUNT_QUEUE_MAX_WAIT_MS = 15 * 60_000;

/** One server owns the queue shared by native and external callers on all hosts. */
export class AdmissionUnavailable extends Error {
  constructor(readonly code: 'POOL_QUEUE_FULL' | 'POOL_QUEUE_TIMEOUT') {
    super(code === 'POOL_QUEUE_FULL' ? 'Account request queue is full.' : 'Account request queue deadline exceeded.');
  }
}
interface Waiter { grant: () => void; cancel: (reason: unknown) => void }
interface Lane { active: number; waiting: Waiter[] }
export class AccountAdmission {
  private readonly lanes = new Map<string, Lane>();
  private queued = 0;
  private readonly cooldownWakeups = new Set<() => void>();
  constructor(private readonly limit: () => number, private readonly now = Date.now,
    private readonly maxWaitMs = ACCOUNT_QUEUE_MAX_WAIT_MS, private readonly maxPerAccount = 64,
    private readonly maxQueued = 1024) {}
  reserved(id: string): number { return this.lanes.get(id)?.active ?? 0; }
  waiting(id: string): number { return this.lanes.get(id)?.waiting.length ?? 0; }
  /** Apply a persisted live limit to every already-waiting account lane. */
  limitsChanged(): void {
    for (const [id, lane] of this.lanes) this.pump(id, lane);
    for (const wake of [...this.cooldownWakeups]) wake();
  }
  async acquire(id: string, signal: AbortSignal, cooldown: () => number | null, deadline = this.now() + this.maxWaitMs): Promise<() => void> {
    signal.throwIfAborted();
    if (this.now() >= deadline) throw new AdmissionUnavailable('POOL_QUEUE_TIMEOUT');
    let lane = this.lanes.get(id);
    if (!lane) {
      lane = {active: 0, waiting: []};
      this.lanes.set(id, lane);
    }
    const current = lane;
    if ((current.active >= this.limit() || current.waiting.length > 0) && (current.waiting.length >= this.maxPerAccount || this.queued >= this.maxQueued)) {
      if (!current.active && !current.waiting.length) this.lanes.delete(id);
      throw new AdmissionUnavailable('POOL_QUEUE_FULL');
    }
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (reason?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        const index = current.waiting.indexOf(waiter);
        if (index >= 0) { current.waiting.splice(index, 1); this.queued--; }
        if (reason === undefined) { current.active++; resolve(); }
        else reject(reason);
        this.pump(id, current);
      };
      const waiter: Waiter = {grant: () => finish(), cancel: reason => finish(reason)};
      const abort = () => waiter.cancel(signal.reason ?? new Error('Request canceled.'));
      const timer = setTimeout(() => waiter.cancel(new AdmissionUnavailable('POOL_QUEUE_TIMEOUT')), Math.max(0, deadline - this.now()));
      current.waiting.push(waiter); this.queued++;
      signal.addEventListener('abort', abort, {once: true});
      this.pump(id, current);
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true; current.active--; this.pump(id, current);
    };
    try {
      await this.waitCooldown(signal, cooldown, deadline);
      return release;
    } catch (error) { release(); throw error; }
  }
  /** Recheck again after asynchronous network/policy guards, just before dispatch. */
  async waitCooldown(signal: AbortSignal, cooldown: () => number | null, deadline = this.now() + this.maxWaitMs): Promise<boolean> {
    let waited = false;
    while (true) {
      signal.throwIfAborted();
      const now = this.now(), remaining = (cooldown() ?? 0) - now;
      if (now >= deadline) throw new AdmissionUnavailable('POOL_QUEUE_TIMEOUT');
      if (remaining <= 0) return waited;
      waited = true;
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (reason?: unknown) => {
          if (done) return;
          done = true; clearTimeout(timer);
          signal.removeEventListener('abort', abort); this.cooldownWakeups.delete(wake);
          if (reason === undefined) resolve(); else reject(reason);
        };
        const wake = () => finish();
        const abort = () => finish(signal.reason ?? new Error('Request canceled.'));
        const timer = setTimeout(wake, Math.min(remaining, deadline - now, 2_147_483_647));
        this.cooldownWakeups.add(wake);
        signal.addEventListener('abort', abort, {once: true});
      });
    }
  }
  private pump(id: string, lane: Lane): void {
    while (lane.active < this.limit() && lane.waiting.length) lane.waiting[0]!.grant();
    if (!lane.active && !lane.waiting.length) this.lanes.delete(id);
  }
}
