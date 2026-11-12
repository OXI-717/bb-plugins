import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { AccountEgress } from './account-egress.js';
import { createHub } from './hub.js';
import { accountPoolConfigSchema, type PoolProvider } from './contracts.js';
import { ACCOUNT_QUEUE_MAX_WAIT_MS } from './account-admission.js';
import { AccountStore, PoolAffinityStore, QuotaStore, QUOTA_MIGRATIONS } from './store.js';

const TTL = 30 * 60 * 1000;
const profile = { id: 'fixture-exit', version: 1, label: 'Fixture exit', node: 'fixture-node',
  hostIds: ['host-one'], transport: 'ssh-connect' as const, endpoint: 'http://127.0.0.1:19081',
  dns: 'remote' as const, ipv4: true as const, ipv6: false as const, failure: 'closed' as const,
  expectedExit: ['192.0.2.1'], assurance: 'proxy-enforced' as const };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function fixture(provider: PoolProvider = 'claude', threadBound = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'egress-continuity-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const host = createFakePluginHost({ pluginId: 'fixture-pool', dataDir: dir });
  cleanups.push(() => host.harness.lifecycle.dispose());
  let now = 1900000000000;
  const accounts = new AccountStore(host.bb.storage.kv, path.join(dir, 'secrets'));
  await accounts.initialize();
  const common = { provider, kind: provider === 'codex' ? 'oauth' as const : 'api-key' as const, label: 'Fixture', email: null,
    accountUuid: null, subscriptionType: null, rateLimitTier: null, enabled: true, autopilotAllowed: true };
  const add = (key: string, priority: number) => accounts.add({ ...common, priority,
    ...(provider === 'codex' ? { codexAccountId: key } : {}) }, provider === 'codex'
      ? { kind: 'oauth', accessToken: key, refreshToken: 'fixture-refresh', expiresAt: now + 365 * 86400000 }
      : { kind: 'api-key', apiKey: key });
  const a = await add('fixture-a', 100), b = await add('fixture-b', 200);
  const db = host.bb.storage.database(); for (const sql of QUOTA_MIGRATIONS) db.exec(sql);
  const quotas = new QuotaStore(db), affinity = new PoolAffinityStore(db);
  const affinityKey = JSON.stringify([provider, JSON.stringify(['host-one', 'project-one']), 'session:original']);
  const sessionKey = threadBound ? JSON.stringify(['host-one', 'project-one', 'original', provider]) : affinityKey;
  const egressInstances: AccountEgress[] = [];
  const newEgress = async () => {
    const e = new AccountEgress(host.bb.storage.kv, async () => 'host-one', async () => provider === 'claude' || provider === 'codex');
    egressInstances.push(e); await e.initialize(); return e;
  };
  let egress = await newEgress();
  cleanups.push(async () => { for (const e of egressInstances) await e.close(); });
  const settings = accountPoolConfigSchema.parse({ vpnOnlyProviders: [], vpnGuardEnabled: true, vpnPolicyVersion: 2 });
  let guardAllowed = true;
  let guardAction = async () => {};
  const sends: Array<{ key: string | null; assigned: boolean; model: string }> = [];
  const versions: Array<number | null> = [];
  let status: number | ((key: string | null) => number) = 200;
  const transport = (assigned: boolean): typeof fetch => async (_input, init) => {
    const headers = new Headers(init?.headers);
    const key = headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
    sends.push({ key, assigned,
      model: JSON.parse(Buffer.from(init?.body as ArrayBuffer).toString()).model });
    return Response.json({ id: 'fixture-response' }, { status: typeof status === 'number' ? status : status(key) });
  };
  vi.stubGlobal('fetch', transport(true));
  const hubs: Array<{ controller: AbortController; done: Promise<void> }> = [];
  cleanups.push(async () => { for (const h of hubs) h.controller.abort(); await Promise.all(hubs.map(h => h.done)); });
  const newHub = () => {
    const hub = createHub({ route: '/pool', accounts, quotas, affinity, getSettings: () => settings,
      hubTokens: { authenticate: async () => 'host-one', list: async () => [],
        authenticateContext: async token => ({ hostId: 'host-one', projectId: 'project-one',
          ...(threadBound ? { threadId: token!.replace(/^auto:/, '') } : {}),
          ...(token!.startsWith('auto:') ? { purpose: 'autopilot' as const } : {}) }) },
      accountRoute: async (id, key) => { const route = await egress.acquire(id, key); if (key) versions.push(route.profile?.version ?? null); return route; },
      pinnedRouteAccount: key => egress.pinnedAccount(key),
      guardCheck: async () => { await guardAction(); if (!guardAllowed) throw Error('fixture guard refusal'); return 'direct'; },
      fetch: transport(false), fetchIpv4: transport(false), now: () => now });
    // No usage, login or refresh operations: only the actual model forwarding path.
    vi.spyOn(hub, 'refreshUsage').mockResolvedValue();
    const controller = new AbortController(), done = hub.start(controller.signal); hubs.push({ controller, done });
    return hub;
  };
  let hub = newHub();
  return { accounts, quotas, affinity, a, b, sends, versions, sessionKey, affinityKey,
    egress: () => egress, settings,
    advance: (ms = TTL + 1) => { now += ms; },
    guard: (allowed: boolean) => { guardAllowed = allowed; },
    onGuard: (action: () => Promise<void>) => { guardAction = action; },
    status: (value: typeof status) => { status = value; },
    async seedAssigned() {
      await egress.configure(profile); await egress.bind(a.id, { id: profile.id, version: 1 });
      await egress.acquire(a.id, sessionKey);
      affinity.putBinding(affinityKey, { accountId: a.id, lastUsedAt: now });
      affinity.putProjectActiveAccount(provider, 'project-one', b.id);
      await egress.configure({ ...profile, version: 2, endpoint: 'http://127.0.0.1:19082' });
      await egress.bind(a.id, { id: profile.id, version: 2 });
      hubs.at(-1)!.controller.abort(); await hubs.at(-1)!.done; hub = newHub();
    },
    async restart() {
      hubs.at(-1)!.controller.abort(); await hubs.at(-1)!.done;
      egress = await newEgress(); hub = newHub();
    },
    async request(thread = 'original', model = provider === 'codex' ? 'codex-fixture-model' : 'claude-sonnet-fixture', autopilot = false) {
      now += 1001; // Preserve the configured 1000ms Claude pacing, without sleeps.
      const response = await hub.handle(new Request(`http://localhost/pool/${provider === 'codex' ? 'codex/v1/responses' : 'v1/messages'}`, {
        method: 'POST', headers: { authorization: `Bearer ${autopilot ? 'auto:' : ''}${thread}`, 'content-type': 'application/json', 'session_id': thread },
        body: JSON.stringify({ model, messages: [], metadata: { user_id: JSON.stringify({ session_id: thread }) } }),
      }), provider);
      await response.text(); return response;
    },
  };
}

