import {z} from 'zod';
export const automationStatusSchema=z.object({
 schema:z.literal('oxi-auto/protection-status/1'),blocked:z.boolean(),
 holds:z.array(z.object({owner:z.string().max(128),reason:z.string().max(256)})).max(64),
 restoreRevision:z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
 recoveryPending:z.boolean(),pausedCount:z.number().int().nonnegative(),
 activeRuns:z.array(z.string().max(1024)).max(100),errors:z.array(z.string().max(1024)).max(100),legacyBlocked:z.boolean(),
 pendingRestore:z.array(z.object({id:z.string(),projectId:z.string(),name:z.string(),phase:z.enum(['pending','paused','failed','conflict'])})).max(128).default([]),
}).strict();
export const automationInputSchema=z.object({
 action:z.enum(['status','hold','release','pause','resume']),
 instanceId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
 executable:z.string().min(1).max(1024),restoreRevision:z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),reviewed:z.boolean().default(false),
}).strict();
export type AutomationStatus=z.infer<typeof automationStatusSchema>;
