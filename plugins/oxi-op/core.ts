import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {Route} from './contract.js';
class CredentialProcessError extends Error {}
export type Runner = (binary: string, args: string[], env: NodeJS.ProcessEnv, input?: string, signal?: AbortSignal) => Promise<string>;
export const runProcess: Runner = (binary, args, env, input, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
        reject(new Error('Operation cancelled'));
        return;
    }
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
        reject(new Error('Credential operation requires a supported POSIX host'));
        return;
    }
    // The configured operation and its ordinary descendants own one group.
    // Killing only the leader can retain both credentials and inherited pipes.
    const child = spawn(binary, args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let exceeded = false;
    let expired = false;
    let cleanupFailed = false;
    let finished = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
        finished = true;
        clearTimeout(timer); clearTimeout(cleanupTimer);
        signal?.removeEventListener('abort', kill);
    };
    const kill = () => {
        if (finished) return;
        try {if (child.pid) process.kill(-child.pid, 'SIGKILL');}
        catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupFailed = true;}
        // Even an unsupported self-detaching process retaining a pipe must not
        // make the RPC unbounded. It is never reported as successful cleanup.
        cleanupTimer ??= setTimeout(() => {
            child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
            finish(); reject(new Error('Credential operation cleanup unconfirmed'));
        }, 1000);
    };
    const timer = setTimeout(() => {expired = true; kill();}, 90000);
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', chunk => {
        if (output.length + chunk.length > 1048576) {exceeded = true; kill();}
        else output += chunk;
    });
    child.stderr.resume();
    child.on('exit', kill); // A successful leader cannot leave its group behind.
    child.on('error', () => {kill(); finish(); reject(new Error('Credential process could not start'));});
    child.on('close', code => {
        if (finished) return;
        finish();
        if (code !== 0 || exceeded || expired || cleanupFailed || signal?.aborted)
            reject(new CredentialProcessError('process exit ' + code + '; output suppressed'));
        else resolve(output);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    if (signal?.aborted) kill();
});
// op on Linux rejects a template read from /dev/stdin (exit 9); macOS accepts it. On Linux the
// template goes to a 0600 file in a private 0700 directory, memory-backed (XDG_RUNTIME_DIR or /dev/shm)
// when available, removed immediately after the call.
export async function withTemplateFile<T>(json: string, platform: NodeJS.Platform, use: (path: string, input?: unknown) => Promise<T>) {
    if (platform !== 'linux') return use('/dev/stdin', JSON.parse(json));
    const directory = await mkdtemp(join(process.env.XDG_RUNTIME_DIR || (existsSync('/dev/shm') ? '/dev/shm' : tmpdir()), 'oxi-op-'));
    try {
        await chmod(directory, 0o700);
        const path = join(directory, 'item.json');
        await writeFile(path, json, {mode: 0o600, flag: 'wx'});
        return await use(path);
    } finally {await rm(directory, {recursive: true, force: true});}
}
export async function storeCredential(run: Runner, env: NodeJS.ProcessEnv, vault: string, title: string, username: string, password: string, signal?: AbortSignal, platform: NodeJS.Platform = process.platform) {
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
        const item = await withTemplateFile(JSON.stringify(template), platform, (path, input) => op(['item', 'create', '--template', path, '--vault', vault, '--format=json'], input));
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
export async function provisionProjectVault(run: Runner, env: NodeJS.ProcessEnv, projectId: string, name: string, signal?: AbortSignal, existingVaultId?: string) {
    const description = 'Managed by Oxi Op for BB project ' + projectId;
    const op = async (args: string[]) => JSON.parse(await run('op', args, env, undefined, signal));
    if (existingVaultId) {
        const verified = await op(['vault', 'get', existingVaultId, '--format=json']);
        const normalized = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '');
        if (verified.id !== existingVaultId || typeof verified.name !== 'string' || normalized(verified.name) !== normalized(name)) throw new Error('Existing vault identity differs; no route configured');
        return {vaultId: existingVaultId, name: verified.name as string};
    }
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

export type ServiceAccountRequest = {profile: string; name: string; permissions: ('read_items' | 'write_items')[]};
export const serviceAccountBackupTitle = (name: string) => 'Oxi Op service account — ' + name;
// A token is shown once by 1Password. Back it up before returning it, and recover the
// backup on retry instead of issuing a duplicate service account.
export async function issueServiceAccounts(run: Runner, env: NodeJS.ProcessEnv, request: {projectId: string; vaultName: string; backupVaultId: string; expiresIn: string; accounts: ServiceAccountRequest[]}, signal?: AbortSignal) {
    const {vaultId, name: vaultName} = await provisionProjectVault(run, env, request.projectId, request.vaultName, signal);
    const accounts: {profile: string; token: string; recovered: boolean}[] = [];
    for (const account of request.accounts) {
        const title = serviceAccountBackupTitle(account.name);
        let items: {id: string; title: string}[];
        try {items = JSON.parse(await run('op', ['item', 'list', '--vault', request.backupVaultId, '--format=json'], env, undefined, signal));}
        catch {throw new Error('The token backup vault could not be listed; no service account was issued');}
        const matches = items.filter(item => item.title === title);
        if (matches.length > 1) throw new Error('Duplicate token backups need owner review');
        if (matches.length === 1) {
            let stored: {fields?: {label: string; value: string}[]};
            try {stored = JSON.parse(await run('op', ['item', 'get', matches[0].id, '--vault', request.backupVaultId, '--reveal', '--format=json'], env, undefined, signal));}
            catch {throw new Error('An existing token backup could not be read; owner review is required');}
            const token = stored.fields?.find(field => field.label === 'password')?.value;
            if (!token) throw new Error('An existing token backup is incomplete; owner review is required');
            accounts.push({profile: account.profile, token, recovered: true});
            continue;
        }
        let token: string;
        try {token = (await run('op', ['service-account', 'create', account.name, '--vault', vaultId + ':' + account.permissions.join(','), '--expires-in', request.expiresIn, '--raw'], env, undefined, signal)).trim();}
        catch {throw new Error('1Password did not confirm service account creation; owner review is required before retrying');}
        if (!token || /\s/.test(token)) throw new Error('1Password returned an unexpected service account response; owner review is required');
        try {await storeCredential(run, env, request.backupVaultId, title, account.name, token, signal);}
        catch {throw new Error('The service account was created but its token backup failed; owner review is required');}
        accounts.push({profile: account.profile, token, recovered: false});
    }
    return {vaultId, vaultName, accounts};
}
// Fixed codes only: our storeCredential messages carry no provider output, but keep to a whitelist.
function writeFailureCode(error: unknown) {
    const message = error instanceof Error ? error.message : '';
    const step = /^1Password item (list|template|create|get) failed/.exec(message)?.[1] ?? (message.includes('differs') ? 'readback-differs' : message.includes('template is missing') ? 'template-fields' : 'unknown');
    const exit = /process exit (\d{1,3})/.exec(message)?.[1];
    return step + (exit ? '-exit-' + exit : '');
}
// Prove what a service account can actually do: it must see exactly one vault, read it,
// and report whether 1Password accepts a write there.
export async function probeServiceScope(run: Runner, env: NodeJS.ProcessEnv, vaultId: string, signal?: AbortSignal) {
    const vaults = JSON.parse(await run('op', ['vault', 'list', '--format=json'], env, undefined, signal));
    if (!Array.isArray(vaults) || vaults.length !== 1 || vaults[0]?.id !== vaultId) throw new Error('Service account scope differs from the automation vault');
    try {JSON.parse(await run('op', ['item', 'list', '--vault', vaultId, '--format=json'], env, undefined, signal));}
    catch {throw new Error('Service account could not read the automation vault');}
    let itemId: string;
    try {itemId = (await storeCredential(run, env, vaultId, 'OXI OP write probe ' + randomUUID(), 'synthetic-probe', randomUUID(), signal)).itemId;}
    catch (error) {return {vaultIds: [vaultId], writable: false, writeFailure: writeFailureCode(error)};}
    await run('op', ['item', 'delete', itemId, '--vault', vaultId], env, undefined, signal);
    return {vaultIds: [vaultId], writable: true};
}

export type KeyReference = {item: string; field: string};
// Titles and field labels only; values are never returned by this listing.
export async function listVaultKeys(run: Runner, env: NodeJS.ProcessEnv, vaultId: string, signal?: AbortSignal) {
    const items = JSON.parse(await run('op', ['item', 'list', '--vault', vaultId, '--format=json'], env, undefined, signal));
    if (!Array.isArray(items)) throw new Error('Invalid item list');
    const result: {item: string; fields: string[]}[] = [];
    for (const entry of items.slice(0, 200)) {
        if (typeof entry?.id !== 'string' || typeof entry?.title !== 'string') continue;
        const item = JSON.parse(await run('op', ['item', 'get', entry.id, '--vault', vaultId, '--format=json'], env, undefined, signal));
        const fields = Array.isArray(item.fields) ? item.fields.map((field: {label?: unknown}) => field.label).filter((label: unknown): label is string => typeof label === 'string' && label.length > 0 && !label.includes('/')) : [];
        result.push({item: entry.title, fields: [...new Set(fields as string[])]});
    }
    return {items: result};
}
export type CommandResult = {exitCode: number; output: string; truncated: boolean};
export type CommandRunner = (binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string | undefined, timeoutMs: number, signal?: AbortSignal) => Promise<CommandResult>;
const outputLimit = 32768;
export const runCommand: CommandRunner = (binary, args, env, cwd, timeoutMs, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {reject(new Error('Operation cancelled')); return;}
    if (process.platform !== 'linux' && process.platform !== 'darwin') {reject(new Error('Agent commands require a supported POSIX host')); return;}
    // The command and its descendants own one process group: they carry key values in their
    // environment, so a timeout or cancellation must not leave any of them running.
    const child = spawn(binary, args, {env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    let truncated = false;
    let finished = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {finished = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', kill);};
    const kill = () => {
        if (finished) return;
        try {if (child.pid) process.kill(-child.pid, 'SIGKILL');} catch {}
        cleanupTimer ??= setTimeout(() => {child.stdout.destroy(); child.stderr.destroy(); finish(); reject(new Error('Agent command cleanup unconfirmed'));}, 1000);
    };
    const timer = setTimeout(() => {truncated = true; kill();}, timeoutMs);
    signal?.addEventListener('abort', kill, {once: true});
    const collect = (chunk: Buffer) => {output += chunk.toString('utf8'); if (output.length > outputLimit * 2) {output = output.slice(-outputLimit); truncated = true;}};
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('exit', () => {try {if (child.pid) process.kill(-child.pid, 'SIGKILL');} catch {}}); // the leader's exit ends its group
    child.on('error', () => {kill(); finish(); reject(new Error('Command could not start'));});
    child.on('close', code => {
        if (finished) return;
        finish();
        if (signal?.aborted) {reject(new Error('Operation cancelled')); return;}
        if (output.length > outputLimit) {output = output.slice(-outputLimit); truncated = true;}
        resolve({exitCode: code ?? 137, output, truncated});
    });
});
// Read only the requested fields with the scoped token, then run the agent's command without
// any OP_ variables so the child never receives the service-account token. Exact values are
// replaced in the returned output.
export async function execWithKeys(run: Runner, command: CommandRunner, env: NodeJS.ProcessEnv, vaultId: string, argv: string[], keys: Record<string, KeyReference>, cwd: string | undefined, timeoutMs: number, signal?: AbortSignal) {
    const values: Record<string, string> = {};
    for (const [variable, key] of Object.entries(keys)) {
        if (variable.startsWith('OP_') || key.item.includes('/') || key.field.includes('/')) throw new Error('Key reference is not allowed');
        try {values[variable] = await run('op', ['read', '--no-newline', 'op://' + vaultId + '/' + key.item + '/' + key.field], env, undefined, signal);}
        catch {throw new Error('Key ' + key.item + ' / ' + key.field + ' could not be read from the automation vault');}
    }
    const childEnv: NodeJS.ProcessEnv = {...process.env};
    for (const name of Object.keys(childEnv)) if (name.startsWith('OP_')) delete childEnv[name];
    Object.assign(childEnv, values);
    try {
        const result = await command(argv[0], argv.slice(1), childEnv, cwd, timeoutMs, signal);
        let output = result.output;
        for (const value of Object.values(values).filter(Boolean).sort((a, b) => b.length - a.length)) output = output.split(value).join('<concealed>');
        return {...result, output};
    } finally {for (const key of Object.keys(values)) delete values[key];}
}

// Diagnostic: compare item-creation methods with synthetic random values only, then remove them.
export async function probeWriteMethods(run: Runner, env: NodeJS.ProcessEnv, vaultId: string, signal?: AbortSignal) {
    const prefix = 'OXI OP method probe ' + randomUUID() + ' ';
    const code = (error: unknown) => {const exit = /process exit (\d{1,3}|null)/.exec(error instanceof Error ? error.message : '')?.[1]; return 'failed' + (exit ? '-exit-' + exit : '');};
    const results: Record<string, string> = {};
    let template: {title?: string; fields?: {id: string; value?: string}[]};
    try {template = JSON.parse(await run('op', ['item', 'template', 'get', 'Login', '--format=json'], env, undefined, signal)); results.template = 'ok';}
    catch (error) {return {results: {template: code(error)}};}
    const filled = (title: string) => ({...template, title, fields: (template.fields ?? []).map(f => f.id === 'username' ? {...f, value: 'synthetic-probe'} : f.id === 'password' ? {...f, value: randomUUID()} : f)});
    const attempts: [string, string[], string | undefined][] = [
        ['template-dev-stdin', ['item', 'create', '--template', '/dev/stdin', '--vault', vaultId, '--format=json'], JSON.stringify(filled(prefix + 'a'))],
        ['piped-json', ['item', 'create', '--vault', vaultId, '--format=json'], JSON.stringify(filled(prefix + 'b'))],
        ['assignment', ['item', 'create', '--category', 'Login', '--title', prefix + 'c', '--vault', vaultId, '--format=json', 'username=synthetic-probe', 'password=' + randomUUID()], undefined],
    ];
    for (const [name, args, input] of attempts) {
        try {await run('op', args, env, input, signal); results[name] = 'ok';}
        catch (error) {results[name] = code(error);}
    }
    try {
        const items = JSON.parse(await run('op', ['item', 'list', '--vault', vaultId, '--format=json'], env, undefined, signal));
        for (const item of items.filter((x: {title: string}) => x.title.startsWith(prefix))) await run('op', ['item', 'delete', item.id, '--vault', vaultId], env, undefined, signal);
        const left = JSON.parse(await run('op', ['item', 'list', '--vault', vaultId, '--format=json'], env, undefined, signal));
        results.cleanup = left.some((x: {title: string}) => x.title.startsWith(prefix)) ? 'incomplete' : 'ok';
    } catch (error) {results.cleanup = code(error);}
    return {results};
}