it('restores Codex pins using provider session affinity without a BB thread binding or a model substitution', async () => {
  const f = await fixture('codex', false); await f.seedAssigned(); f.advance(); await f.restart();
  expect((await f.request('ordinary')).status).toBe(200);
  expect(f.sends.at(-1)?.key).toBe('fixture-b');
  for (const model of ['codex-fixture-model', 'another-supported-fixture-model']) {
    expect((await f.request('original', model)).status).toBe(200);
    expect(f.sends.at(-1)).toEqual({ key: 'fixture-a', assigned: true, model });
    expect(f.versions.at(-1)).toBe(1);
  }
});

for (const reason of ['disabled', 'removed', 'project', 'purpose', 'quota', 'shared-quota', 'family', 'schedule', 'cap'] as const) {
  it(`refuses an ineligible saved account (${reason}) before any upstream with another eligible account present`, async () => {
    const f = await fixture(); await f.seedAssigned(); f.advance(); await f.restart();
    if (reason === 'disabled') await f.accounts.setEnabled(f.a.id, false);
    if (reason === 'removed') await f.accounts.remove(f.a.id);
    if (reason === 'project') await f.accounts.setProjects(f.a.id, { onlySelected: true, rules: [{ projectId: 'other-project', role: 'inherit' }] });
    if (reason === 'purpose') await f.accounts.setAutopilotAllowed(f.a.id, false, true);
    if (reason === 'quota') f.quotas.put({ ...f.quotas.get(f.a.id), error: 'Fixture unavailable' });
    if (reason === 'shared-quota') f.quotas.put({ ...f.quotas.get(f.a.id), fiveHourUtilization: 1, fiveHourResetAt: 2000000000000 });
    if (reason === 'family') f.quotas.put({ ...f.quotas.get(f.a.id), familyWeekly: { ...f.quotas.get(f.a.id).familyWeekly,
      sonnet: { utilization: 1, resetAt: 2000000000000, status: null, observedAt: 1900000000000, source: 'header' } } });
    if (reason === 'schedule') await f.accounts.setPolicy(f.a.id, { enabled: true, fiveHourKeep: null, weeklyKeep: null,
      reserveDrainHours: null, schedule: { timeZone: 'UTC', intervals: [] } });
    if (reason === 'cap') await f.accounts.setCap(f.a.id, { early: 0, late: 0 });
    const response = await f.request('original', 'claude-sonnet-fixture', reason === 'purpose');
    expect(response.status).toBe(503); expect(response.headers.get('x-bb-pool-error')).toBe('POOL_EGRESS_UNAVAILABLE');
    expect(f.sends).toEqual([]);
    expect(f.egress().snapshot().pins[f.sessionKey]).toEqual({ accountId: f.a.id, ref: { id: profile.id, version: 1 } });
  });
}

