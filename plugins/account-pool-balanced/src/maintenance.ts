import { z } from 'zod';

export const maintenanceLeaseSchema = z.object({
  owner: z.uuid(), createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  upgrade: z.enum(['draining', 'sealed']).optional(),
}).strict().refine(value => value.expiresAt > value.createdAt && value.expiresAt - value.createdAt <= 1_800_000);
export const maintenanceStatusSchema = z.object({
  schemaVersion: z.literal(1), scope: z.literal('all-model-clients'), transportInFlight:z.number().int().nonnegative(), lease: maintenanceLeaseSchema.nullable(),
}).strict();
type Lease = z.infer<typeof maintenanceLeaseSchema>;

export class PoolMaintenanceError extends Error {
  readonly code = 'POOL_MAINTENANCE';
  constructor() { super('Account Pooler is paused for maintenance.'); }
}

/** Persist before acknowledging admission changes; never clear a foreign pause. */
export class PoolMaintenance {
  private lease: Lease | null = null;
  private controller = new AbortController();
  private readonly upgradeWaiters = new Set<() => void>();
  private writer: Promise<unknown> = Promise.resolve();
  constructor(private persist: (value: Lease | null) => Promise<void>, private now = Date.now, private activity:()=>number=()=>0) {}
  async initialize(raw: unknown) {
    if (raw === undefined || raw === null) return;
    const lease = maintenanceLeaseSchema.parse(raw);
    if (lease.expiresAt <= this.now() || lease.createdAt > this.now()) { await this.persist(null); return; }
    this.lease = lease;
    if (!lease.upgrade) this.controller.abort(new PoolMaintenanceError());
  }
  private currentLease(): Lease | null {
    return this.lease && this.lease.expiresAt > this.now() ? this.lease : null;
  }
  status(): z.infer<typeof maintenanceStatusSchema> {
    const lease = this.currentLease();
    return {schemaVersion: 1, scope: 'all-model-clients', transportInFlight:this.activity(), lease: lease ? {...lease} : null};
  }
  get signal(): AbortSignal {
    if (!this.currentLease() && this.controller.signal.aborted) this.controller = new AbortController();
    return this.controller.signal;
  }
  assertAllowed() {
    const lease = this.currentLease();
    if (lease && lease.upgrade !== 'draining') throw new PoolMaintenanceError();
  }
  /** Park authenticated arrivals before they enter the account queue or start its deadline. */
  waitForUpgrade(signal: AbortSignal): Promise<void> | undefined {
    const lease = this.currentLease();
    if (!lease?.upgrade) return;
    signal.throwIfAborted();
    if (this.upgradeWaiters.size >= 1024) throw new PoolMaintenanceError();
    return new Promise<void>((resolve, reject) => {
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => {
        clearTimeout(timer);
        this.upgradeWaiters.delete(wake);
        signal.removeEventListener('abort', abort);
      };
      const timer = setTimeout(wake, Math.max(0, lease.expiresAt - this.now()));
      this.upgradeWaiters.add(wake);
      signal.addEventListener('abort', abort, {once: true});
    });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writer.then(operation); this.writer = result.catch(() => {}); return result;
  }
  acquireGraceful(owner: string) { return this.acquire(owner, false); }
  acquireUpgrade(owner: string) { return this.acquire(owner, false, 'draining'); }
  acquire(owner: string, interrupt = true, upgrade?: 'draining') { return this.serial(async () => {
    z.uuid().parse(owner);
    const current = this.currentLease();
    if (current) { if (current.owner !== owner || !!current.upgrade !== !!upgrade) throw Error('Another operation owns pool maintenance'); return this.status(); }
    if (this.controller.signal.aborted) this.controller = new AbortController();
    const now = this.now(); const lease = {owner, createdAt: now, expiresAt: now + 1_800_000, ...(upgrade ? {upgrade} : {})};
    await this.persist(lease);
    this.lease = lease;
    if (interrupt) this.controller.abort(new PoolMaintenanceError());
    return this.status();
  }); }
  sealUpgrade(owner: string) { return this.serial(async () => {
    const lease = this.currentLease();
    if (!lease?.upgrade || lease.owner !== owner) throw Error('Upgrade admission is not owned');
    if (this.activity() !== 0) throw Error('Model work has not drained');
    const sealed: Lease = {...lease, upgrade: 'sealed'};
    await this.persist(sealed);
    this.lease = sealed;
    return this.status();
  }); }
  release(owner: string) { return this.serial(async () => {
    z.uuid().parse(owner);
    if (this.lease && this.lease.owner !== owner) throw Error('Cannot release another operation maintenance');
    await this.persist(null);
    this.lease = null;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    for (const wake of this.upgradeWaiters) wake();
    return this.status();
  }); }
}
