import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { codexQuotaFromUsage, createCodexAdapter } from './codex-adapter.js';
import { codexBudgetQuota, CODEX_BUDGET_MAX_AGE_MS } from './codex-budget.js';
import { AccountStore, HubTokenStore, QuotaStore, QUOTA_MIGRATIONS } from './store.js';
import { createAccountPoolPlugin } from './server.js';

const id = '11111111-1111-4111-8111-111111111111';
const now = 1_900_000_000_000;
const weekly = () => ({ used_percent: 20, limit_window_seconds: 604800, reset_at: (now + 86400000) / 1000 });
function quota(rate_limit: unknown) {
  const db = new Database(':memory:');
  try {
    for (const sql of QUOTA_MIGRATIONS) db.exec(sql);
    return codexQuotaFromUsage(id, { rate_limit }, new QuotaStore(db).get(id), now)!;
  } finally { db.close(); }
}
function complete(extra = {}) { return { allowed: true, limit_reached: false, primary_window: weekly(), secondary_window: null, ...extra }; }

it('distinguishes explicit absent, missing and unknown duration, identifying weekly primary by duration', () => {
  const q = quota(complete());
  expect(codexBudgetQuota(q, now)).toMatchObject({ budgetReady: true, windows: { fiveHour: { state: 'absent', remainingPercent: null }, weekly: { state: 'present', remainingPercent: 80 } } });
  const absent = complete(); delete (absent as { secondary_window?: unknown }).secondary_window;
  expect(quota(absent).codexUsageEvidence?.secondary).toBe('unknown');
  expect(codexBudgetQuota(quota(absent), now)).toMatchObject({ budgetReady: false, windows: { fiveHour: { state: 'unknown' } } });
  expect(codexBudgetQuota(quota(complete({ secondary_window: { used_percent: 0 } })), now).budgetReady).toBe(false);
  expect(codexBudgetQuota(quota(complete({ primary_window: { ...weekly(), limit_window_seconds: 18001 } })), now).budgetReady).toBe(false);
});

it.each([
  ['stale', CODEX_BUDGET_MAX_AGE_MS + 1, {}],
  ['future', -1, {}],
  ['denied', 0, { allowed: false }],
  ['limited', 0, { limit_reached: true }],
  ['missing semantics', 0, { allowed: undefined }],
  ['expired reset', 0, { primary_window: { ...weekly(), reset_at: now / 1000 } }],
  ['duplicate durations', 0, { secondary_window: weekly() }],
] as const)('fails closed for %s', (_label, delta, fields) => {
  expect(codexBudgetQuota(quota(complete(fields)), now + delta).budgetReady).toBe(false);
});

