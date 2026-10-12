import {z} from 'zod';
// Host-owned nested environment/input shapes receive final validation in threads.spawn.
// Only these explicit create fields may cross the plugin RPC boundary.
export const launchRequestSchema=z.object({
 projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
 reasoningLevel:z.enum(['high','low','max','medium','none','ultra','ultracode','xhigh']),
 permissionMode:z.enum(['accept-edits','auto','full']),serviceTier:z.enum(['default','fast']).optional(),
 executionInputSources:z.object({providerId:z.enum(['explicit','client-preference']).optional(),model:z.enum(['explicit','client-preference']).optional(),reasoningLevel:z.enum(['explicit','client-preference']).optional(),permissionMode:z.enum(['explicit','client-preference']).optional(),serviceTier:z.enum(['explicit','client-preference']).optional()}).strict(),
 environment:z.object({type:z.enum(['reuse','host','project-default','provider'])}).catchall(z.json()),
 input:z.array(z.object({type:z.enum(['text','image','localImage','localFile'])}).catchall(z.json())).min(1).max(100),
 sendAt:z.number().int().nonnegative().optional(),
}).strict();
