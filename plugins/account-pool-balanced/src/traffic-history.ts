import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { providerSchema } from './contracts.js';
import type { Observation } from './request-journal.js';

export const HOUR_MS = 3600000;
export const HISTORY_TTL_MS = 14 * 24 * HOUR_MS;
export const HISTORY_MAX_ROWS = 8192;
export const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counters = z.object({
  requests: count, firstDispatches: count, attempts: count, upstreamResponses: count, upstream429: count,
  upstreamAuthErrors: count, upstream5xx: count, localHeld429: count,
  upstream503: count.default(0), accountSwitches: count.default(0), accountSwitchSuccesses: count.default(0),
  authRefreshes: count.default(0), authRefreshSucceeded: count.default(0), authRefreshTransient: count.default(0),
  authRefreshRejected: count.default(0), authRefreshFailed: count.default(0), lastUpstream503At: count.default(0), lastAuthRefreshFailureAt: count.default(0),
  queueWaits: count, queueFailures: count, queueWaitMs: count,
  streamEnds: count, streamErrors: count, streamCanceled: count, streamMs: count,
  peakAccountInFlight: count, lastUpstream429At: count, lastAuthErrorAt: count, lastQueueFailureAt: count,
});
type Counters = z.infer<typeof counters>;
const rowSchema = counters.extend({
  hour: count.refine(v => v % HOUR_MS === 0), provider: providerSchema,
  accountId: z.string().uuid().nullable(),
  clientHash: z.string().regex(/^[a-f0-9]{24}$/).nullable(),
  projectId: z.string().regex(/^proj_[a-z0-9]{6,32}$/).nullable(),
});
type Row = z.infer<typeof rowSchema>;
const snapshotSchema = z.object({
  schema: z.literal('bb-account-pool/traffic-history/1'),
  startedAt: count, extendedCountersStartedAt: count.optional(), capacityDroppedEvents: count, capacityEvictedBuckets: count, rows: z.array(rowSchema).max(HISTORY_MAX_ROWS),
});
const empty = (): Counters => Object.fromEntries(Object.keys(counters.shape).map(k => [k, 0])) as Counters;
const add = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const key = (r: Row) => JSON.stringify([r.hour, r.provider, r.accountId, r.clientHash, r.projectId]);

