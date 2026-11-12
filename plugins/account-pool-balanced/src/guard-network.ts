import {randomUUID} from 'node:crypto';
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
export const guardStageSchema=z.enum(['permission','server-host','guard-rpc','server-host-recheck','validate-host']);
export type GuardStage=z.infer<typeof guardStageSchema>;
export interface GuardReadTrace {attempt:1|2;stage:(value:GuardStage)=>void;host:(value:string)=>void;}
export interface GuardDiagnostic {
  checkId:string;provider:PoolProvider;attempt:1|2;stage:GuardStage;hostId:string|null;
  outcome:'allowed'|'direct'|'blocked'|'timeout'|'invalid_decision'|'rpc_failed';
  durationMs:number;deadlineMs:number;deadlineOverrunMs:number;stageMs:Partial<Record<GuardStage,number>>;
}
export type GuardRead=(provider:PoolProvider,signal:AbortSignal,trace:GuardReadTrace)=>Promise<unknown>;
// Budget is per fresh read. A timeout permits one more read, never an upstream replay.
export const GUARD_CHECK_TIMEOUT_MS=4000;
export function createGuardNetworkCheck(read:GuardRead,timeoutMs=GUARD_CHECK_TIMEOUT_MS,observe?:(event:GuardDiagnostic)=>void) {
  const pending=new Map<PoolProvider,Promise<void|'direct'>>();
  const check=async(provider:PoolProvider)=>{
    const checkId=randomUUID();
    const checkOnce=async(attempt:1|2)=>{
      const started=performance.now();let stageStarted=started;
      let stage:GuardStage='permission',hostId:string|null=null;
      const stageMs:Partial<Record<GuardStage,number>>={};
      let outcome:GuardDiagnostic['outcome']='rpc_failed';
      let timer:ReturnType<typeof setTimeout>|undefined;
      const controller=new AbortController();let timedOut=false,finished=false;
      const trace:GuardReadTrace={attempt,stage(value){
        // A late operation must not advance to another SDK call after cancellation.
        controller.signal.throwIfAborted();if(finished)return;
        const at=performance.now();stageMs[stage]=(stageMs[stage]??0)+Math.max(0,at-stageStarted);
        stage=value;stageStarted=at;
      },host(value){if(!finished&&/^host_[a-z0-9]{6,32}$/.test(value))hostId=value;}};
      try {
        const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
          timedOut=true;reject(new GuardRequiredError(provider,true,'timeout'));controller.abort();
        },timeoutMs);});
        const parsed=anyGuardDecisionSchema.safeParse(await Promise.race([Promise.resolve().then(()=>read(provider,controller.signal,trace)),timeout]));
        if(!parsed.success)throw new GuardRequiredError(provider,true,'invalid_decision');
        if(!parsed.data.allowed)throw new GuardRequiredError(provider);
        outcome=parsed.data.reason==='direct'?'direct':'allowed';
        return outcome==='direct'?'direct' as const:undefined;
      }catch(error){
        const safe=error instanceof GuardRequiredError?error:new GuardRequiredError(provider,true,timedOut?'timeout':'rpc_failed');
        outcome=safe.code==='VPN_GUARD_BLOCKED'?'blocked':safe.failureReason??'rpc_failed';throw safe;
      }finally{
        finished=true;if(timer!==undefined)clearTimeout(timer);
        const durationMs=Math.max(0,performance.now()-started);
        stageMs[stage]=(stageMs[stage]??0)+Math.max(0,performance.now()-stageStarted);
        try{observe?.({checkId,provider,attempt,stage,hostId,outcome,durationMs,deadlineMs:timeoutMs,
          deadlineOverrunMs:timedOut?Math.max(0,durationMs-timeoutMs):0,stageMs:{...stageMs}});}catch{/* Diagnostics cannot change admission. */}
      }
    };
    try{return await checkOnce(1);}
    catch(error){
      if(!(error instanceof GuardRequiredError)||error.failureReason!=='timeout')throw error;
      return checkOnce(2);
    }
  };
  return (provider:PoolProvider):Promise<void|'direct'>=>{
    if(!requiresGuardCheck(provider))return Promise.resolve();
    const current=pending.get(provider);if(current)return current;
    // Share only work still in progress. No completed permission is retained,
    // and new waiters cannot extend the original two-attempt deadline.
    const result=check(provider).finally(()=>{pending.delete(provider);});
    pending.set(provider,result);return result;
  };
}
