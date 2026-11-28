import {nativeQuotaReportSchema, type NativeQuotaTarget, type NativeQuotaView} from './native-quota-wire.js';

export type NativeQuotaCandidate = NativeQuotaTarget & {label?:string};

const maxAge = 5 * 60_000;
const retryDelay = 60_000;
const key = ({hostId, executorId, accountId}:NativeQuotaTarget) => JSON.stringify([hostId, executorId, accountId]);

export class NativeQuota {
  private readonly cache = new Map<string, NativeQuotaView>();
  private readonly retryAfter = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly hostTail = new Map<string, Promise<void>>();

  constructor(
    private readonly targets: () => Promise<NativeQuotaCandidate[]>,
    private readonly collect: (target: NativeQuotaTarget) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  async inventory() {
    const targets = await this.targets();
    const current = new Set(targets.map(key));
    for (const cache of [this.cache,this.retryAfter])
      for (const id of cache.keys()) if (!current.has(id)) cache.delete(id);
    return targets;
  }

  private read(target: NativeQuotaTarget): NativeQuotaView | null {
    const value = this.cache.get(key(target));
    const now = this.now();
    if(!value || value.observedAt + maxAge <= now) return null;
    const rows = value.rows.filter(row => row.resetAt > now);
    return rows.length ? {observedAt:value.observedAt, rows} : null;
  }

  readAccount(candidates: NativeQuotaTarget[]) {
    let latest: NativeQuotaView | null = null;
    for (const candidate of candidates) {
      const quota = this.read(candidate);
      if (quota && (!latest || quota.observedAt > latest.observedAt)) latest = quota;
    }
    return latest;
  }

  async refreshAccount(candidates: NativeQuotaTarget[], force = false) {
    const now = this.now();
    if (!force && candidates.some(candidate => {
      const quota = this.cache.get(key(candidate));
      return quota && quota.observedAt + maxAge > now && quota.rows.every(row => row.resetAt > now);
    })) return;
    for (const candidate of candidates) {
      await this.refresh(candidate);
      if (this.read(candidate)) return;
    }
  }

  private async refresh(target: NativeQuotaTarget) {
    const id = key(target);
    const current = this.inFlight.get(id);
    if(current) return current;
    const previous = this.hostTail.get(target.hostId) ?? Promise.resolve();
    const work = previous.then(async () => {
      try {
        const now = this.now();
        if ((this.retryAfter.get(id) ?? 0) > now) return;
        if (!(await this.inventory()).some(candidate => key(candidate) === id)) return;
        this.retryAfter.set(id, now + retryDelay);
        const {hostId,executorId,accountId} = target;
        const report = nativeQuotaReportSchema.parse(await this.collect({hostId,executorId,accountId}));
        const at = this.now();
        if (key(report) !== id || report.observedAt > at || at - report.observedAt >= maxAge) return;
        if (!(await this.inventory()).some(candidate => key(candidate) === id)) return;
        this.cache.set(id, {observedAt:report.observedAt, rows:report.rows});
      } catch {
        this.retryAfter.set(id, this.now() + retryDelay);
      } finally {
        this.inFlight.delete(id);
        if (this.hostTail.get(target.hostId) === work) this.hostTail.delete(target.hostId);
      }
    });
    this.inFlight.set(id, work);
    this.hostTail.set(target.hostId, work);
    return work;
  }
}
