import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {CodedError, errorCode} from './errors.js';

type Storage = {get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; list(prefix?: string): Promise<string[]>};
type Context = {projectId: string; threadId: string; signal?: AbortSignal; notifyCompletion?: boolean};
type Kind = 'automate' | 'exec' | 'overview' | 'tidy' | 'migrate' | 'connect-many' | 'connect' | 'store' | 'run' | 'inventory' | 'check' | 'verify';
type State = 'preparing' | 'awaiting-approval' | 'running' | 'completed' | 'cancelled' | 'failed' | 'needs-review' | 'interrupted';
export type ActionRecord = {id: string; instance: string; kind: Kind; label: string; profile: string; state: State; startedAt: string; updatedAt: string; approvedAt?: string; cancelReason?: string; failureCode?: string; result?: unknown; notification?: {projectId:string;threadId:string;state:'pending'|'delivered'|'suppressed'}};
export type Progress = (state: 'awaiting-approval' | 'running', approved?: boolean) => Promise<void>;

// Persist only these metadata shapes; never persist form input or raw errors.
const results = {
    migrate: z.object({results: z.array(z.object({state: z.string(), code: z.string().optional()}))}),
    tidy: z.object({results: z.array(z.object({kind: z.string(), ok: z.boolean(), code: z.string().optional(), same: z.boolean().optional(), sameUsername: z.boolean().optional()}))}),
    // Only the summary is kept; the full map is returned to the caller and never stored.
    overview: z.object({vaultTotal: z.number().int(), complete: z.boolean()}),
    exec: z.object({exitCode: z.number().int(), truncated: z.boolean(), timedOut: z.boolean().optional(), escapedProcess: z.boolean().optional()}),
    automate: z.object({projects: z.array(z.object({projectId: z.string(), state: z.enum(['configured', 'needs-review']), vaultId: z.string().optional(), recoveredTokens: z.number().int().optional(), resumed: z.boolean().optional(), stage: z.enum(['resume-scope', 'issue', 'save-tokens', 'probe-reader', 'probe-intake', 'verify-intake', 'save-routes']).optional(), reason: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional()}).strict())}).strict(),
    'connect-many': z.object({projects: z.array(z.object({projectId:z.string(),state:z.enum(['configured','already-configured','needs-review']),vaultId:z.string().optional()}).strict())}).strict(),
    connect: z.object({configured: z.literal(true), projectId: z.string(), vaultId: z.string()}).strict(),
    store: z.object({itemId: z.string(), verified: z.literal(true)}).strict(),
    run: z.object({completed: z.literal(true)}).strict(),
    inventory: z.object({vaults: z.array(z.object({id: z.string(), name: z.string()}).strict())}).strict(),
    check: z.object({authorized: z.literal(true)}).strict(),
    verify: z.object({verified: z.literal(true), cleaned: z.literal(true), at: z.string().optional()}).strict(),
};
const cancelReasonSchema = z.enum(['user','timeout','request-aborted','thread-stopped','thread-deleted','plugin-disposed','server-restarted','invalid-submission']);
export function cancelledOutcome(result: {outcome: string; reason?: string}) {
    const parsed = cancelReasonSchema.safeParse(result.outcome === 'cancelled' ? result.reason : 'invalid-submission');
    return 'Cancelled' + (parsed.success ? ': ' + parsed.data : '');
}
export class OperationFailure extends Error {
    constructor(readonly code: 'credential_host_offline' | 'execution_host_offline' | 'host_status_unavailable' | 'session_host_not_allowed') {
        super(code === 'session_host_not_allowed' ? 'This session runs on a machine that is not allowed for this access profile. No key was read.' : code === 'credential_host_offline' ? 'No owner machine for 1Password approval is online. No credential request was sent.' : code === 'execution_host_offline' ? 'The execution host is offline. No operation was started.' : 'Host availability could not be verified. No credential request was sent.');
    }
}
export function completionText(row: ActionRecord): string {
    let status: string = row.state;
    const result = row.result as {exitCode?:number;timedOut?:boolean;escapedProcess?:boolean;verified?:boolean;cleaned?:boolean;authorized?:boolean;complete?:boolean;projects?:{state:string}[];results?:{state?:string;ok?:boolean}[]} | undefined;
    if (row.state === 'completed') {
        const uncertain = result?.escapedProcess || result?.complete === false || result?.projects?.some(x=>x.state==='needs-review') || result?.results?.some(x=>x.ok===false || (x.state!==undefined&&!['imported','already-imported','referenced','moved','empty'].includes(x.state)));
        status = result?.timedOut || (result?.exitCode!==undefined&&result.exitCode!==0) ? 'failed' : uncertain ? 'needs-review' : 'success';
    }
    const details = [row.cancelReason && 'reason='+row.cancelReason, row.failureCode && 'code='+row.failureCode,
        result?.exitCode!==undefined&&'exitCode='+result.exitCode, result?.verified!==undefined&&'verified='+result.verified,
        result?.cleaned!==undefined&&'cleaned='+result.cleaned, result?.authorized!==undefined&&'authorized='+result.authorized].filter(Boolean).join(', ');
    return 'Oxi Op: '+status+'. Операция: '+row.id+' ('+row.kind+'). '+(row.approvedAt?'Карточка подтверждена. ':'Карточка не подтверждена. ')+(details?details+'. ':'')+'Подтверждение карточки само по себе не означает успех операции. Результат сохранён в oxi_op_history. Не повторяйте операцию автоматически. Это сообщение с результатом, а не новое поручение. Секретов и вывода команды здесь нет.';
}
export function createJournal(storage: Storage, deliver?: (row: ActionRecord, signal?: AbortSignal) => Promise<boolean>) {
    const instance = randomUUID();
    const prefix = (ctx: Context) => 'action:' + encodeURIComponent(ctx.projectId) + ':' + encodeURIComponent(ctx.threadId) + ':';
    const pendingSignals = new Map<string, {signal:AbortSignal; remove:()=>void}>();
    const release = (id:string) => {pendingSignals.get(id)?.remove();pendingSignals.delete(id);};
    let flushing: Promise<void> | undefined;
    const flush = () => {
        if (flushing) return flushing;
        flushing = (async () => {
            for (const key of await storage.list('action:')) {
                const row = await storage.get<ActionRecord>(key);
                if (!row || row.notification?.state !== 'pending' || !deliver) continue;
                try {
                    const signal=pendingSignals.get(row.id)?.signal;
                    const sent = signal?.aborted ? false : await deliver(row, signal);
                    const latest=await storage.get<ActionRecord>(key);
                    if (!latest?.notification) continue;
                    latest.notification.state = signal?.aborted || latest.notification.state==='suppressed' ? 'suppressed' : sent ? 'delivered' : 'suppressed';
                    await storage.set(key, latest);
                    release(row.id);
                } catch { /* Keep only the safe durable result; retry delivery, never the operation. */ }
            }
        })().finally(()=>{flushing=undefined;});
        return flushing;
    };
    return {
        flush,
        async list(ctx: Context) {
            const keys = (await storage.list(prefix(ctx))).sort().slice(-30);
            const rows = await Promise.all(keys.map(key => storage.get<ActionRecord>(key)));
            return rows.filter((row): row is ActionRecord => !!row).map(row => {
                const {instance: origin, notification, ...metadata} = row;
                return origin !== instance && ['preparing', 'awaiting-approval', 'running'].includes(row.state)
                    ? {...metadata, state: 'interrupted' as const} : metadata;
            }).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
        },
        async run(kind: Kind, profile: string, ctx: Context, work: (progress: Progress) => Promise<string>, label: string = kind) {
            const now = new Date().toISOString();
            const row: ActionRecord = {id: randomUUID(), instance, kind, label, profile, state: 'preparing', startedAt: now, updatedAt: now};
            const key = prefix(ctx) + now + ':' + row.id;
            let interactive = ctx.notifyCompletion === true;
            const finish = async () => {
                if (deliver && interactive) row.notification = {projectId:ctx.projectId,threadId:ctx.threadId,state:ctx.signal?.aborted || ['thread-stopped','thread-deleted','request-aborted','plugin-disposed'].includes(row.cancelReason ?? '')?'suppressed':'pending'};
                await save();
                if (row.notification?.state==='pending' && ctx.signal) {
                    const signal=ctx.signal;
                    const cancel=()=>{
                        row.notification!.state='suppressed';
                        void storage.set(key, row).catch(()=>{});
                        release(row.id);
                    };
                    pendingSignals.set(row.id,{signal,remove:()=>signal.removeEventListener('abort',cancel)});
                    signal.addEventListener('abort',cancel,{once:true});
                    if(signal.aborted)cancel();
                }
                if (deliver) await flush().catch(()=>{});
            };
            const save = async () => {row.updatedAt = new Date().toISOString(); await storage.set(key, row);};
            await save();
            try {
                const value = await work(async (state, approved) => {
                    row.state = state;
                    if (state === 'awaiting-approval') interactive = true;
                    if (approved) row.approvedAt = new Date().toISOString();
                    await save();
                });
                if (value.startsWith('Cancelled')) {
                    row.state = 'cancelled';
                    const reason = cancelReasonSchema.safeParse(value.slice('Cancelled: '.length));
                    if (reason.success) row.cancelReason = reason.data;
                }
                else {row.result = results[kind].parse(JSON.parse(value)); row.state = 'completed';}
                await finish();
                return value;
            } catch (error) {
                const code = error instanceof OperationFailure ? error.code : errorCode(error);
                if (code) row.failureCode = code;
                row.state = row.state === 'running' ? 'needs-review' : 'failed';
                await finish();
                if (error instanceof OperationFailure) throw error;
                if (code) throw new CodedError(code, '1Password operation did not complete (' + code + '). Inspect oxi-op history before retrying.');
                throw new Error('1Password operation did not complete. Inspect oxi-op history before retrying; an interrupted write may need recovery.');
            }
        },
    };
}
