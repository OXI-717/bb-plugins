import {defineRpcContract} from '@get-bb/plugin-sdk';
import {z} from 'zod';
const id=z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const assignmentSchema=z.object({
 requestId:z.string().uuid(),deadline:z.number().int().positive(),profile:id,operation:z.literal('prepared-native-keyring-unlock'),
 binding:z.object({schema:z.literal('bb-account-pool/native-execution/1'),leaseId:z.string().uuid(),sessionId:z.string().uuid(),
 executorId:id,accountId:id,hostId:id,kind:z.literal('task'),runtimeId:id,gatewayId:id,runtimeSha256:z.string().regex(/^[a-f0-9]{64}$/),
 profile:z.object({id,version:z.number().int().positive()}).strict(),
 caller:z.object({hostId:id,projectId:id,threadId:id.optional(),purpose:z.literal('autopilot').optional()}).strict()}).strict(),
}).strict();
export type TaskAssignment=z.infer<typeof assignmentSchema>;
export const taskContract=defineRpcContract({runPreparedTask:{input:z.object({requestId:z.string().uuid()}).strict(),output:z.object({completed:z.literal(true)}).strict()}});
