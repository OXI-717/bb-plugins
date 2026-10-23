import {z} from 'zod';
import type {PoolProvider} from './contracts.js';
import {GuardRequiredError} from './network-errors.js';

export function requiresGuardCheck(provider:PoolProvider):boolean {return provider!=='kimi'&&provider!=='zai';}
export const guardDecisionSchema=z.object({
  schema:z.literal('bb-vpn-guard/network-decision/1'),allowed:z.boolean(),
  reason:z.enum(['manual_block','vpn_unavailable','outside_scope','observe','connected','restore_required']),
}).strict().refine(v=>v.allowed===['outside_scope','observe','connected'].includes(v.reason));

export const hostGuardDecisionSchema=z.object({
  schema:z.literal('bb-vpn-guard/network-decision/2'),hostId:z.string().min(1),allowed:z.boolean(),
  reason:z.enum(['manual_block','vpn_unavailable','outside_scope','observe','connected','restore_required','direct']),
}).strict().refine(v=>v.allowed===['outside_scope','observe','connected','direct'].includes(v.reason));
export function bindGuardNetworkDecision(value:unknown,hostId:string) {
  const result=hostGuardDecisionSchema.parse(value);
  if(result.hostId!==hostId)throw Error('Guard decision does not match server host');
  return result;
}
const anyGuardDecisionSchema=z.union([guardDecisionSchema,hostGuardDecisionSchema]);

// Guard can spend 1 s checking Pooler policy and 1.5 s checking the host.
// Allow those checks plus RPC overhead, without caching a previous permission.
export const GUARD_CHECK_TIMEOUT_MS = 4000;
export function createGuardNetworkCheck(read:(provider:PoolProvider,signal:AbortSignal)=>Promise<unknown>,timeoutMs=GUARD_CHECK_TIMEOUT_MS) {
  return async(provider:PoolProvider)=>{
    if(!requiresGuardCheck(provider)) return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const controller=new AbortController();
    let timedOut=false;
    try {
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
        timedOut=true;
        reject(new GuardRequiredError(provider,true,'timeout'));
        controller.abort();
      },timeoutMs);});
      const parsed=anyGuardDecisionSchema.safeParse(await Promise.race([Promise.resolve().then(()=>read(provider,controller.signal)),timeout]));
      if(!parsed.success) throw new GuardRequiredError(provider,true,'invalid_decision');
      if(!parsed.data.allowed) throw new GuardRequiredError(provider);
      return parsed.data.reason==='direct'?'direct' as const:undefined;
    } catch(error) {
      if(error instanceof GuardRequiredError) throw error;
      throw new GuardRequiredError(provider,true,timedOut?'timeout':'rpc_failed');
    } finally {if(timer!==undefined)clearTimeout(timer);}
  };
}
