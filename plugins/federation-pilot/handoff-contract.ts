import {defineRpcContract} from '@get-bb/plugin-sdk';
import {z} from 'zod';

// A transfer is an explicit outward copy, never a remote filesystem capability.
export const HANDOFF_FILE_BYTES=4*1024*1024;
export const HANDOFF_TOTAL_BYTES=16*1024*1024;
export const handoffTargetSchema=z.object({
 serverId:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
 projectId:z.string().regex(/^proj_[a-z0-9]+$/).refine(v=>v!=='proj_personal'),
 hostId:z.string().regex(/^host_[a-z0-9]+$/),
 environmentId:z.string().regex(/^env_[a-z0-9]+$/),
}).strict();
export const handoffFileSchema=z.object({
 name:z.string().min(1).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9_. -]*$/).refine(s=>!s.includes('..')),
 mimeType:z.enum(['text/plain','text/markdown','application/json','application/x-ndjson','application/pdf','image/png','image/jpeg','image/gif','image/webp']),
 sizeBytes:z.number().int().positive().max(HANDOFF_FILE_BYTES),
 sha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const handoffUploadSchema=handoffFileSchema.extend({
 projectId:handoffTargetSchema.shape.projectId,
 bytesBase64:z.string().min(4).max(4*Math.ceil(HANDOFF_FILE_BYTES/3)).regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).strict();
export const handoffAttachmentSchema=z.object({
 type:z.enum(['localFile','localImage']),
 sourceProjectId:handoffTargetSchema.shape.projectId,
 path:z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9_. -]*$/).refine(s=>!s.includes('..')),
 name:z.string().min(1).max(255),mimeType:z.string(),sizeBytes:z.number().int().positive().max(HANDOFF_FILE_BYTES),
}).strict();
export const handoffBeginSchema=handoffTargetSchema.extend({
 providerId:z.string().min(1).max(120),model:z.string().min(1).max(160),
 reasoningLevel:z.enum(['none','minimal','low','medium','high','xhigh','max']).optional(),
 title:z.string().min(1).max(200),prompt:z.string().min(1).max(16000),
 files:z.array(handoffFileSchema).min(1).max(16),
}).strict().refine(v=>v.files.reduce((sum,f)=>sum+f.sizeBytes,0)<=HANDOFF_TOTAL_BYTES,'Transfer exceeds 16 MiB');
const operation=z.object({operationId:z.string().uuid()}).strict();
export const handoffResultSchema=z.object({
 operationId:z.string().uuid(),state:z.enum(['prepared','uploading','ready','creating','complete','uncertain']),
 serverId:z.string(),projectId:z.string(),hostId:z.string(),environmentId:z.string(),
 threadId:z.string().regex(/^thr_[a-z0-9]+$/).nullable(),uploaded:z.number().int(),
}).strict();
export const handoffRpc=defineRpcContract({
 handoffTargets:{input:z.null(),output:z.array(z.object({
  serverId:z.string(),label:z.string(),projectId:z.string(),available:z.boolean(),
  targets:z.array(z.object({hostId:z.string(),hostName:z.string(),environmentId:z.string(),path:z.string().nullable()})),
 }))},
 handoffOptions:{input:handoffTargetSchema.extend({providerId:z.string().min(1).max(120).optional()}).strict(),output:z.object({
  providers:z.array(z.object({id:z.string(),displayName:z.string(),available:z.boolean()})),
  models:z.array(z.object({model:z.string(),displayName:z.string(),isDefault:z.boolean(),defaultReasoningEffort:z.string().nullable(),supportedReasoningEfforts:z.array(z.object({reasoningEffort:z.string(),description:z.string()}))})),
 })},
 handoffBegin:{input:handoffBeginSchema,output:handoffResultSchema},
 handoffUpload:{input:operation.extend({index:z.number().int().nonnegative().max(15),bytesBase64:handoffUploadSchema.shape.bytesBase64}).strict(),output:handoffResultSchema},
 handoffCommit:{input:operation,output:handoffResultSchema},
 handoffStatus:{input:operation,output:handoffResultSchema},
});
