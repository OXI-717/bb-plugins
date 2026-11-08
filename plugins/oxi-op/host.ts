import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { randomUUID } from 'node:crypto';
import { contract, type Route } from './contract.js';
import { runProcess, storeCredential, serviceEnvironment, readOperationBindings, executeOperationBindings, provisionProjectVault, issueServiceAccounts, probeServiceScope, listVaultKeys, execWithKeys, runCommand } from './core.js';
const pending = new Set<string>();
async function environment(route: Route, signal: AbortSignal, serviceAccountToken?: string) {
    if (signal.aborted)
        throw new Error('Operation cancelled');
    if (route.authentication === 'desktop') {
        const env: NodeJS.ProcessEnv = { ...process.env, OP_BIOMETRIC_UNLOCK_ENABLED: 'true' };
        for (const key of Object.keys(env))
            if (key === 'OP_SERVICE_ACCOUNT_TOKEN' || key.startsWith('OP_SESSION') || key.startsWith('OP_CONNECT') || key === 'OP_RUN_NO_MASKING')
                delete env[key];
        return env;
    }
    return serviceEnvironment(route.tokenSetting ? serviceAccountToken ?? '' : process.env[route.tokenEnvironment!] ?? '');
}
export default experimental_defineHostEntry({ contract, handlers: {
        resolve: async ({route, operation}, ctx) => {
            const runner: typeof runProcess = (_binary, args, env, input, signal) => runProcess(route.opBinary, ['--account', route.accountId!, ...args], env, input, signal);
            return {bindings: await readOperationBindings(runner, await environment(route, ctx.signal), route, operation, ctx.signal)};
        },
        execute: async ({route, operation, bindings}, ctx) => {
            if (route.authentication !== 'desktop' || !route.requireApproval || !route.credentialHostId) throw new Error('Remote execution requires approved desktop access');
            await executeOperationBindings(runProcess, process.env, route, operation, bindings, ctx.signal);
            return {completed: true as const};
        },
        provisionVault: async ({route, projectId, name, existingVaultId}, ctx) => {
            if (route.authentication !== 'desktop' || !route.requireApproval) throw new Error('Project setup requires owner desktop approval');
            const runner: typeof runProcess = (_binary, args, env, input, signal) => runProcess(route.opBinary, ['--account', route.accountId!, ...args], env, input, signal);
            return provisionProjectVault(runner, await environment(route, ctx.signal), projectId, name, ctx.signal, existingVaultId);
        },
        issueServiceAccounts: async ({route, ...request}, ctx) => {
            if (route.authentication !== 'desktop' || !route.requireApproval) throw new Error('Service account issuance requires owner desktop approval');
            const runner: typeof runProcess = (_binary, args, env, input, signal) => runProcess(route.opBinary, ['--account', route.accountId!, ...args], env, input, signal);
            return issueServiceAccounts(runner, await environment(route, ctx.signal), request, ctx.signal);
        },
        listKeys: async ({route, serviceAccountToken}, ctx) => {
            if (route.authentication !== 'service-account') throw new Error('Key listing requires a service account');
            const runner: typeof runProcess = (_binary, args, env, input, signal) => runProcess(route.opBinary, args, env, input, signal);
            return listVaultKeys(runner, await environment(route, ctx.signal, serviceAccountToken), route.vaultId, ctx.signal);
        },
        exec: async ({route, serviceAccountToken, argv, keys, cwd, timeoutSeconds}, ctx) => {
            if (route.authentication !== 'service-account' || route.requireApproval || !route.allowAgentCommands) throw new Error('Agent commands are not enabled for this access profile');
            const runner: typeof runProcess = (_binary, args, env, input, signal) => runProcess(route.opBinary, args, env, input, signal);
            return execWithKeys(runner, runCommand, await environment(route, ctx.signal, serviceAccountToken), route.vaultId, argv, keys, cwd, timeoutSeconds * 1000, ctx.signal);
        },
        probeScope: async ({route, serviceAccountToken}, ctx) => {
            if (route.authentication !== 'service-account') throw new Error('Scope probes require a service account');
            const runner: typeof runProcess = (_binary, args, env, input, signal) => runProcess(route.opBinary, args, env, input, signal);
            return probeServiceScope(runner, await environment(route, ctx.signal, serviceAccountToken), route.vaultId, ctx.signal);
        },
        inventory: async ({route, registryTitle}, ctx) => {
            if (route.authentication !== 'desktop') throw new Error('Registry inventory requires explicit owner desktop access');
            const env = await environment(route, ctx.signal);
            const args = ['--account', route.accountId!];
            const registry = JSON.parse(await runProcess(route.opBinary, [...args, 'item', 'get', registryTitle, '--vault', route.vaultId, '--format=json', '--reveal'], env, undefined, ctx.signal));
            const notes = String(registry.notesPlain ?? '') + '\n' + (registry.fields ?? []).filter((x: {id: string}) => x.id === 'notesPlain').map((x: {value: string}) => x.value).join('\n');
            const ids = new Set(notes.match(/\b[a-z2-7]{26}\b/g) ?? []);
            const vaults = JSON.parse(await runProcess(route.opBinary, [...args, 'vault', 'list', '--format=json'], env, undefined, ctx.signal));
            return {vaults: vaults.filter((x: {id: string}) => ids.has(x.id)).map((x: {id: string; name: string}) => ({id: x.id, name: x.name}))};
        },
        verify: async ({route, serviceAccountToken}, ctx) => {
            const env = await environment(route, ctx.signal, serviceAccountToken);
            const title = 'OXI OP verification ' + randomUUID();
            const username = 'synthetic-verification';
            const password = randomUUID();
            const runner: typeof runProcess = (binary, args, values, input, signal) => runProcess(route.opBinary, route.authentication === 'desktop' ? ['--account', route.accountId!, ...args] : args, values, input, signal);
            let itemId: string | undefined;
            let failure: unknown;
            try {
                const result = await storeCredential(runner, env, route.vaultId, title, username, password, ctx.signal);
                itemId = result.itemId;
            } catch (error) {
                failure = error;
                throw error;
            } finally {
                // Recover an uncertain create, but remove only our exact synthetic item.
                const items = JSON.parse(await runner('op', ['item', 'list', '--vault', route.vaultId, '--format=json'], env));
                const matches = items.filter((item: {title: string}) => item.title === title);
                if (matches.length === 0 && !itemId) throw failure ?? new Error('Verification did not create an item; no cleanup needed');
                if (matches.length !== 1) throw new Error('Verification cleanup needs owner review: ' + title);
                const candidate = matches[0].id;
                const stored = JSON.parse(await runner('op', ['item', 'get', candidate, '--vault', route.vaultId, '--format=json', '--reveal'], env));
                const fields = new Map(stored.fields.map((field: {label: string; value: string}) => [field.label, field.value]));
                if (stored.title !== title || fields.get('username') !== username || fields.get('password') !== password || (itemId && itemId !== candidate)) throw new Error('Verification item differs; cleanup declined: ' + title);
                await runner('op', ['item', 'delete', candidate, '--vault', route.vaultId], env);
                const remaining = JSON.parse(await runner('op', ['item', 'list', '--vault', route.vaultId, '--format=json'], env));
                if (remaining.some((item: {id: string}) => item.id === candidate)) throw new Error('Verification cleanup could not be confirmed');
            }
            return {verified: true as const, cleaned: true as const};
        },
        check: async ({ route, serviceAccountToken }, ctx) => {
            const env = await environment(route, ctx.signal, serviceAccountToken);
            const result = await runProcess(route.opBinary, [...(route.authentication === 'desktop' ? ['--account', route.accountId!] : []), 'vault', 'get', route.vaultId, '--format=json'], env, undefined, ctx.signal);
            try {
                if (JSON.parse(result).id !== route.vaultId)
                    throw new Error();
            }
            catch {
                throw new Error('The configured vault could not be verified');
            }
            return { authorized: true as const };
        },
        store: async ({ route, title, username, password, serviceAccountToken }, ctx) => {
            const key = route.vaultId + '\0' + title;
            if (pending.has(key))
                throw new Error('This item is already being stored');
            pending.add(key);
            const runner: typeof runProcess = (binary, args, env, input, signal) => runProcess(route.opBinary, route.authentication === 'desktop' ? ['--account', route.accountId!, ...args] : args, env, input, signal);
            try {
                return await storeCredential(runner, await environment(route, ctx.signal, serviceAccountToken), route.vaultId, title, username, password, ctx.signal);
            }
            finally {
                pending.delete(key);
            }
        },
        run: async ({ route, operation, serviceAccountToken }, ctx) => {
            const matches = route.operations.filter(x => x.name === operation);
            if (matches.length !== 1)
                throw new Error('Operation is not configured');
            const op = matches[0];
            const env = await environment(route, ctx.signal, serviceAccountToken);
            for (const [key, ref] of Object.entries(op.references)) {
                if (key.startsWith('OP_') || !ref.startsWith('op://' + route.vaultId + '/'))
                    throw new Error('Reference is outside the configured vault');
                env[key] = ref;
            }
            await runProcess(route.opBinary, [...(route.authentication === 'desktop' ? ['--account', route.accountId!] : []), 'run', '--', ...op.argv], env, undefined, ctx.signal);
            return { completed: true as const };
        }
    } });