it('never turns partial headers or legacy rows into proof of absence, and preserves evidence across DB reopen', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'budget-db-'));
  try {
    const file = path.join(dir, 'quota.sqlite');
    let db = new Database(file); for (const sql of QUOTA_MIGRATIONS) db.exec(sql);
    const q = quota(complete()); new QuotaStore(db).put(q); db.close();
    db = new Database(file);
    const restored = new QuotaStore(db).get(id); db.close();
    expect(restored.codexUsageEvidence).toEqual(q.codexUsageEvidence);
    expect(codexBudgetQuota(restored, now).budgetReady).toBe(true);
    delete restored.codexUsageEvidence;
    expect(codexBudgetQuota(restored, now).windows.fiveHour.state).toBe('unknown');
    expect(codexBudgetQuota(restored, now).budgetReady).toBe(false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('authenticates the project-bound route and scopes real router eligibility without upstream calls or account mutations', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'budget-route-'));
  cleanup.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const upstream = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected upstream call'); });
  const host = createFakePluginHost({ pluginId: 'account-pool-balanced', dataDir, sdk: { hosts: { list: async () => [{ id: 'fixture-host', name: 'Fixture' }] }, system: { providerStates: async () => ({ providers: [] }) } } });
  cleanup.push(() => host.harness.lifecycle.dispose());
  await host.bb.storage.kv.set('config', { vpnOnlyProviders: [], vpnPolicyVersion: 2 });
  await createAccountPoolPlugin({ fetch: upstream, fetchIpv4: upstream, now: () => now })(host.bb);
  const service = host.harness.behavior.runService('hub');
  cleanup.push(async () => { service.controller.abort(); await service.done; });
  await new Promise(resolve => setImmediate(resolve));
  const secretDir = path.join(dataDir, 'plugins', host.bb.pluginId, 'secrets', 'accounts');
  const accounts = new AccountStore(host.bb.storage.kv, secretDir);
  const first = await accounts.add({ provider: 'codex', kind: 'oauth', label: 'Fixture', email: null, accountUuid: null, subscriptionType: null, rateLimitTier: null, enabled: true, priority: 100 }, { kind: 'oauth', accessToken: randomBytes(24).toString('hex'), refreshToken: randomBytes(24).toString('hex'), expiresAt: now + 100000 });
  const foreign = await accounts.add({ ...first, label: 'Foreign', projects: { onlySelected: true, rules: [{ projectId: 'other-project', role: 'inherit' }] } }, { kind: 'oauth', accessToken: randomBytes(24).toString('hex'), refreshToken: randomBytes(24).toString('hex'), expiresAt: now + 100000 });
  const quotas = new QuotaStore(host.bb.storage.database());
  quotas.put({ ...quota(complete()), accountId: first.id });
  const resolveToken = async (projectId: string | null) => {
    const env = await host.harness.behavior.resolveProviderEnv('codex', { hostId: 'fixture-host', threadId: null, projectId } as never);
    return env.find(item => item.name === 'CODEX_POOL_AUTH_TOKEN')!.value as string;
  };
  const token = await resolveToken('project-one');
  const unbound = await resolveToken(null);
  const read = (key = token, query = '') => host.harness.behavior.fetchHttp('GET', '/budget/codex' + query, { headers: { authorization: `Bearer ${key}` } });
  expect((await read('invalid')).status).toBe(401);
  expect((await read(unbound)).status).toBe(403);
  expect((await read(token, '?projectId=other-project')).status).toBe(403);
  const inventory = await accounts.list();
  const response = await read(); expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(body).toMatchObject({ schema: 'bb-account-pool/codex-budget/1', projectId: 'project-one', route: { ready: true }, accounts: [{ accountId: first.id, eligible: true, budgetReady: true }] });
  expect(JSON.stringify(body)).not.toContain(foreign.id); expect(JSON.stringify(body)).not.toContain(token);
  expect(await accounts.list()).toEqual(inventory);
  await host.harness.behavior.callRpc('routing.set', { provider: 'codex', enabled: false });
  expect(await (await read()).json()).toMatchObject({ route: { ready: false }, accounts: [{ eligible: false }] });
  await host.harness.behavior.callRpc('routing.set', { provider: 'codex', enabled: true });
  quotas.put({ ...quotas.get(first.id), heldUntil: now + 30000 });
  expect(await (await read()).json()).toMatchObject({ accounts: [{ eligible: true, budgetReady: false }] });
  quotas.put({ ...quotas.get(first.id), heldUntil: null, error: 'Synthetic unavailable quota' });
  expect(await (await read()).json()).toMatchObject({ accounts: [{ eligible: false, budgetReady: false }] });
  quotas.put({ ...quotas.get(first.id), error: null });
  const threaded = await host.harness.behavior.resolveProviderEnv('codex', { hostId: 'fixture-host', threadId: 'fixture-thread', projectId: 'project-one' });
  const threadToken = threaded.find(item => item.name === 'CODEX_POOL_AUTH_TOKEN')!.value as string;
  await host.harness.behavior.callRpc('bypass.set', { threadId: 'fixture-thread', bypassed: true });
  expect(await (await read(threadToken)).json()).toMatchObject({ route: { ready: false, threadBypassed: true } });
  await host.harness.behavior.callRpc('config.set', { vpnGuardEnabled: true });
  expect(await (await read()).json()).toMatchObject({ route: { ready: false, networkAllowed: false } });
  await host.harness.behavior.callRpc('config.set', { vpnGuardEnabled: false });
  service.controller.abort(); await service.done;
  expect(await (await read()).json()).toMatchObject({ route: { ready: false, accepting: false } });
  expect(upstream).not.toHaveBeenCalled();
});

it('invalidates absence proof when newer headers change the slot layout', () => {
  const adapter = createCodexAdapter({ refreshUrl: 'https://auth.example/token', usageUrl: 'https://usage.example/usage' });
  const prior = quota(complete());
  const changed = adapter.quotaFromHeaders(id, new Headers({ 'x-codex-primary-used-percent': '10', 'x-codex-primary-window-minutes': '300' }), prior, 'other', now + 1);
  expect(changed.codexUsageEvidence).toBeUndefined();
  expect(codexBudgetQuota(changed, now + 1)).toMatchObject({ budgetReady: false, windows: { weekly: { state: 'unknown' } } });
  const stable = adapter.quotaFromHeaders(id, new Headers({ 'x-codex-primary-used-percent': '25', 'x-codex-primary-window-minutes': '10080' }), prior, 'other', now + 1);
  expect(stable.codexUsageEvidence).toEqual(prior.codexUsageEvidence);
});
