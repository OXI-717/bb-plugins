import { z } from 'zod';

export const maintenanceLeaseSchema = z.object({
  owner: z.uuid(), createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
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
  private writer: Promise<unknown> = Promise.resolve();
  constructor(private persist: (value: Lease | null) => Promise<void>, private now = Date.now, private activity:()=>number=()=>0) {}
  async initialize(raw: unknown) {
    if (raw === undefined || raw === null) return;
    const lease = maintenanceLeaseSchema.parse(raw);
    if (lease.expiresAt <= this.now() || lease.createdAt > this.now()) { await this.persist(null); return; }
    this.lease = lease; this.controller.abort(new PoolMaintenanceError());
  }
  status(): z.infer<typeof maintenanceStatusSchema> {
    return {schemaVersion: 1, scope: 'all-model-clients', transportInFlight:this.activity(), lease: this.lease && this.lease.expiresAt > this.now() ? {...this.lease} : null};
  }
  get signal(): AbortSignal {
    if (!this.status().lease && this.controller.signal.aborted) this.controller = new AbortController();
    return this.controller.signal;
  }
  assertAllowed() { if (this.status().lease) throw new PoolMaintenanceError(); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writer.then(operation); this.writer = result.catch(() => {}); return result;
  }
  acquire(owner: string) { return this.serial(async () => {
    z.uuid().parse(owner);
    const current = this.status().lease;
    if (current) { if (current.owner !== owner) throw Error('Another operation owns pool maintenance'); return this.status(); }
    const now = this.now(); const lease = {owner, createdAt: now, expiresAt: now + 1_800_000};
    await this.persist(lease); this.lease = lease; this.controller.abort(new PoolMaintenanceError()); return this.status();
  }); }
  release(owner: string) { return this.serial(async () => {
    z.uuid().parse(owner);
    if (this.lease && this.lease.owner !== owner) throw Error('Cannot release another operation maintenance');
    await this.persist(null); this.lease = null; this.controller = new AbortController(); return this.status();
  }); }
}
