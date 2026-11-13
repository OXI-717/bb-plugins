import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createAccountPoolPlugin } from './server.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('keeps owner RPCs available while CLI and delegated management remain guarded', async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'management-server-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const upstream = vi.fn(async () => { throw Error('Unexpected upstream request'); });
  const host = createFakePluginHost({ pluginId: 'pool-test', dataDir, sdk: { hosts: { list: async () => [] } } });
  cleanups.push(() => host.harness.lifecycle.dispose());
  await createAccountPoolPlugin({ fetch: upstream })(host.bb);
  const call = host.harness.behavior.callRpc;
  for (const method of ['account.list', 'status.get', 'config.get', 'egress.status', 'native.accounts']) await expect(call(method, null)).resolves.toBeDefined();
  expect((await host.harness.behavior.runCli(['egress', 'status', '--json'])).exitCode).toBe(1);
  expect(JSON.parse((await host.harness.behavior.runCli(['status', '--json'])).stdout)).toEqual({ management: 'locked' });
  await expect(call('provider-usage.v1.listResources', {})).resolves.toEqual({ label: 'Account Pooler', resources: [] });
  const key = (await fs.readFile(path.join(dataDir, 'plugins', 'pool-test', 'secrets', 'accounts', 'management', 'operator.env'), 'utf8')).trim().split('=')[1]!;
  const grant = await call('management.unlock', { key, scope: 'manage', ttlSeconds: 60 }) as { token: string };
  const created = await call('management.call', { token: grant.token, method: 'account.add', input: {
    provider: 'claude', source: { kind: 'api-key', apiKey: 'synthetic-upstream-input' }, label: 'Private operator account', priority: 100,
  } }) as { ok: boolean; result: { id: string } };
  expect(created.ok).toBe(true);
  await expect(call('account.list', null)).resolves.toHaveLength(1);
  const list = await call('management.call', { token: grant.token, method: 'account.list', input: null }) as { ok: boolean; result: unknown[] };
  expect(list.ok).toBe(true); expect(list.result).toHaveLength(1);
  await call('management.lock', { token: grant.token });
  await expect(call('management.call', { token: grant.token, method: 'account.list', input: null })).resolves.toEqual({ ok: false, code: 'pool-management-locked' });
  expect(upstream).not.toHaveBeenCalled();
});
