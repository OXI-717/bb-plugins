import {z} from 'zod';
import type {PoolProvider} from './contracts.js';
import {GuardRequiredError} from './network-errors.js';

export const GUARD_PROVIDERS = ['codex','claude','cursor','devin'] as const;
export const guardDecisionSchema=z.object({
  schema:z.literal('bb-vpn-guard/network-decision/1'),allowed:z.boolean(),
  reason:z.enum(['manual_block','vpn_unavailable','outside_scope','observe','connected','restore_required']),
}).strict().refine(v=>v.allowed===['outside_scope','observe','connected'].includes(v.reason));

// Guard can spend 1 s checking Pooler policy and 1.5 s checking the host.
// Allow those checks plus RPC overhead, without caching a previous permission.
export const GUARD_CHECK_TIMEOUT_MS = 4000;
export function createGuardNetworkCheck(read:(provider:PoolProvider,signal:AbortSignal)=>Promise<unknown>,timeoutMs=GUARD_CHECK_TIMEOUT_MS) {
  return async(provider:PoolProvider)=>{
    if(!GUARD_PROVIDERS.some(p=>p===provider)) return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const controller=new AbortController();
    let timedOut=false;
    try {
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
        timedOut=true;
        reject(new GuardRequiredError(provider,true,'timeout'));
        controller.abort();
      },timeoutMs);});
      const parsed=guardDecisionSchema.safeParse(await Promise.race([Promise.resolve().then(()=>read(provider,controller.signal)),timeout]));
      if(!parsed.success) throw new GuardRequiredError(provider,true,'invalid_decision');
      if(!parsed.data.allowed) throw new GuardRequiredError(provider);
    } catch(error) {
      if(error instanceof GuardRequiredError) throw error;
      throw new GuardRequiredError(provider,true,timedOut?'timeout':'rpc_failed');
    } finally {if(timer!==undefined)clearTimeout(timer);}
  };
}
