import { spawn } from 'node:child_process';
import type {Route} from './contract.js';
class CredentialProcessError extends Error {}
export type Runner = (binary: string, args: string[], env: NodeJS.ProcessEnv, input?: string, signal?: AbortSignal) => Promise<string>;
export const runProcess: Runner = (binary, args, env, input, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
        reject(new Error('Operation cancelled'));
        return;
    }
    const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let exceeded = false;
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, 90000);
    signal?.addEventListener('abort', kill, { once: true });
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
    child.stdout.on('data', chunk => { if (output.length + chunk.length > 1048576) {
        exceeded = true;
        kill();
    }
    else
        output += chunk; });
    child.stderr.resume();
    child.on('error', () => { finish(); reject(new Error('Credential process could not start')); });
    child.on('close', code => { finish();
    if (code !== 0 || exceeded || signal?.aborted)
        reject(new CredentialProcessError('process exit ' + code + '; output suppressed'));
    else
        resolve(output); });
    child.stdin.on('error', () => { });
    child.stdin.end(input);
});
export async function storeCredential(run: Runner, env: NodeJS.ProcessEnv, vault: string, title: string, username: string, password: string, signal?: AbortSignal) {
    const op = async (args: string[], input?: unknown) => { try {
        return JSON.parse(await run('op', args, env, input === undefined ? undefined : JSON.stringify(input), signal));
    }
    catch (error) {
            throw new Error('1Password ' + args.slice(0, 2).join(' ') + ' failed' + (error instanceof CredentialProcessError ? ': ' + error.message : '') + '; retry the same title to recover an uncertain write');
    } };
    const items = await op(['item', 'list', '--vault', vault, '--format=json']);
    if (!Array.isArray(items))
        throw new Error('Invalid item list');
    const matches = items.filter((x: {
        title: string;
    }) => x.title === title);
    if (matches.length > 1)
        throw new Error('Duplicate titles need owner review');
    let itemId = matches[0]?.id;
    if (!itemId) {
        const template = await op(['item', 'template', 'get', 'Login', '--format=json']);
        template.title = title;
        for (const [id, value] of [['username', username], ['password', password]]) {
            const field = template.fields?.find((field: {id: string}) => field.id === id);
            if (!field) throw new Error('Login template is missing a required field');
            field.value = value;
        }
        const item = await op(['item', 'create', '--template', '/dev/stdin', '--vault', vault, '--format=json'], template);
        itemId = item.id;
    }
    if (typeof itemId !== 'string' || !itemId)
        throw new Error('No item identifier returned');
    const stored = await op(['item', 'get', itemId, '--vault', vault, '--reveal', '--format=json']);
    if (!Array.isArray(stored.fields))
        throw new Error('Invalid read-back response');
    const fields = new Map(stored.fields.map((x: {
        label: string;
        value: string;
    }) => [x.label, x.value]));
    if (fields.get('password') !== password || fields.get('username') !== username)
        throw new Error('Existing or created item differs; no overwrite performed');
    return { itemId, verified: true as const };
}
export function serviceEnvironment(token: string) {
    if (!token.trim())
        throw new Error('Scoped service account is missing');
    const env: NodeJS.ProcessEnv = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token.trim(), OP_BIOMETRIC_UNLOCK_ENABLED: 'false' };
    for (const key of Object.keys(env))
        if (key.startsWith('OP_SESSION') || key.startsWith('OP_CONNECT') || key === 'OP_RUN_NO_MASKING')
            delete env[key];
    return env;
}

function configuredOperation(route: Route, name: string) {
    const matches = route.operations.filter(x => x.name === name);
    if (matches.length !== 1) throw new Error('Operation is not configured');
    const operation = matches[0];
    for (const [key, reference] of Object.entries(operation.references)) {
        if (key.startsWith('OP_') || !reference.startsWith('op://' + route.vaultId + '/')) throw new Error('Reference is outside the configured vault');
    }
    return operation;
}
export async function readOperationBindings(run: Runner, env: NodeJS.ProcessEnv, route: Route, name: string, signal?: AbortSignal) {
    if (route.authentication !== 'desktop' || !route.requireApproval) throw new Error('Remote resolution requires approved desktop access');
    const operation = configuredOperation(route, name);
    const bindings: Record<string, string> = {};
    for (const [key, reference] of Object.entries(operation.references)) {
        bindings[key] = await run('op', ['read', '--no-newline', reference], env, undefined, signal);
    }
    return { ...bindings };
}
export async function executeOperationBindings(run: Runner, env: NodeJS.ProcessEnv, route: Route, name: string, bindings: Record<string, string>, signal?: AbortSignal) {
    const operation = configuredOperation(route, name);
    const keys = Object.keys(operation.references).sort();
    if (JSON.stringify(keys) !== JSON.stringify(Object.keys(bindings).sort()) || keys.some(key => typeof bindings[key] !== 'string')) throw new Error('Resolved fields do not match the configured operation');
    const childEnv = {...env};
    for (const key of Object.keys(childEnv)) if (key.startsWith('OP_')) delete childEnv[key];
    Object.assign(childEnv, bindings);
    await run(operation.argv[0], operation.argv.slice(1), childEnv, undefined, signal);
}

// Recover only vaults carrying this exact project marker; never adopt a namesake.
export async function provisionProjectVault(run: Runner, env: NodeJS.ProcessEnv, projectId: string, name: string, signal?: AbortSignal) {
    const description = 'Managed by Oxi Op for BB project ' + projectId;
    const op = async (args: string[]) => JSON.parse(await run('op', args, env, undefined, signal));
    const vaults = await op(['vault', 'list', '--format=json']);
    if (!Array.isArray(vaults)) throw new Error('Invalid vault list');
    const matches = vaults.filter((v: {name: string}) => v.name === name);
    if (matches.length > 1) throw new Error('Duplicate vault names require owner review');
    const candidate = matches[0] ?? await op(['vault', 'create', name, '--description', description, '--format=json']);
    if (typeof candidate.id !== 'string' || !candidate.id) throw new Error('Missing vault identifier');
    const verified = await op(['vault', 'get', candidate.id, '--format=json']);
    if (verified.id !== candidate.id || verified.name !== name || verified.description !== description) throw new Error('Vault identity differs; no route was configured');
    return {vaultId: verified.id as string, name};
}