/** Called only with validated journal events. No request/attempt IDs or free text survive. */
export class TrafficHistory {
  private rows = new Map<string, Row>();
  private startedAt: number;
  private extendedCountersStartedAt: number;
  private capacityDroppedEvents = 0;
  private capacityEvictedBuckets = 0;
  private storageFailures = 0;
  private dirty = false;
  private writing: Promise<void> | null = null;
  private lastPruneHour = -1;
  constructor(private readonly file: string, private readonly now = Date.now) { this.startedAt = now(); this.extendedCountersStartedAt = now(); }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.chmod(path.dirname(this.file), 0o700);
      await fs.rm(this.file + '.tmp', { force: true });
      const stat = await fs.stat(this.file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (stat) {
        if (stat.size > HISTORY_MAX_BYTES) throw Error('oversized history');
        const data = snapshotSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
        if (data.startedAt > this.now()) throw Error('future history');
        this.startedAt = data.startedAt;
        this.extendedCountersStartedAt = data.extendedCountersStartedAt ?? this.now();
        if (this.extendedCountersStartedAt > this.now()) throw Error("future extended coverage");
        this.capacityDroppedEvents = data.capacityDroppedEvents;
        this.capacityEvictedBuckets = data.capacityEvictedBuckets;
        for (const row of data.rows) {
          const id = key(row);
          if (this.rows.has(id)) throw Error('duplicate aggregate');
          this.rows.set(id, row);
        }
      }
    } catch { this.rows.clear(); this.startedAt = this.now(); this.extendedCountersStartedAt = this.now(); this.storageFailures++; }
    this.prune();
  }

  record(r: Observation): void {
    // Dispatch timestamps, not request bodies, determine buckets. Future/expired events are not backfilled.
    const hour = Math.floor(r.at / HOUR_MS) * HOUR_MS;
    if (r.at > this.now() || hour < this.cutoff()) return;
    this.prune();
    const identity = { hour, provider: r.provider, accountId: r.accountId, clientHash: r.clientHash, projectId: r.projectId };
    const id = key({ ...identity, ...empty() });
    let row = this.rows.get(id);
    if (!row) {
      if (this.rows.size >= HISTORY_MAX_ROWS) {
        const oldest = Math.min(...[...this.rows.values()].map(r => r.hour));
        // Free the oldest hour together so new traffic does not starve behind fourteen days of old rows.
        if (oldest < hour) {
          for (const [k, r] of this.rows) if (r.hour === oldest) {
            this.rows.delete(k); this.capacityEvictedBuckets = add(this.capacityEvictedBuckets, 1);
          }
        }
        // Within one full hour preserve admitted buckets instead of continuously resetting their counters.
        else { this.capacityDroppedEvents = add(this.capacityDroppedEvents, 1); this.dirty = true; return; }
      }
      row = { ...identity, ...empty() }; this.rows.set(id, row);
    }
    const inc = (k: keyof Counters, n = 1) => { row![k] = add(row![k], n); };
    if (r.event === 'request') inc('requests');
    if (r.event === 'attempt') { inc('attempts'); if (r.attempt === 1) inc('firstDispatches'); }
    if (r.event === 'upstream') {
      inc('upstreamResponses');
      if (r.status === 503) { inc('upstream503'); row.lastUpstream503At = Math.max(row.lastUpstream503At,r.at); }
      if (r.status === 429) { inc('upstream429'); row.lastUpstream429At = Math.max(row.lastUpstream429At,r.at); }
      if (r.status === 401 || r.status === 403) { inc('upstreamAuthErrors'); row.lastAuthErrorAt = Math.max(row.lastAuthErrorAt,r.at); }
      if (r.status !== null && r.status >= 500) inc('upstream5xx');
    }
    if (r.event === 'account-switch') {
      if (r.switchOutcome === 'dispatched') inc('accountSwitches');
      if (r.switchOutcome === 'accepted') inc('accountSwitchSuccesses');
    }
    if (r.event === 'auth-refresh' && r.authOutcome) {
      inc('authRefreshes');
      const key = {succeeded:'authRefreshSucceeded','transient-failed':'authRefreshTransient','reauth-required':'authRefreshRejected',failed:'authRefreshFailed'} as const;
      inc(key[r.authOutcome]);
      if (r.authOutcome !== 'succeeded') row.lastAuthRefreshFailureAt = Math.max(row.lastAuthRefreshFailureAt,r.at);
    }
    if (r.event === 'local-held' && r.status === 429) inc('localHeld429');
    if (r.event === 'queue-wait') {
      inc('queueWaits'); if (r.status === 503) { inc('queueFailures'); row.lastQueueFailureAt = Math.max(row.lastQueueFailureAt,r.at); }
      inc('queueWaitMs', Math.floor(r.durationMs ?? 0));
    }
    if (r.event === 'stream-end') {
      inc('streamEnds'); inc('streamMs', Math.floor(r.durationMs ?? 0));
      if (r.outcome === 'error') inc('streamErrors');
      if (r.outcome === 'canceled') inc('streamCanceled');
    }
    // The hub increments the account count before dispatch observation, and decrements at stream end.
    if (r.event === 'attempt' || r.event === 'upstream')
      row.peakAccountInFlight = Math.max(row.peakAccountInFlight, r.accountInFlight);
    this.dirty = true;
  }

  private metadata() {
    this.prune();
    return {
      schema: 'bb-account-pool/traffic-history/1' as const, startedAt: this.startedAt,
      observedAt: this.now(), extendedCountersStartedAt:this.extendedCountersStartedAt, retentionMs: HISTORY_TTL_MS, bucketMs: HOUR_MS,
      maxRows: HISTORY_MAX_ROWS, maxBytes: HISTORY_MAX_BYTES,
      coverage: 'forward-events-since-start' as const,
      capacityDroppedEvents: this.capacityDroppedEvents, capacityEvictedBuckets: this.capacityEvictedBuckets,
      truncated: this.capacityDroppedEvents > 0 || this.capacityEvictedBuckets > 0,
      storageFailuresSinceStart: this.storageFailures,
      totalRows: this.rows.size,
    };
  }
  /** Fixed provider cardinality, evaluated across every retained bucket, independent of detail pages. */
  summary() {
    const metadata = this.metadata();
    const providers = new Map<Observation['provider'], Counters>();
    for (const row of this.rows.values()) {
      const total = providers.get(row.provider) ?? empty();
      for (const k of Object.keys(counters.shape) as Array<keyof Counters>) {
        total[k] = k === 'peakAccountInFlight' || k.startsWith('last') ? Math.max(total[k],row[k]) : add(total[k],row[k]);
      }
      providers.set(row.provider,total);
    }
    return {...metadata,providers:[...providers].map(([provider,total])=>({provider,...total})),
      recentPressure:[...providers].map(([provider,total])=>({provider,lastUpstream429At:total.lastUpstream429At,
        lastAuthErrorAt:total.lastAuthErrorAt,lastQueueFailureAt:total.lastQueueFailureAt,
        lastUpstream503At:total.lastUpstream503At,lastAuthRefreshFailureAt:total.lastAuthRefreshFailureAt}))};
  }
  snapshot(offset = 0, limit = 100) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > HISTORY_MAX_ROWS || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw Error('History requires offset 0..8192 and limit 1..200');
    const metadata = this.metadata();
    const rows = [...this.rows.values()].sort((a,b)=>a.hour-b.hour || key(a).localeCompare(key(b))).slice(offset,offset+limit).map(r=>({...r}));
    return {...metadata,offset,limit,rowsTruncated:rows.length<metadata.totalRows,
      nextOffset:offset+rows.length<metadata.totalRows?offset+rows.length:null,rows};
  }
  private cutoff() { return Math.floor(this.now() / HOUR_MS) * HOUR_MS - HISTORY_TTL_MS + HOUR_MS; }
  private prune() {
    const hour = Math.floor(this.now() / HOUR_MS);
    if (hour === this.lastPruneHour) return;
    this.lastPruneHour = hour;
    for (const [id, row] of this.rows) if (row.hour < this.cutoff() || row.hour > hour * HOUR_MS) {
      this.rows.delete(id); this.dirty = true;
    }
  }
  async flush(): Promise<void> {
    if (this.writing) return this.writing;
    this.prune(); if (!this.dirty) return;
    this.dirty = false;
    const data = { schema: 'bb-account-pool/traffic-history/1', startedAt: this.startedAt, extendedCountersStartedAt:this.extendedCountersStartedAt,
      capacityDroppedEvents: this.capacityDroppedEvents, capacityEvictedBuckets: this.capacityEvictedBuckets, rows: [...this.rows.values()] };
    this.writing = (async () => {
      try {
        const text = JSON.stringify(data);
        if (Buffer.byteLength(text) > HISTORY_MAX_BYTES) throw Error('oversized history');
        await fs.writeFile(this.file + '.tmp', text, { mode: 0o600 });
        await fs.chmod(this.file + '.tmp', 0o600);
        await fs.rename(this.file + '.tmp', this.file);
      } catch {
        this.storageFailures++; this.dirty = true;
        await fs.rm(this.file + '.tmp', { force: true }).catch(() => { this.storageFailures++; });
      }
    })();
    try { await this.writing; } finally { this.writing = null; }
  }
  /** The journal has stopped admission/recording before this finite final drain. */
  async close(): Promise<void> {
    if (this.writing) await this.writing;
    await this.flush();
  }
}
