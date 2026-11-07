import {randomUUID} from 'node:crypto';
import {z} from 'zod';

type Storage = {get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; list(prefix?: string): Promise<string[]>};
type Context = {projectId: string; threadId: string};
type Kind = 'connect-many' | 'connect' | 'store' | 'run' | 'inventory' | 'check' | 'verify';
type State = 'preparing' | 'awaiting-approval' | 'running' | 'completed' | 'cancelled' | 'failed' | 'needs-review' | 'interrupted';
type Record = {id: string; instance: string; kind: Kind; label: string; profile: string; state: State; startedAt: string; updatedAt: string; approvedAt?: string; cancelReason?: string; result?: unknown};
export type Progress = (state: 'awaiting-approval' | 'running', approved?: boolean) => Promise<void>;

// Persist only these metadata shapes; never persist form input or raw errors.
const results = {
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
export function createJournal(storage: Storage) {
    const instance = randomUUID();
    const prefix = (ctx: Context) => 'action:' + encodeURIComponent(ctx.projectId) + ':' + encodeURIComponent(ctx.threadId) + ':';
    return {
        async list(ctx: Context) {
            const keys = (await storage.list(prefix(ctx))).sort().slice(-30);
            const rows = await Promise.all(keys.map(key => storage.get<Record>(key)));
            return rows.filter((row): row is Record => !!row).map(row => {
                const {instance: origin, ...metadata} = row;
                return origin !== instance && ['preparing', 'awaiting-approval', 'running'].includes(row.state)
                    ? {...metadata, state: 'interrupted' as const} : metadata;
            }).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
        },
        async run(kind: Kind, profile: string, ctx: Context, work: (progress: Progress) => Promise<string>, label: string = kind) {
            const now = new Date().toISOString();
            const row: Record = {id: randomUUID(), instance, kind, label, profile, state: 'preparing', startedAt: now, updatedAt: now};
            const key = prefix(ctx) + now + ':' + row.id;
            const save = async () => {row.updatedAt = new Date().toISOString(); await storage.set(key, row);};
            await save();
            try {
                const value = await work(async (state, approved) => {
                    row.state = state;
                    if (approved) row.approvedAt = new Date().toISOString();
                    await save();
                });
                if (value.startsWith('Cancelled')) {
                    row.state = 'cancelled';
                    const reason = cancelReasonSchema.safeParse(value.slice('Cancelled: '.length));
                    if (reason.success) row.cancelReason = reason.data;
                }
                else {row.result = results[kind].parse(JSON.parse(value)); row.state = 'completed';}
                await save();
                return value;
            } catch {
                row.state = row.state === 'running' ? 'needs-review' : 'failed';
                await save();
                throw new Error('1Password operation did not complete. Inspect oxi-op history before retrying; an interrupted write may need recovery.');
            }
        },
    };
}
