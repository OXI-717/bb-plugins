import { spawn } from 'node:child_process';
import { CodedError, errorCode } from './errors.js';
export { CodedError, errorCode } from './errors.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {Route} from './contract.js';
class CredentialProcessError extends CodedError {constructor(message: string) {super('op-exit', message);}}

export type Runner = (binary: string, args: string[], env: NodeJS.ProcessEnv, input?: string, signal?: AbortSignal) => Promise<string>;
export type GroupResult = {code: number | null; output: Buffer; truncated: boolean; expired: boolean; escaped: boolean};
// One process group per operation: the command and every ordinary descendant end together.
// Killing only the leader could leave descendants holding credentials and inherited pipes.
// Output is kept as bytes so multibyte characters split across pipe chunks stay intact.
export function spawnGroup(binary: string, args: string[], options: {env: NodeJS.ProcessEnv; cwd?: string; input?: string; timeoutMs: number; maxBytes: number; overflow: 'fail' | 'keep-tail'; includeStderr: boolean; onEscape?: 'reject' | 'report'; signal?: AbortSignal}) {
    return new Promise<GroupResult>((resolve, reject) => {
        if (options.signal?.aborted) {reject(new CodedError('cancelled', 'Operation cancelled')); return;}
        if (process.platform !== 'linux' && process.platform !== 'darwin') {reject(new Error('Operation requires a supported POSIX host')); return;}
        const child = spawn(binary, args, {env: options.env, cwd: options.cwd, detached: true, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']});
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        let exceeded = false;
        let expired = false;
        let cleanupFailed = false;
        let finished = false;
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        let leaderCode: number | null = null;
        const finish = () => {finished = true; clearTimeout(timer); clearTimeout(cleanupTimer); options.signal?.removeEventListener('abort', kill);};
        let leaderExited = false;
        // After the leader has exited, macOS answers EPERM for a group that holds only zombies.
        const killGroup = () => {
            try {if (child.pid) process.kill(-child.pid, 'SIGKILL');}
            catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'ESRCH' && !(code === 'EPERM' && leaderExited)) cleanupFailed = true;
            }
        };
        // A process that left the group and keeps our pipes open must not hold the call open.
        const kill = () => {
            if (finished) return;
            killGroup();
            cleanupTimer ??= setTimeout(() => {
                child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
                finish();
                // An agent command that completed is reported with what it printed; the escape is
                // flagged rather than hidden behind a failure that could invite a repeated run.
                if (options.onEscape === 'report' && !expired && !options.signal?.aborted) resolve({code: leaderCode ?? 137, output: Buffer.concat(chunks).subarray(-options.maxBytes), truncated, expired, escaped: true});
                else reject(new CodedError('cleanup-unconfirmed', 'Process cleanup unconfirmed: a process kept running outside its group'));
            }, 1000);
        };
        const timer = setTimeout(() => {expired = true; kill();}, options.timeoutMs);
        options.signal?.addEventListener('abort', kill, {once: true});
        const collect = (chunk: Buffer) => {
            chunks.push(chunk); bytes += chunk.length;
            if (bytes <= options.maxBytes) return;
            if (options.overflow === 'fail') {exceeded = true; kill(); return;}
            truncated = true;
            while (chunks.length > 1 && bytes - chunks[0].length >= options.maxBytes) bytes -= chunks.shift()!.length;
        };
        child.stdout!.on('data', collect);
        if (options.includeStderr) child.stderr!.on('data', collect); else child.stderr!.resume();
        child.on('exit', code => {leaderCode = code; leaderExited = true; kill();}); // the leader's exit ends its group
        child.on('error', () => {kill(); finish(); reject(new Error('Process could not start'));});
        child.on('close', code => {
            if (finished) return;
            finish();
            if (options.signal?.aborted) {reject(new Error('Operation cancelled')); return;}
            if (exceeded || cleanupFailed) {reject(new CredentialProcessError('process exit ' + code + '; output suppressed')); return;}
            let output = Buffer.concat(chunks);
            if (output.length > options.maxBytes) output = output.subarray(output.length - options.maxBytes);
            resolve({code, output, truncated, expired, escaped: false});
        });
        child.stdin?.on('error', () => {});
        child.stdin?.end(options.input);
        if (options.signal?.aborted) kill();
    });
}
export const runProcess: Runner = async (binary, args, env, input, signal) => {
    const result = await spawnGroup(binary, args, {env, input: input ?? '', timeoutMs: 90000, maxBytes: 1048576, overflow: 'fail', includeStderr: false, signal});
    if (result.code !== 0 || result.expired) throw new CredentialProcessError('process exit ' + result.code + '; output suppressed');
    return result.output.toString('utf8');
};
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
            throw new CodedError('op-' + args.slice(0, 2).join('-'), '1Password ' + args.slice(0, 2).join(' ') + ' failed' + (error instanceof CredentialProcessError ? ': ' + error.message : '') + '; retry the same title to recover an uncertain write');
    } };
    const items = await op(['item', 'list', '--vault', vault, '--format=json']);
    if (!Array.isArray(items))
        throw new Error('Invalid item list');
    const matches = items.filter((x: {
        title: string;
    }) => x.title === title);
    if (matches.length > 1)
        throw new CodedError('duplicate-items', 'Duplicate titles need owner review');
    let itemId = matches[0]?.id;
    if (!itemId) {
        const template = await op(['item', 'template', 'get', 'Login', '--format=json']);
        template.title = title;
        for (const [id, value] of [['username', username], ['password', password]]) {
            const field = template.fields?.find((field: {id: string}) => field.id === id);
            if (!field) throw new CodedError('template-fields', 'Login template is missing a required field');
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
        throw new CodedError('item-differs', 'Existing or created item differs; no overwrite performed');
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
        if (verified.id !== existingVaultId || typeof verified.name !== 'string' || normalized(verified.name) !== normalized(name)) throw new CodedError('vault-identity', 'Existing vault identity differs; no route configured');
        return {vaultId: existingVaultId, name: verified.name as string};
    }
    const vaults = await op(['vault', 'list', '--format=json']);
    if (!Array.isArray(vaults)) throw new Error('Invalid vault list');
    const matches = vaults.filter((v: {name: string}) => v.name === name);
    if (matches.length > 1) throw new CodedError('duplicate-vaults', 'Duplicate vault names require owner review');
    const candidate = matches[0] ?? await op(['vault', 'create', name, '--description', description, '--format=json']);
    if (typeof candidate.id !== 'string' || !candidate.id) throw new CodedError('vault-missing-id', 'Missing vault identifier');
    const verified = await op(['vault', 'get', candidate.id, '--format=json']);
    if (verified.id !== candidate.id || verified.name !== name || verified.description !== description) throw new CodedError('vault-identity', 'Vault identity differs; no route was configured');
    return {vaultId: verified.id as string, name};
}

