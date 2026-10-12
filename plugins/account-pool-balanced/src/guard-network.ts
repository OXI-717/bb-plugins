import {z} from 'zod';
import type {PoolProvider} from './contracts.js';
import {GuardRequiredError} from './network-errors.js';

export const GUARD_PROVIDERS = ['codex','claude','cursor','devin'] as const;
export const guardDecisionSchema=z.object({
  schema:z.literal('bb-vpn-guard/network-decision/1'),allowed:z.boolean(),
  reason:z.enum(['manual_block','vpn_unavailable','outside_scope','observe','connected','restore_required']),
}).strict().refine(v=>v.allowed===['outside_scope','observe','connected'].includes(v.reason));

export function createGuardNetworkCheck(read:(provider:PoolProvider)=>Promise<unknown>,timeoutMs=1000) {
  return async(provider:PoolProvider)=>{
    if(!GUARD_PROVIDERS.some(p=>p===provider)) return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Guard timeout')),timeoutMs);});
      const parsed=guardDecisionSchema.safeParse(await Promise.race([Promise.resolve().then(()=>read(provider)),timeout]));
      if(!parsed.success) throw new GuardRequiredError(provider,true);
      if(!parsed.data.allowed) throw new GuardRequiredError(provider);
    } catch(error) {
      if(error instanceof GuardRequiredError) throw error;
      throw new GuardRequiredError(provider,true);
    } finally {if(timer!==undefined)clearTimeout(timer);}
  };
}
