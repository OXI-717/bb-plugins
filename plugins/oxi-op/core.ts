import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
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
export function spawnGroup(binary: string, args: string[], options: {env: NodeJS.ProcessEnv; cwd?: string; input?: string; timeoutMs: number; maxBytes: number; overflow: 'fail' | 'keep-tail'; includeStderr: boolean; onEscape?: 'reject' | 'report'; ownSession?: boolean; signal?: AbortSignal}) {
    return new Promise<GroupResult>((resolve, reject) => {
        if (options.signal?.aborted) {reject(new CodedError('cancelled', 'Operation cancelled')); return;}
        if (process.platform !== 'linux' && process.platform !== 'darwin') {reject(new Error('Operation requires a supported POSIX host')); return;}
        const ownSession = options.ownSession ?? true;
        const child = spawn(binary, args, {env: options.env, cwd: options.cwd, detached: ownSession, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']});
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
            try {if (child.pid) process.kill(ownSession ? -child.pid : child.pid, 'SIGKILL');}
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
        child.on('error', error => {kill(); finish(); reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new CodedError('command-not-found', 'The program was not found on this machine') : new CodedError('command-not-started', 'The process could not start'));});
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
// Desktop (biometric) op calls stay in the host's own session: 1Password recognises an
// authorised caller by its session, so a new session per call asked for a fingerprint each
// time. Only service-account and agent processes get their own group for cleanup.
// A command launched through `op run` holds resolved credentials and always gets its own group.
const runWith = (ownSession: (env: NodeJS.ProcessEnv) => boolean): Runner => async (binary, args, env, input, signal) => {
    const result = await spawnGroup(binary, args, {env, input: input ?? '', timeoutMs: 90000, maxBytes: 1048576, overflow: 'fail', includeStderr: false, ownSession: ownSession(env), signal});
    if (result.code !== 0 || result.expired) throw new CredentialProcessError('process exit ' + result.code + '; output suppressed');
    return result.output.toString('utf8');
};
export const runProcess: Runner = runWith(env => env.OP_BIOMETRIC_UNLOCK_ENABLED !== 'true');
export const runOwnedProcess: Runner = runWith(() => true);
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
    const description = oxiOpMarker + projectId;
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
// backup on retry instead of issuing a duplicate service account. Accounts never expire unless
// an expiry is requested; a recovered backup keeps the lifetime it was issued with. A reissue
// never recovers: every existing backup is set aside under a dated title and new accounts are
// issued, so a leaked, expired or faulty token is never brought back. Accounts of a failed
// reissue stay visible through their set-aside backups for the owner to delete.
export async function issueServiceAccounts(run: Runner, env: NodeJS.ProcessEnv, request: {projectId: string; vaultName: string; backupVaultId: string; expiresIn?: string; replaceExisting?: boolean; accounts: ServiceAccountRequest[]}, signal?: AbortSignal, now = new Date()) {
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
            if (!request.replaceExisting) {
                let stored: {fields?: {label: string; value: string}[]};
                try {stored = JSON.parse(await run('op', ['item', 'get', matches[0].id, '--vault', request.backupVaultId, '--reveal', '--format=json'], env, undefined, signal));}
                catch {throw new CodedError('backup-read-failed', 'An existing token backup could not be read; owner review is required');}
                const token = stored.fields?.find(field => field.label === 'password')?.value;
                if (!token) throw new CodedError('backup-incomplete', 'An existing token backup is incomplete; owner review is required');
                accounts.push({profile: account.profile, token, recovered: true});
                continue;
            }
            // Reissue: keep the replaced backup under a dated title; its account stays valid until
            // the owner deletes it in 1Password (the CLI cannot delete service accounts).
            try {await run('op', ['item', 'edit', matches[0].id, '--vault', request.backupVaultId, '--title', title + ' (replaced ' + now.toISOString().replace(/\.\d+Z$/, 'Z') + ')'], env, undefined, signal);}
            catch {throw new CodedError('backup-rename-failed', 'A replaced token backup could not be set aside; no service account was issued');}
        }
        let token: string;
        try {token = (await run('op', ['service-account', 'create', account.name, '--vault', vaultId + ':' + account.permissions.join(','), ...(request.expiresIn ? ['--expires-in', request.expiresIn] : []), '--raw'], env, undefined, signal)).trim();}
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
// Services such as the BB host daemon start with a minimal PATH; agent commands should find
// programs the way a login shell does (Homebrew and /usr/local included).
export function commandPath(current: string | undefined) {
    const parts = (current ?? '').split(':').filter(Boolean);
    for (const dir of ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) if (!parts.includes(dir)) parts.push(dir);
    return parts.join(':');
}
// Is the program runnable on this machine, the way the command will look it up?
export async function programAvailable(program: string, pathValue = commandPath(process.env.PATH)) {
    const {access, constants} = await import('node:fs/promises');
    const {join, isAbsolute} = await import('node:path');
    const candidates = program.includes('/') ? [isAbsolute(program) ? program : ''] : pathValue.split(':').map(dir => join(dir, program));
    for (const candidate of candidates.filter(Boolean)) {try {await access(candidate, constants.X_OK); return true;} catch {}}
    return false;
}
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
    childEnv.PATH = commandPath(childEnv.PATH);
    try {
        const result = await command(argv[0], argv.slice(1), childEnv, cwd, timeoutMs, signal);
        return {...result, ...concealOutput(result.output, Object.values(values), result.truncated || result.timedOut)};
    } finally {for (const key of Object.keys(values)) delete values[key];}
}


export const oxiOpMarker = 'Managed by Oxi Op for BB project ';
export type VaultOverview = {id: string; name: string; service: boolean; marker?: string; error?: string; itemTotal?: number; itemsTruncated?: boolean; items?: {title: string; category: string; createdAt: string; updatedAt: string}[]};
const overviewVaultLimit = 200;
const overviewItemLimit = 500;
// Metadata only. Items are listed (titles, categories, dates; never values) only in service vaults:
// those named by routes, the service registry or the Oxi Op marker. Any other vault the owner
// account can see is reported by name alone and never opened.
// op prints nothing for some empty results; treat that as an empty list rather than a failure.
const parseJsonOutput = (output: string) => output.trim() ? JSON.parse(output) : [];
const failureTail = (error: unknown) => {
    const exit = /process exit (\d{1,3}|null)/.exec(error instanceof Error ? error.message : '')?.[1];
    return error instanceof SyntaxError ? 'invalid-json' : exit ? 'exit-' + exit : 'failed';
};
export async function overviewVaults(run: Runner, env: NodeJS.ProcessEnv, serviceIds: Set<string>, signal?: AbortSignal) {
    const vaults = JSON.parse(await run('op', ['vault', 'list', '--format=json'], env, undefined, signal));
    if (!Array.isArray(vaults)) throw new CodedError('overview-invalid', 'Invalid vault list');
    const result: VaultOverview[] = [];
    for (const vault of vaults.slice(0, overviewVaultLimit)) {
        if (typeof vault?.id !== 'string' || typeof vault?.name !== 'string') continue;
        // One unreadable vault is reported with a fixed code; it must not hide the rest of the map.
        let description = '';
        try {const details = parseJsonOutput(await run('op', ['vault', 'get', vault.id, '--format=json'], env, undefined, signal)); description = typeof details?.description === 'string' ? details.description : '';}
        catch (error) {result.push({id: vault.id, name: vault.name, service: serviceIds.has(vault.id), error: 'vault-get-' + failureTail(error)}); continue;}
        const marker = description.startsWith(oxiOpMarker) ? description.slice(oxiOpMarker.length).trim() : undefined;
        if (!serviceIds.has(vault.id) && !marker) {result.push({id: vault.id, name: vault.name, service: false}); continue;}
        let items: unknown;
        try {items = parseJsonOutput(await run('op', ['item', 'list', '--vault', vault.id, '--format=json'], env, undefined, signal));}
        catch (error) {result.push({id: vault.id, name: vault.name, service: true, ...(marker ? {marker} : {}), error: 'item-list-' + failureTail(error)}); continue;}
        const all = Array.isArray(items) ? items : [];
        result.push({id: vault.id, name: vault.name, service: true, ...(marker ? {marker} : {}), itemTotal: all.length, itemsTruncated: all.length > overviewItemLimit, items: all.slice(0, overviewItemLimit).map((item: {title?: unknown; category?: unknown; created_at?: unknown; updated_at?: unknown}) => ({title: String(item.title ?? ''), category: String(item.category ?? ''), createdAt: String(item.created_at ?? ''), updatedAt: String(item.updated_at ?? '')}))});
    }
    return {vaults: result, vaultTotal: vaults.length, vaultsTruncated: vaults.length > overviewVaultLimit};
}

// Run a command with values that were resolved elsewhere (owner-approved desktop read). The child
// gets no OP_ variables; exact values are concealed in the returned output.
export async function execResolved(command: CommandRunner, argv: string[], bindings: Record<string, string>, cwd: string | undefined, timeoutMs: number, signal?: AbortSignal) {
    const childEnv: NodeJS.ProcessEnv = {...process.env};
    for (const name of Object.keys(childEnv)) if (name.startsWith('OP_')) delete childEnv[name];
    for (const name of Object.keys(bindings)) if (name.startsWith('OP_')) throw new CodedError('reserved-variable', 'OP_ variables are reserved');
    Object.assign(childEnv, bindings);
    childEnv.PATH = commandPath(childEnv.PATH);
    const result = await command(argv[0], argv.slice(1), childEnv, cwd, timeoutMs, signal);
    return {...result, ...concealOutput(result.output, Object.values(bindings), result.truncated || result.timedOut)};
}
export type TidyStep =
    | {kind: 'same'; a: {vaultId: string; item: string}; b: {vaultId: string; item: string}}
    | {kind: 'move'; vaultId: string; item: string; toVaultId: string}
    | {kind: 'archive'; vaultId: string; item: string}
    | {kind: 'delete-vault'; vaultId: string};
const digest = async (value: string) => (await import('node:crypto')).createHash('sha256').update(value).digest('hex');
// Owner-approved structural clean-up. Steps run in order and stop at the first failure or at a
// comparison that differs; values are compared by hash inside this process and never returned.
export async function runTidy(run: Runner, env: NodeJS.ProcessEnv, steps: TidyStep[], signal?: AbortSignal) {
    const op = async (args: string[]) => run('op', args, env, undefined, signal);
    const findOne = async (vaultId: string, item: string) => {
        const items = JSON.parse((await op(['item', 'list', '--vault', vaultId, '--format=json'])).trim() || '[]');
        const matches = items.filter((x: {id: string; title: string}) => x.id === item || x.title === item);
        if (matches.length !== 1) throw new CodedError(matches.length ? 'ambiguous-item' : 'item-not-found', 'Item must match exactly one entry');
        return matches[0] as {id: string; title: string};
    };
    const fingerprint = async (vaultId: string, item: string) => {
        const found = await findOne(vaultId, item);
        const full = JSON.parse(await op(['item', 'get', found.id, '--vault', vaultId, '--reveal', '--format=json']));
        const fields = Array.isArray(full.fields) ? full.fields : [];
        const pick = (purpose: string, label: string) => String(fields.find((f: {purpose?: string; label?: string}) => f.purpose === purpose || f.label === label)?.value ?? '');
        return {password: await digest(pick('PASSWORD', 'password')), username: await digest(pick('USERNAME', 'username')), hasPassword: pick('PASSWORD', 'password').length > 0};
    };
    const results: {kind: string; ok: boolean; code?: string; same?: boolean; sameUsername?: boolean}[] = [];
    for (const step of steps) {
        try {
            if (step.kind === 'same') {
                const [a, b] = [await fingerprint(step.a.vaultId, step.a.item), await fingerprint(step.b.vaultId, step.b.item)];
                const same = a.hasPassword && a.password === b.password;
                results.push({kind: step.kind, ok: same, same, sameUsername: a.username === b.username, ...(same ? {} : {code: 'values-differ'})});
                if (!same) break;
            } else if (step.kind === 'move') {
                const found = await findOne(step.vaultId, step.item);
                await op(['item', 'move', found.id, '--current-vault', step.vaultId, '--destination-vault', step.toVaultId]);
                await findOne(step.toVaultId, found.title);
                results.push({kind: step.kind, ok: true});
            } else if (step.kind === 'archive') {
                const found = await findOne(step.vaultId, step.item);
                await op(['item', 'delete', found.id, '--vault', step.vaultId, '--archive']);
                results.push({kind: step.kind, ok: true});
            } else {
                const left = JSON.parse((await op(['item', 'list', '--vault', step.vaultId, '--include-archive', '--format=json'])).trim() || '[]');
                if (left.length) throw new CodedError('vault-not-empty', 'Vault still holds items, including archived ones');
                await op(['vault', 'delete', step.vaultId]);
                const vaults = JSON.parse(await op(['vault', 'list', '--format=json']));
                if (vaults.some((v: {id: string}) => v.id === step.vaultId)) throw new CodedError('vault-still-present', 'Vault deletion could not be confirmed');
                results.push({kind: step.kind, ok: true});
            }
        } catch (error) {results.push({kind: step.kind, ok: false, code: errorCode(error) ?? 'failed'}); break;}
    }
    return {results};
}

// Desktop op calls through the OXI Op broker service (see broker/op_broker.py): one long-lived
// service owns the 1Password and macOS authorisation instead of a new process per call.
export const brokerRunner = (socketPath: string): Runner => (_binary, args, _env, input, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {reject(new CodedError('cancelled', 'Operation cancelled')); return;}
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        socket.destroy();
        if (error) reject(error); else resolve(value!);
    };
    const abort = () => done(new CodedError('cancelled', 'Operation cancelled'));
    const timer = setTimeout(() => done(new CredentialProcessError('process exit timeout; output suppressed')), 100_000);
    signal?.addEventListener('abort', abort, {once: true});
    socket.on('error', () => done(new CodedError('broker-unavailable', 'The OXI Op broker service is not reachable')));
    socket.on('data', chunk => {size += chunk.length; if (size > 8 * 1024 * 1024) done(new CodedError('broker-output', 'Broker response too large')); else chunks.push(chunk);});
    socket.on('end', () => {
        let reply: {code?: unknown; stdout?: unknown; error?: unknown};
        try {reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));}
        catch {done(new CodedError('broker-protocol', 'Invalid broker response')); return;}
        if (reply.error === 'not-allowed') {done(new CodedError('broker-refused', 'The broker refused this command')); return;}
        if (reply.code !== 0 || typeof reply.stdout !== 'string') {done(new CredentialProcessError('process exit ' + (typeof reply.code === 'number' ? reply.code : 'null') + '; output suppressed')); return;}
        done(undefined, Buffer.from(reply.stdout, 'base64').toString('utf8'));
    });
    // Keep our side open: closing it is how the broker learns a call was cancelled.
    socket.write(JSON.stringify({args, stdin: Buffer.from(input ?? '', 'utf8').toString('base64')}) + '\n');
});

