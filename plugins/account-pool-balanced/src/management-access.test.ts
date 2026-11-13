import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { BbPluginApi, PluginRpcHandlers } from '@get-bb/plugin-sdk';
import { ManagementAccess, PoolManagementLocked } from './management-access.js';
import { managementCli, managementInvoke, registerManagementRpc } from './management-boundary.js';
import { accountPoolRpcContract } from './rpc.js';
import { registerUsageSource } from './usage-source.js';
import { usageListMethod, usageFetchMethod } from './usage-contract.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'pool-management-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const access = new ManagementAccess(directory, () => now);
  await access.initialize();
  const keyFile = path.join(directory, 'operator.env');
  const key = (await fs.readFile(keyFile, 'utf8')).trim().split('=')[1]!;
  return { directory, access, key, keyFile, advance: (ms: number) => { now += ms; } };
}

it('creates a private operator key without an HTTP bootstrap and preserves it on restart', async () => {
  const { directory, access, key, keyFile } = await setup();
  expect((await fs.stat(keyFile)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  const grant = access.unlock(key);
  access.assert(grant.token, 'manage');
  expect(() => access.assert(key, 'read')).toThrow(PoolManagementLocked);
  const restarted = new ManagementAccess(directory);
  await restarted.initialize();
  expect(() => restarted.assert(grant.token, 'read')).toThrow(PoolManagementLocked);
  restarted.assert(restarted.unlock(key).token, 'manage');
  const text = await fs.readFile(keyFile, 'utf8');
  expect(text.includes(grant.token)).toBe(false);
});

it('refuses an existing public, malformed or symlinked key instead of replacing it', async () => {
  const { directory, keyFile } = await setup();
  await fs.chmod(keyFile, 0o644);
  await expect(new ManagementAccess(directory).initialize()).rejects.toThrow(PoolManagementLocked);
  await fs.chmod(keyFile, 0o600);
  await fs.writeFile(keyFile, 'malformed');
  await expect(new ManagementAccess(directory).initialize()).rejects.toThrow(PoolManagementLocked);
  await fs.rename(keyFile, keyFile + '.saved');
  await fs.symlink(keyFile + '.saved', keyFile);
  await expect(new ManagementAccess(directory).initialize()).rejects.toThrow();
});

it('denies forged credentials, read-to-manage escalation, expiration, revoke and disposal', async () => {
  const { access, key, advance } = await setup();
  const read = access.unlock(key, 'read', 1);
  access.assert(read.token, 'read');
  for (const token of [undefined, '', 'invented', key]) expect(() => access.assert(token, 'read')).toThrow(PoolManagementLocked);
  expect(() => access.assert(read.token, 'manage')).toThrow(PoolManagementLocked);
  advance(1000);
  expect(() => access.assert(read.token, 'read')).toThrow(PoolManagementLocked);
  const manage = access.unlock(key);
  access.revoke(manage.token);
  expect(() => access.assert(manage.token, 'read')).toThrow(PoolManagementLocked);
  const active = access.unlock(key);
  access.close();
  expect(() => access.assert(active.token, 'manage')).toThrow(PoolManagementLocked);
  expect(() => access.unlock(key)).toThrow(PoolManagementLocked);
});

it('bounds failed unlock attempts and refuses excessive grant lifetime', async () => {
  const { access, key, advance } = await setup();
  for (let i = 0; i < 5; i++) expect(() => access.unlock('invalid')).toThrow(PoolManagementLocked);
  expect(() => access.unlock(key)).toThrow(PoolManagementLocked);
  advance(300_000);
  expect(() => access.unlock(key, 'manage', 901)).toThrow(PoolManagementLocked);
  access.assert(access.unlock(key, 'manage', 1).token, 'manage');
});

function handlerFixture(overrides: Partial<PluginRpcHandlers<typeof accountPoolRpcContract>> = {}) {
  return { ...Object.fromEntries(Object.keys(accountPoolRpcContract).map(method => [method, vi.fn(async () => null)])),
    'account.list': vi.fn(async () => []), 'account.disable': vi.fn(async () => ({ account: null })), ...overrides,
  } as PluginRpcHandlers<typeof accountPoolRpcContract>;
}

it('protects every legacy RPC before dispatch and permits only the exact trusted plugin reads', async () => {
  const { access } = await setup();
  const registrations: Array<{ contract: unknown; handlers: Record<string, (input: unknown, context?: unknown) => unknown> }> = [];
  const bb = { rpc: { register: (contract: unknown, handlers: Record<string, (input: unknown, context?: unknown) => unknown>) => registrations.push({ contract, handlers }) } } as unknown as Pick<BbPluginApi, 'rpc'>;
  const handlers = handlerFixture();
  registerManagementRpc(bb, access, handlers);
  const legacy = registrations[0]!.handlers;
  for (const [method, handler] of Object.entries(legacy)) {
    for (const caller of [undefined, { kind: 'client', pluginId: 'model-connections' }, { kind: 'plugin', pluginId: 'untrusted' }]) {
      expect(() => handler({ threadId: 'owner-thread', projectId: 'owner-project' }, { experimental_caller: caller })).toThrow(PoolManagementLocked);
    }
    if (!['status.get', 'thread.account'].includes(method)) expect(() => handler(null, { experimental_caller: { kind: 'plugin', pluginId: 'model-connections' } })).toThrow(PoolManagementLocked);
  }
  for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  await legacy['thread.account']!({ threadId: 'target' }, { experimental_caller: { kind: 'plugin', pluginId: 'model-connections' } });
  expect(handlers['thread.account']).toHaveBeenCalledOnce();
});

it('uses one capability policy for RPC input validation, reads and writes with no prototype dispatch', async () => {
  const { access, key } = await setup();
  const handlers = handlerFixture(), invoke = managementInvoke(access, handlers);
  const read = access.unlock(key, 'read'), manage = access.unlock(key);
  await expect(invoke(read.token, 'account.list', null)).resolves.toEqual([]);
  const input = { id: '11111111-1111-4111-8111-111111111111' };
  await expect(invoke(read.token, 'account.disable', input)).rejects.toThrow(PoolManagementLocked);
  expect(handlers['account.disable']).not.toHaveBeenCalled();
  await expect(invoke(manage.token, 'account.disable', { id: 'invalid' })).rejects.toThrow('Invalid management request');
  expect(handlers['account.disable']).not.toHaveBeenCalled();
  await expect(invoke(manage.token, 'account.disable', input)).resolves.toEqual({ account: null });
  expect(handlers['account.disable']).toHaveBeenCalledExactlyOnceWith(input);
  for (const method of ['constructor', '__proto__', 'management.unlock']) await expect(invoke(manage.token, method, null)).rejects.toThrow(PoolManagementLocked);
});

it('withholds an outstanding read after its grant is revoked', async () => {
  const { access, key } = await setup();
  const grant = access.unlock(key, 'read');
  let finish!: (value: []) => void;
  const handlers = handlerFixture({ 'account.list': () => new Promise(resolve => { finish = resolve; }) });
  const result = managementInvoke(access, handlers)(grant.token, 'account.list', null);
  access.revoke(grant.token); finish([]);
  await expect(result).rejects.toThrow(PoolManagementLocked);
});

it('closes CLI inventory and mutation paths including forged identities and help flag bypass', async () => {
  const { access, key } = await setup();
  let run!: (argv: string[], context: { threadId?: string; projectId?: string }) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  const actual = vi.fn(async () => ({ exitCode: 0, stdout: 'operator-result' }));
  const bb = { pluginId: 'test', server: {}, cli: { register: (registration: { run: typeof run }) => { run = registration.run; } } } as unknown as Pick<BbPluginApi, 'cli' | 'server' | 'pluginId'>;
  managementCli(bb, access).cli.register({ name: 'pool', summary: 'test', commands: [], run: actual });
  for (const argv of [['egress', 'status', '--json'], ['account', 'list'], ['config', 'set', 'vpnGuardEnabled', 'false'], ['maintenance', 'release'], ['client', 'add', 'attacker']]) {
    expect((await run(argv, { threadId: 'owner', projectId: 'owner-project' })).exitCode).toBe(1);
  }
  expect((await run(['account', 'remove', 'target', '--help'], {})).exitCode).toBe(0);
  expect(actual).not.toHaveBeenCalled();
  const status = await run(['status', '--json'], {});
  expect(JSON.parse(status.stdout!)).toEqual({ management: 'locked' });
  const read = access.unlock(key, 'read'), manage = access.unlock(key);
  const execute = (token: string, argv: string[]) => run(['management', 'execute', '--request', JSON.stringify({ token, argv })], {});
  expect((await execute(read.token, ['account', 'disable', 'target'])).exitCode).toBe(1);
  expect((await execute(manage.token, ['account', 'disable', 'target'])).exitCode).toBe(0);
  expect(actual).toHaveBeenCalledOnce();
  expect((await execute(manage.token, ['management', 'unlock'])).exitCode).toBe(1);
});

it('does not leak resource names through the separate quota RPC registration', async () => {
  const handlers: Record<string, (input?: unknown) => Promise<unknown>> = {};
  const status = vi.fn(), refreshUsage = vi.fn();
  registerUsageSource({ rpc: { register: (_contract: unknown, value: typeof handlers) => Object.assign(handlers, value) } } as unknown as BbPluginApi,
    { status, refreshUsage } as never, true);
  await expect(handlers[usageListMethod]!()).resolves.toEqual({ label: 'Provider access', resources: [] });
  await expect(handlers[usageFetchMethod]!({ resourceId: 'known-account', refresh: true })).rejects.toThrow(PoolManagementLocked);
  expect(status).not.toHaveBeenCalled(); expect(refreshUsage).not.toHaveBeenCalled();
});

it('issues CLI grants only into new private server files and never into command output', async () => {
  const { access, directory, key } = await setup();
  let run!: (argv: string[], context: object) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  const bb = { pluginId: 'test', server: {}, cli: { register: (registration: { run: typeof run }) => { run = registration.run; } } } as unknown as Pick<BbPluginApi, 'cli' | 'server' | 'pluginId'>;
  managementCli(bb, access).cli.register({ name: 'pool', summary: 'test', commands: [], run: async () => ({ exitCode: 0 }) });
  const output = path.join(directory, 'read-grant.json');
  const argv = ['management', 'unlock', '--request', JSON.stringify({ key, scope: 'read', ttlSeconds: 60, output })];
  const result = await run(argv, {});
  expect(result.exitCode).toBe(0);
  const text = await fs.readFile(output, 'utf8');
  const grant = JSON.parse(text) as { token: string };
  access.assert(grant.token, 'read');
  expect(() => access.assert(grant.token, 'manage')).toThrow(PoolManagementLocked);
  expect((await fs.stat(output)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(result).includes(key)).toBe(false);
  expect(JSON.stringify(result).includes(grant.token)).toBe(false);
  expect((await run(argv, {})).exitCode).toBe(1);
  expect(await fs.readFile(output, 'utf8')).toBe(text);
});

it('a read grant inspects the single-argument config command without mutations', async () => {
  const { access, directory, key } = await setup();
  let run!: (argv: string[], context: object) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  const executed = vi.fn(async () => ({ exitCode: 0, stdout: 'config-output' }));
  const bb = { pluginId: 'test', server: {}, cli: { register: (registration: { run: typeof run }) => { run = registration.run; } } } as unknown as Pick<BbPluginApi, 'cli' | 'server' | 'pluginId'>;
  managementCli(bb, access).cli.register({ name: 'pool', summary: 'test', commands: [], run: executed });
  const output = path.join(directory, 'read-config-grant.json');
  const unlock = ['management', 'unlock', '--request', JSON.stringify({ key, scope: 'read', ttlSeconds: 60, output })];
  expect((await run(unlock, {})).exitCode).toBe(0);
  const grant = JSON.parse(await fs.readFile(output, 'utf8')) as { token: string };
  const execute = (argv: string[]) => run(['management', 'execute', '--request', JSON.stringify({ token: grant.token, argv })], {});
  expect((await execute(['config'])).stdout).toBe('config-output');
  expect((executed.mock.calls[0] as unknown[][])[0]).toEqual(['config']);
  expect((await execute(['config', 'set', 'vpnGuardEnabled', 'false'])).exitCode).toBe(1);
  expect(executed).toHaveBeenCalledTimes(1);
});