import {defineRpcContract,type BbPluginApi} from '@get-bb/plugin-sdk';
import {z} from 'zod';
import {NativeSessions,nativeExecutionSchema} from './native-sessions.js';
const id=z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const unlockAssignmentSchema=z.object({
  requestId:z.string().uuid(),deadline:z.number().int().positive(),profile:id,operation:z.literal('prepared-native-keyring-unlock'),
  binding:nativeExecutionSchema.extend({schema:z.literal('bb-account-pool/native-execution/1'),leaseId:z.string().uuid(),sessionId:z.string().uuid(),
    executorId:id,accountId:id,hostId:id,kind:z.literal('task'),
    caller:z.object({hostId:id,projectId:id,threadId:id.optional(),purpose:z.literal('autopilot').optional()}).strict()}).strict(),
}).strict();
export const nativeUnlockContract=defineRpcContract({claimNativeUnlock:{input:z.object({requestId:z.string().uuid()}).strict(),output:unlockAssignmentSchema}});
export function registerNativeUnlockRpc(bb:BbPluginApi,sessions:NativeSessions){
  bb.rpc.register(nativeUnlockContract,{async claimNativeUnlock({requestId}:{requestId:string},context?:unknown){
    // Older hosts lacking verified plugin attribution refuse this optional path.
    const caller=(context as {experimental_caller?:{kind:string;pluginId?:string}}|undefined)?.experimental_caller;
    if(caller?.kind!=='plugin'||caller.pluginId!=='oxi-op')throw new Error('Native unlock requires the Oxi Op server caller');
    return unlockAssignmentSchema.parse(await sessions.claimUnlock(requestId));
  }});
}