// ---- Migration of local secret files into a project vault -------------------------------
// Values are read here, written to 1Password and compared by hash; only names, counts and
// hashes-equal flags leave this process.
export type EnvEntry = {key: string; value: string};
// A deliberately small dotenv reader: KEY=VALUE, optional `export`, comments, single-line quoted
// values. Anything it cannot read unambiguously makes the file a document instead.
export function parseEnv(text: string): {entries: EnvEntry[]; ambiguous: boolean} {
    const entries = new Map<string, string>();
    let ambiguous = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
        if (!m) {ambiguous = true; continue;}
        let value = m[2];
        const quote = value[0];
        if (quote === '"' || quote === "'") {
            if (value.length < 2 || !value.endsWith(quote)) {ambiguous = true; continue;}
            value = value.slice(1, -1);
            if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
        } else {
            const hash = value.search(/\s#/);
            if (hash >= 0) value = value.slice(0, hash).trimEnd();
        }
        entries.set(m[1], value);
    }
    return {entries: [...entries].map(([key, value]) => ({key, value})).filter(e => e.value !== ''), ambiguous};
}
const sha = async (value: string | Buffer) => (await import('node:crypto')).createHash('sha256').update(value).digest('hex');
export type ImportEntry = {file: string; title: string; kind: 'env' | 'document'};
export type ImportResult = {file: string; title: string; kind: 'env' | 'document'; state: 'imported' | 'already-imported' | 'differs' | 'failed' | 'empty'; itemId?: string; keys?: string[]; code?: string};
// Import each file as one item: env files become concealed fields in an "Environment" section,
// anything else (or an env file the reader cannot parse unambiguously) a document. An existing
// item with the same title is reused only if every value matches.
export async function importFiles(run: Runner, env: NodeJS.ProcessEnv, vaultId: string, entries: ImportEntry[], signal?: AbortSignal, platform: NodeJS.Platform = process.platform) {
    const {readFile, mkdtemp, rm} = await import('node:fs/promises');
    const {join} = await import('node:path');
    const {tmpdir} = await import('node:os');
    const op = async (args: string[], input?: string) => run('op', args, env, input, signal);
    const results: ImportResult[] = [];
    const existing = JSON.parse((await op(['item', 'list', '--vault', vaultId, '--format=json'])).trim() || '[]') as {id: string; title: string}[];
    for (const entry of entries) {
        try {
            const bytes = await readFile(entry.file);
            const parsed = entry.kind === 'env' ? parseEnv(bytes.toString('utf8')) : undefined;
            const kind: 'env' | 'document' = parsed && !parsed.ambiguous ? 'env' : 'document';
            const matches = existing.filter(x => x.title === entry.title);
            if (matches.length > 1) {results.push({file: entry.file, title: entry.title, kind, state: 'failed', code: 'duplicate-titles'}); continue;}
            if (kind === 'env') {
                const values = parsed!.entries;
                if (!values.length) {results.push({file: entry.file, title: entry.title, kind, state: 'empty'}); continue;}
                let itemId = matches[0]?.id;
                let reused = !!itemId;
                if (!itemId) {
                    const template = {title: entry.title, category: 'SECURE_NOTE', sections: [{id: 'env', label: 'Environment'}], fields: [
                        {id: 'notesPlain', type: 'STRING', purpose: 'NOTES', label: 'notesPlain', value: 'Imported by Oxi Op from a local environment file.'},
                        ...values.map(v => ({id: 'env-' + v.key, label: v.key, type: 'CONCEALED', value: v.value, section: {id: 'env', label: 'Environment'}})),
                    ]};
                    const created = await withTemplateFile(JSON.stringify(template), platform, (path, input) => op(['item', 'create', '--template', path, '--vault', vaultId, '--format=json'], input === undefined ? undefined : JSON.stringify(input)));
                    itemId = JSON.parse(created).id;
                }
                const stored = JSON.parse(await op(['item', 'get', itemId!, '--vault', vaultId, '--reveal', '--format=json']));
                const fields = new Map<string, string>((stored.fields ?? []).filter((f: {section?: {id?: string}}) => f.section?.id === 'env').map((f: {label: string; value?: string}) => [f.label, f.value ?? '']));
                let same = fields.size === values.length;
                for (const v of values) if (!fields.has(v.key) || await sha(fields.get(v.key)!) !== await sha(v.value)) same = false;
                results.push({file: entry.file, title: entry.title, kind, state: same ? (reused ? 'already-imported' : 'imported') : 'differs', itemId, keys: values.map(v => v.key)});
            } else {
                let itemId = matches[0]?.id;
                const reused = !!itemId;
                if (!itemId) itemId = JSON.parse(await op(['document', 'create', entry.file, '--vault', vaultId, '--title', entry.title, '--format=json'])).uuid ?? undefined;
                if (!itemId) {
                    const again = JSON.parse((await op(['item', 'list', '--vault', vaultId, '--format=json'])).trim() || '[]').filter((x: {title: string}) => x.title === entry.title);
                    itemId = again.length === 1 ? again[0].id : undefined;
                }
                if (!itemId) throw new CodedError('document-unconfirmed', 'Document creation could not be confirmed');
                const dir = await mkdtemp(join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'oxi-op-doc-'));
                try {
                    const out = join(dir, 'doc');
                    await op(['document', 'get', itemId, '--vault', vaultId, '--out-file', out, '--force']);
                    const same = await sha(await readFile(out)) === await sha(bytes);
                    results.push({file: entry.file, title: entry.title, kind, state: same ? (reused ? 'already-imported' : 'imported') : 'differs', itemId});
                } finally {await rm(dir, {recursive: true, force: true});}
            }
        } catch (error) {results.push({file: entry.file, title: entry.title, kind: entry.kind, state: 'failed', code: errorCode(error) ?? 'failed'});}
    }
    return {results};
}
// After a verified import: env files keep their layout but every imported value becomes an
// op:// reference; documents are removed. Nothing is changed unless the vault still holds the
// same values. No plaintext copy is kept.
export async function replaceWithReferences(run: Runner, env: NodeJS.ProcessEnv, vaultId: string, entries: (ImportEntry & {itemId: string})[], signal?: AbortSignal) {
    const {readFile, writeFile, rename, stat, unlink, chmod} = await import('node:fs/promises');
    const op = async (args: string[]) => run('op', args, env, undefined, signal);
    const results: {file: string; state: 'referenced' | 'removed' | 'skipped' | 'failed'; code?: string; keys?: number}[] = [];
    for (const entry of entries) {
        try {
            const bytes = await readFile(entry.file);
            const stored = JSON.parse(await op(['item', 'get', entry.itemId, '--vault', vaultId, '--reveal', '--format=json']));
            if (entry.kind === 'document' || stored.category === 'DOCUMENT') {
                const {mkdtemp, rm} = await import('node:fs/promises');
                const {join} = await import('node:path');
                const {tmpdir} = await import('node:os');
                const dir = await mkdtemp(join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'oxi-op-doc-'));
                try {
                    const out = join(dir, 'doc');
                    await op(['document', 'get', entry.itemId, '--vault', vaultId, '--out-file', out, '--force']);
                    if (await sha(await readFile(out)) !== await sha(bytes)) throw new CodedError('values-differ', 'Vault copy differs');
                } finally {await rm(dir, {recursive: true, force: true});}
                await unlink(entry.file);
                results.push({file: entry.file, state: 'removed'});
                continue;
            }
            const fields = new Map<string, string>((stored.fields ?? []).filter((f: {section?: {id?: string}}) => f.section?.id === 'env').map((f: {label: string; value?: string}) => [f.label, f.value ?? '']));
            const parsed = parseEnv(bytes.toString('utf8'));
            if (parsed.ambiguous) throw new CodedError('ambiguous-file', 'File is not a plain env file');
            for (const v of parsed.entries) if (!fields.has(v.key) || await sha(fields.get(v.key)!) !== await sha(v.value)) throw new CodedError('values-differ', 'Vault copy differs');
            let replaced = 0;
            const lines = bytes.toString('utf8').split('\n').map(raw => {
                const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/.exec(raw);
                if (!m || !fields.has(m[2]) || m[4].trim() === '') return raw;
                replaced++;
                return m[1] + m[2] + m[3] + 'op://' + vaultId + '/' + entry.itemId + '/Environment/' + m[2];
            });
            const info = await stat(entry.file);
            const temp = entry.file + '.oxi-op-' + process.pid;
            await writeFile(temp, lines.join('\n'), {mode: info.mode & 0o777, flag: 'wx'});
            await chmod(temp, info.mode & 0o777);
            await rename(temp, entry.file);
            results.push({file: entry.file, state: 'referenced', keys: replaced});
        } catch (error) {results.push({file: entry.file, state: 'failed', code: errorCode(error) ?? 'failed'});}
    }
    return {results};
}