it('keeps Guard refusal ahead of all assigned and direct upstream traffic', async () => {
  const f = await fixture(); await f.seedAssigned(); f.advance(); await f.restart(); f.guard(false);
  await expect(f.request()).rejects.toThrow('fixture guard refusal'); expect(f.sends).toEqual([]);
});

it('rechecks the pinned account policy after the awaited Guard before dispatch', async () => {
  const f = await fixture(); await f.seedAssigned(); f.advance(); await f.restart();
  let checks = 0;
  f.onGuard(async () => { if (++checks === 2) await f.accounts.setEnabled(f.a.id, false); });
  const response = await f.request();
  expect(response.status).toBe(503); expect(response.headers.get('x-bb-pool-error')).toBe('POOL_EGRESS_UNAVAILABLE');
  expect(checks).toBe(2); expect(f.sends).toEqual([]);
});

it('still enforces the shared admission deadline for the pinned account with another account available', async () => {
  const f = await fixture(); await f.seedAssigned(); f.advance(); await f.restart();
  const snapshot = f.accounts.withSnapshot.bind(f.accounts);
  f.accounts.withSnapshot = action => snapshot(rows => { f.advance(ACCOUNT_QUEUE_MAX_WAIT_MS + 1); return action(rows); });
  const response = await f.request();
  expect(response.status).toBe(503); expect(response.headers.get('x-bb-pool-error')).toBe('POOL_QUEUE_TIMEOUT');
  expect(f.sends).toEqual([]);
});

it('retains the assigned route after unbind and returns one provider refusal without replay or account failover', async () => {
  const f = await fixture(); await f.seedAssigned(); await f.egress().bind(f.a.id, null); f.advance(); await f.restart(); f.status(429);
  expect((await f.request()).status).toBe(429);
  expect(f.sends).toEqual([{ key: 'fixture-a', assigned: true, model: 'claude-sonnet-fixture' }]); expect(f.versions).toEqual([1]);
});

it('preserves ordinary failover after restart and later profile binding without retrospectively assigning the warm conversation', async () => {
  const f = await fixture(); expect((await f.request()).status).toBe(200); expect(f.sends.at(-1)?.key).toBe('fixture-a');
  await f.egress().configure(profile);
  for (const account of [f.a, f.b]) await f.egress().bind(account.id, { id: profile.id, version: 1 });
  f.advance(); await f.restart(); f.sends.length = 0;
  f.status(key => key === 'fixture-a' ? 500 : 200);
  expect((await f.request()).status).toBe(200);
  expect(f.sends).toEqual([
    { key: 'fixture-a', assigned: false, model: 'claude-sonnet-fixture' },
    { key: 'fixture-b', assigned: false, model: 'claude-sonnet-fixture' },
  ]);
  expect(f.egress().snapshot().pins[f.sessionKey]).toBeUndefined();
});

it('leaves an unsupported provider on ordinary selection without registering a route decision', async () => {
  const f = await fixture('kimi');
  expect((await f.request('ordinary', 'kimi-fixture')).status).toBe(200);
  expect(f.sends.at(-1)?.assigned).toBe(false); expect(f.egress().snapshot().unassigned).toEqual({});
});

for (const mode of ['ttl', 'restart'] as const) {
  it(`uses the eligible saved account before ordinary selection after ${mode}`, async () => {
    const f = await fixture(); await f.seedAssigned(); f.advance();
    if (mode === 'restart') await f.restart();
    // Both remain eligible; the actual ordinary selector prefers B.
    expect((await f.request('ordinary')).status).toBe(200);
    expect(f.sends).toEqual([{ key: 'fixture-b', assigned: false, model: 'claude-sonnet-fixture' }]);
    expect((await f.request()).status).toBe(200);
    expect(f.sends.at(-1)).toEqual({ key: 'fixture-a', assigned: true, model: 'claude-sonnet-fixture' });
    expect(f.versions.at(-1)).toBe(1);
    expect(f.egress().snapshot().pins[f.sessionKey]).toEqual({ accountId: f.a.id, ref: { id: profile.id, version: 1 } });
  });
}
