import fs from 'node:fs/promises';
import type { BbPluginApi, PluginRpcHandlers } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { accountPoolRpcContract } from './rpc.js';
import { ManagementAccess, PoolManagementLocked } from './management-access.js';
import { managementRpcContract, managementUnlockSchema, type ManagementScope } from './management-wire.js';

type Handlers = PluginRpcHandlers<typeof accountPoolRpcContract>;
const readMethods = new Set([
  'maintenance.status', 'update.status', 'native.accounts', 'egress.status', 'readiness.get',
  'thread.account', 'account.list', 'projects.list', 'config.get', 'status.get', 'status.routedThreads',
]);
const rpcScope = (method: string): ManagementScope => readMethods.has(method) ? 'read' : 'manage';
const readCli = (argv: string[]) =>
  (['status', 'readiness'].includes(argv[0] ?? '')) ||
  (argv[0] === 'account' && argv[1] === 'list') ||
  (argv[0] === 'config' && (argv.length === 1 || argv[1] === 'get')) ||
  (argv[0] === 'browser' && argv[1] === 'list') ||
  (['egress', 'native', 'maintenance'].includes(argv[0] ?? '') && argv[1] === 'status');

export function managementInvoke(access: ManagementAccess, handlers: Handlers) {
  return async (token: string, method: string, input: unknown): Promise<unknown> => {
    access.assert(token, rpcScope(method));
    if (!Object.hasOwn(accountPoolRpcContract, method) || !Object.hasOwn(handlers, method)) throw new PoolManagementLocked();
    const name = method as keyof Handlers;
    const parsed = accountPoolRpcContract[name].input.safeParse(input);
    if (!parsed.success) throw new Error('Invalid management request.');
    access.assert(token, rpcScope(method));
    const handler = handlers[name] as (input: unknown) => unknown;
    const result = await handler(parsed.data);
    if (rpcScope(method) === 'read') access.assert(token, 'read');
    const output = accountPoolRpcContract[name].output.safeParse(result);
    if (!output.success) throw new Error('Invalid management response.');
    return output.data;
  };
}

export function registerManagementRpc(bb: Pick<BbPluginApi, 'rpc'>, access: ManagementAccess, handlers: Handlers): void {
  const invoke = managementInvoke(access, handlers);
  const guarded = Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method,
    (input: unknown, context?: unknown) => {
      const caller = (context as { experimental_caller?: { kind?: string; pluginId?: string } } | undefined)?.experimental_caller;
      if (caller?.kind !== 'plugin' || caller.pluginId !== 'model-connections' || !['status.get', 'thread.account'].includes(method)) throw new PoolManagementLocked();
      return (handler as (input: unknown) => unknown)(input);
    },
  ])) as Handlers;
  bb.rpc.register(accountPoolRpcContract, guarded);
  bb.rpc.register(managementRpcContract, {
    'management.unlock': ({ key, scope, ttlSeconds }) => access.unlock(key, scope, ttlSeconds),
    'management.call': async ({ token, method, input }) => {
      try { return { ok: true as const, result: await invoke(token, method, input) }; }
      catch (error) { if (error instanceof PoolManagementLocked) return { ok: false as const, code: 'pool-management-locked' as const }; throw error; }
    },
    'management.lock': ({ token }) => { access.revoke(token); return null; },
    'public.status': () => ({ management: 'locked' as const }),
  });
}

const cliUnlockSchema = managementUnlockSchema.extend({ output: z.string().min(1).max(4096) }).strict();
const cliExecuteSchema = z.object({ token: z.string().max(256), argv: z.array(z.string()).min(1).max(128) }).strict();

export function managementCli(bb: Pick<BbPluginApi, 'cli' | 'server' | 'pluginId'>, access: ManagementAccess): Pick<BbPluginApi, 'cli' | 'server' | 'pluginId'> {
  return {
    server: bb.server, pluginId: bb.pluginId,
    cli: { register(registration) {
      bb.cli.register({
        ...registration,
        commands: [...(registration.commands ?? []), {
          name: 'management', summary: 'Use a private, short-lived operator access grant',
          usage: 'bb pool management <unlock|execute|lock> --request-stdin',
        }],
        async run(argv, context) {
          try {
            if (argv[0] !== 'management') {
              if ((argv[0] === 'status' || argv[0] === 'readiness') && argv.slice(1).every(arg => arg === '--json')) return { exitCode: 0, stdout: JSON.stringify({ management: 'locked' }) + '\n' };
              if (argv.length === 0 || argv.includes('--help')) return { exitCode: 0, stdout: 'Pool management requires an operator-issued grant.\nUse: bb pool management <unlock|execute|lock> --request-stdin\nPublic status: bb pool status --json\n' };
              throw new PoolManagementLocked();
            }
            if (argv.length !== 4 || argv[2] !== '--request') throw new Error('Use management <unlock|execute|lock> --request-stdin.');
            let value: unknown;
            try { value = JSON.parse(argv[3]!); } catch { throw new Error('Invalid private management request.'); }
            if (argv[1] === 'unlock') {
              const parsed = cliUnlockSchema.safeParse(value);
              if (!parsed.success) throw new Error('Invalid private management request.');
              const { key, scope, ttlSeconds, output } = parsed.data;
              const grant = access.unlock(key, scope, ttlSeconds);
              try {
                const file = await fs.open(output, 'wx', 0o600);
                try { await file.writeFile(JSON.stringify(grant) + '\n'); }
                finally { await file.close(); }
              } catch { access.revoke(grant.token); throw new Error('Cannot create the private grant file; use a new file on the pool server.'); }
              return { exitCode: 0, stdout: JSON.stringify({ issued: true, scope, expiresAt: grant.expiresAt }) + '\n' };
            }
            if (argv[1] === 'lock') {
              const parsed = managementRpcContract['management.lock'].input.safeParse(value);
              if (!parsed.success) throw new Error('Invalid private management request.');
              access.revoke(parsed.data.token);
              return { exitCode: 0, stdout: 'Management grant revoked.\n' };
            }
            if (argv[1] !== 'execute') throw new PoolManagementLocked();
            const parsed = cliExecuteSchema.safeParse(value);
            if (!parsed.success) throw new Error('Invalid private management request.');
            access.assert(parsed.data.token, readCli(parsed.data.argv) ? 'read' : 'manage');
            if (parsed.data.argv[0] === 'management') throw new PoolManagementLocked();
            const result = await registration.run(parsed.data.argv, context);
            if (readCli(parsed.data.argv)) access.assert(parsed.data.token, 'read');
            return result;
          } catch (error) {
            return { exitCode: 1, stderr: error instanceof PoolManagementLocked ? error.message : 'Invalid or unavailable private management request.' };
          }
        },
      });
    } },
  };
}