export type ServiceAccountRequest = {profile: string; name: string; permissions: ('read_items' | 'write_items')[]};
export const serviceAccountBackupTitle = (name: string) => 'Oxi Op service account — ' + name;
// A token is shown once by 1Password. Back it up before returning it, and recover the
// backup on retry instead of issuing a duplicate service account.
const day = 86400000;
const renewAfterMs = 80 * day;
export async function issueServiceAccounts(run: Runner, env: NodeJS.ProcessEnv, request: {projectId: string; vaultName: string; backupVaultId: string; expiresIn: string; accounts: ServiceAccountRequest[]}, signal?: AbortSignal, now = Date.now()) {
    const {vaultId, name: vaultName} = await provisionProjectVault(run, env, request.projectId, request.vaultName, signal);
    const accounts: {profile: string; token: string; recovered: boolean}[] = [];
    for (const account of request.accounts) {
        const title = serviceAccountBackupTitle(account.name);
        let items: {id: string; title: string}[];
        try {items = JSON.parse(await run('op', ['item', 'list', '--vault', request.backupVaultId, '--format=json'], env, undefined, signal));}
        catch {throw new CodedError('backup-list-failed', 'The token backup vault could not be listed; no service account was issued');}
        const matches = items.filter(item => item.title === title);
        if (matches.length > 1) throw new CodedError('duplicate-backups', 'Duplicate token backups need owner review');
        if (matches.length === 1) {
            let stored: {created_at?: string; fields?: {label: string; value: string}[]};
            try {stored = JSON.parse(await run('op', ['item', 'get', matches[0].id, '--vault', request.backupVaultId, '--reveal', '--format=json'], env, undefined, signal));}
            catch {throw new CodedError('backup-read-failed', 'An existing token backup could not be read; owner review is required');}
            const created = Date.parse(stored.created_at ?? '');
            if (!Number.isFinite(created)) throw new CodedError('backup-age-unknown', 'An existing token backup has no creation date; owner review is required');
            if (now - created < renewAfterMs) {
                const token = stored.fields?.find(field => field.label === 'password')?.value;
                if (!token) throw new CodedError('backup-incomplete', 'An existing token backup is incomplete; owner review is required');
                accounts.push({profile: account.profile, token, recovered: true});
                continue;
            }
            // Near or past its 90-day expiry: keep the old backup under a dated title and issue anew.
            try {await run('op', ['item', 'edit', matches[0].id, '--vault', request.backupVaultId, '--title', title + ' (expired ' + new Date(created + 90 * day).toISOString().slice(0, 10) + ')'], env, undefined, signal);}
            catch {throw new CodedError('backup-rename-failed', 'An expiring token backup could not be set aside; no service account was issued');}
        }
        let token: string;
        try {token = (await run('op', ['service-account', 'create', account.name, '--vault', vaultId + ':' + account.permissions.join(','), '--expires-in', request.expiresIn, '--raw'], env, undefined, signal)).trim();}
        catch {throw new CodedError('create-unconfirmed', '1Password did not confirm service account creation; owner review is required before retrying');}
        if (!token || /\s/.test(token)) throw new CodedError('create-unexpected', '1Password returned an unexpected service account response; owner review is required');
        try {await storeCredential(run, env, request.backupVaultId, title, account.name, token, signal);}
        catch {throw new CodedError('backup-failed-after-create', 'The service account was created but its token backup failed; owner review is required');}
        accounts.push({profile: account.profile, token, recovered: false});
    }
    return {vaultId, vaultName, accounts};
}
// Fixed codes only: our storeCredential messages carry no provider output, but keep to a whitelist.
function writeFailureCode(error: unknown) {
    const code = errorCode(error);
    const step = code?.startsWith('op-item-') ? code.slice('op-item-'.length) : code === 'item-differs' ? 'readback-differs' : code ?? 'unknown';
    const exit = /process exit (\d{1,3})/.exec(error instanceof Error ? error.message : '')?.[1];
    return step + (exit ? '-exit-' + exit : '');
}
// Prove what a service account can actually do: it must see exactly one vault, read it,
// and report whether 1Password accepts a write there.
export async function probeServiceScope(run: Runner, env: NodeJS.ProcessEnv, vaultId: string, signal?: AbortSignal) {
    const vaults = JSON.parse(await run('op', ['vault', 'list', '--format=json'], env, undefined, signal));
    if (!Array.isArray(vaults) || vaults.length !== 1 || vaults[0]?.id !== vaultId) throw new CodedError('scope-differs', 'Service account scope differs from the automation vault');
    try {JSON.parse(await run('op', ['item', 'list', '--vault', vaultId, '--format=json'], env, undefined, signal));}
    catch {throw new CodedError('scope-unreadable', 'Service account could not read the automation vault');}
    let itemId: string;
    try {itemId = (await storeCredential(run, env, vaultId, 'OXI OP write probe ' + randomUUID(), 'synthetic-probe', randomUUID(), signal)).itemId;}
    catch (error) {
        // Only a refused create proves the account cannot write. Any later failure (for example a
        // read-back error after a successful create) is inconclusive and must not pass as denial.
        if (errorCode(error) !== 'op-item-create') throw new CodedError('probe-inconclusive', 'The write probe was inconclusive; no access was activated');
        return {vaultIds: [vaultId], writable: false, writeFailure: writeFailureCode(error)};
    }
    await run('op', ['item', 'delete', itemId, '--vault', vaultId], env, undefined, signal);
    return {vaultIds: [vaultId], writable: true};
}

