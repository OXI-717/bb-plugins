import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  const summary = await host.harness.behavior.runCli(['status', '--summary']);
  expect(summary.exitCode).toBe(0);
  const empty = { readyCount: 0, totalEnabled: 0, minUsedPercent: null, exhausted: false };
  expect(JSON.parse(summary.stdout)).toEqual({
    generatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    providers: { claude: empty, codex: empty, gemini: empty, grok: empty, zai: empty, ifm: empty },
  });
  expect((await host.harness.behavior.runCli(['status', '--summary', '--json'])).exitCode).toBe(1);
  await expect(call('provider-usage.v1.listResources', {})).resolves.toEqual({ label: 'Account Pooler', resources: [] });
  const key = (await fs.readFile(path.join(dataDir, 'plugins', 'pool-test', 'secrets', 'accounts', 'management', 'operator.env'), 'utf8')).trim().split('=')[1]!;
  const grant = await call('management.unlock', { key, scope: 'manage', ttlSeconds: 60 }) as { token: string };
  const project = 'proj_synthetic';
  const readinessArgs = ['readiness', '--summary', '--project', project];
  const { runCli } = host.harness.behavior;
  expect((await runCli(readinessArgs)).exitCode).toBe(1);
  const readGrant = await call('management.unlock', { key, scope: 'read', ttlSeconds: 60 }) as { token: string };
  const execute = (argv: string[]) => runCli(['management', 'execute', '--request', JSON.stringify({ token: readGrant.token, argv })]);
  expect((await execute(['readiness', '--summary'])).exitCode).toBe(1);
  const invalid = await execute([...readinessArgs, project]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stderr?.trim()).toBe('Project readiness summary unavailable.');
  expect(JSON.stringify(invalid)).not.toContain(project);
  const legacyInvalid = await execute(['readiness', '--project', project, project]);
  expect(legacyInvalid.stderr).toContain(project);

  const projectSummary = await execute(readinessArgs);
  expect(projectSummary.exitCode).toBe(0);
  const report = JSON.parse(projectSummary.stdout);
  expect(Object.keys(report).sort()).toEqual(['checkedAt', 'providers']);
  expect(report.checkedAt).toEqual(expect.any(Number));
  expect(report.providers).toEqual(expect.arrayContaining([
    { provider: 'claude', ready: false, reason: expect.any(String) },
  ]));
  expect(JSON.stringify(report)).not.toContain(project);
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

it('links the real Guard to the registered narrow policy RPC while preserving config.get', async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'pool-guard-link-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const pool = createFakePluginHost({ pluginId: 'account-pool-balanced', dataDir, sdk: { hosts: { list: async () => [] } } });
  cleanups.push(() => pool.harness.lifecycle.dispose());
  const registrations: Record<string, (input: unknown, context?: unknown) => unknown> = {};
  const register = pool.bb.rpc.register.bind(pool.bb.rpc);
  vi.spyOn(pool.bb.rpc, 'register').mockImplementation(((contract: unknown, handlers: typeof registrations) => {
    Object.assign(registrations, handlers); return register(contract as never, handlers as never);
  }) as typeof pool.bb.rpc.register);
  await createAccountPoolPlugin({ fetch: async () => { throw Error('Unexpected network'); } })(pool.bb);
  await pool.harness.behavior.callRpc('config.set', { vpnGuardEnabled: true });
  const calls: string[] = [];
  const guard = createFakePluginHost({ pluginId: 'vpn-guard', sdk: {
    hosts: { list: async () => [] },
    plugins: { callRpc: async ({ method, input }) => {
      calls.push(method);
      if (!registrations[method]) throw Error('RPC not registered');
      return await registrations[method]!(input, { experimental_caller: { kind: 'plugin', pluginId: 'vpn-guard' } }) as never;
    } },
  } });
  cleanups.push(() => guard.harness.lifecycle.dispose());
  // Load the real Guard source using this test project's dependencies, as in the
  // existing cross-plugin native task fixture. No sibling installation is needed.
  const root = fileURLToPath(new URL('../', import.meta.url));
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  const modules = await fs.mkdtemp(path.join(root, 'dist', 'guard-link-'));
  cleanups.push(() => fs.rm(modules, { recursive: true, force: true }));
  const sourceRoot = path.resolve(root, '../vpn-guard');
  const copied = new Set<string>();
  const compile = async (name: string): Promise<void> => {
    if (copied.has(name)) return;
    copied.add(name);
    const source = await fs.readFile(path.join(sourceRoot, name + '.ts'), 'utf8');
    for (const imported of ts.preProcessFile(source).importedFiles) {
      if (imported.fileName.startsWith('./')) await compile(imported.fileName.slice(2).replace(/\.js$/, ''));
    }
    const output = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    } }).outputText;
    await fs.writeFile(path.join(modules, name + '.js'), output);
  };
  await compile('server');
  const { default: guardPlugin } = await import(/* @vite-ignore */ pathToFileURL(path.join(modules, 'server.js')).href);
  await guardPlugin(guard.bb);
  const status = await guard.harness.behavior.callRpc('status', null) as { pool: unknown };
  expect(status.pool).toEqual({ linked: true, vpnPolicyVersion: 2, error: null });
  expect(calls).toContain('vpnPolicy.get');
  const policy = await pool.harness.behavior.callRpc('vpnPolicy.get', null);
  expect(Object.keys(policy as object).sort()).toEqual(['vpnGuardEnabled', 'vpnOnlyProviders', 'vpnPolicyVersion']);
  expect(await pool.harness.behavior.callRpc('config.get', null)).toMatchObject(policy as object);
  expect(() => registrations['vpnPolicy.get']!(null, { experimental_caller: { kind: 'plugin', pluginId: 'untrusted' } })).toThrow();
});