export type KeyReference = {item: string; field: string};
// Titles and field labels only; values are never returned by this listing.
export async function listVaultKeys(run: Runner, env: NodeJS.ProcessEnv, vaultId: string, signal?: AbortSignal) {
    const items = JSON.parse(await run('op', ['item', 'list', '--vault', vaultId, '--format=json'], env, undefined, signal));
    if (!Array.isArray(items)) throw new Error('Invalid item list');
    const entries = items.slice(0, 200).filter(entry => typeof entry?.id === 'string' && typeof entry?.title === 'string');
    const result: {item: string; fields: string[]}[] = new Array(entries.length);
    let next = 0;
    let failed = false;
    // A few requests at a time: one per item is unavoidable, a serial chain is not. The first
    // failure stops the other workers so a rate limit is not hammered further.
    const worker = async () => {
        while (next < entries.length && !failed && !signal?.aborted) {
            const index = next++;
            let item;
            try {item = JSON.parse(await run('op', ['item', 'get', entries[index].id, '--vault', vaultId, '--format=json'], env, undefined, signal));}
            catch (error) {failed = true; throw error;}
            const fields = Array.isArray(item.fields) ? item.fields.map((field: {label?: unknown}) => field.label).filter((label: unknown): label is string => typeof label === 'string' && label.length > 0 && !label.includes('/')) : [];
            result[index] = {item: entries[index].title, fields: [...new Set(fields as string[])]};
        }
    };
    await Promise.all(Array.from({length: Math.min(4, entries.length)}, worker));
    return {items: result};
}
export type CommandResult = {exitCode: number; output: string; truncated: boolean; timedOut: boolean; escapedProcess: boolean};
export type CommandRunner = (binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string | undefined, timeoutMs: number, signal?: AbortSignal) => Promise<CommandResult>;
const outputLimit = 32768;
// Keep enough raw output to conceal key values before the final cut to the returned size.
const commandCaptureBytes = 1048576;
export const runCommand: CommandRunner = async (binary, args, env, cwd, timeoutMs, signal) => {
    const result = await spawnGroup(binary, args, {env, cwd, timeoutMs, maxBytes: commandCaptureBytes, overflow: 'keep-tail', includeStderr: true, onEscape: 'report', signal});
    return {exitCode: result.code ?? 137, output: result.output.toString('utf8'), truncated: result.truncated, timedOut: result.expired, escapedProcess: result.escaped};
};
// Replace exact key values in the full captured text first, then cut to the returned size.
// A cut can still split a value: the retained head of the output is dropped up to the next
// line break, and any remaining prefix that ends a key value is concealed as well.
export function concealOutput(raw: string, values: string[], alreadyTruncated: boolean) {
    const secrets = values.filter(Boolean).sort((a, b) => b.length - a.length);
    let output = raw;
    for (const value of secrets) output = output.split(value).join('<concealed>');
    let truncated = alreadyTruncated;
    if (alreadyTruncated || output.length > outputLimit) {
        truncated = true;
        if (output.length > outputLimit) output = output.slice(-outputLimit);
        const newline = output.indexOf('\n');
        output = newline >= 0 && newline < 4096 ? output.slice(newline + 1) : output;
        for (const value of secrets) for (let length = Math.min(value.length - 1, output.length); length >= 4; length--) {
            if (output.startsWith(value.slice(-length))) {output = '<concealed>' + output.slice(length); break;}
        }
        // A command stopped mid-print can end with the beginning of a value.
        for (const value of secrets) for (let length = Math.min(value.length - 1, output.length); length >= 4; length--) {
            if (output.endsWith(value.slice(0, length))) {output = output.slice(0, -length) + '<concealed>'; break;}
        }
    }
    return {output, truncated};
}
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
        return {...result, ...concealOutput(result.output, Object.values(values), result.truncated || result.timedOut)};
    } finally {for (const key of Object.keys(values)) delete values[key];}
}

