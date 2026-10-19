import type { BbPluginApi, PluginTurnFailedEvent } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const KEY='network-retry-claims-v1';
const claimsSchema=z.array(z.object({threadId:z.string().min(1).max(160),requestId:z.string().min(1).max(160),queuedMessageId:z.string().min(1).max(160).optional()})).max(256);
const DELAYS=[30_000,120_000,300_000] as const;
export function retryableNetworkFailure(failure:PluginTurnFailedEvent):boolean {
  if(!Number.isInteger(failure.attemptNumber)||failure.attemptNumber<1||failure.attemptNumber>3)return false;
  const error=failure.errorInfo;
  if(!error)return false;
  if(error.category==='connection-failed'||error.category==='stream-disconnected')return true;
  // Stable local codes only; never infer retries from arbitrary exception text.
  return ['POOL_UPSTREAM_UNAVAILABLE','VPN_REQUIRED','VPN_GUARD_BLOCKED','VPN_GUARD_UNAVAILABLE'].includes(error.providerCode??'') && (error.httpStatusCode??0)>=500 &&
    !['unauthorized','policy','billing','rate-limit','overloaded'].includes(error.category);
}
// ACP drops JSON-RPC error.data. Read only the latest provider error in the
// exact failed request, never assistant output or an older failure.
async function normalizedCursorFailure(bb:BbPluginApi,failure:PluginTurnFailedEvent):Promise<PluginTurnFailedEvent> {
  if(failure.errorInfo&&(!['unknown','internal'].includes(failure.errorInfo.category)||failure.errorInfo.providerCode))return failure;
  const rows=await bb.sdk.threads.events.list({threadId:failure.threadId,order:'desc',limit:'8',types:['provider/error','client/turn/requested']});
  let message:string|undefined;
  for(const row of rows){
    if(row.threadId!==failure.threadId)return failure;
    if(row.type==='client/turn/requested'){
      if(row.data.requestId!==failure.requestId||!message)return failure;
      const match=/^\[(POOL_UPSTREAM_UNAVAILABLE|VPN_REQUIRED|VPN_GUARD_BLOCKED|VPN_GUARD_UNAVAILABLE)\] Pooler connection temporarily unavailable\.$/.exec(message);
      return match?{...failure,errorInfo:{category:'connection-failed',httpStatusCode:503,providerCode:match[1]!}}:failure;
    }
    if(row.type==='provider/error'&&message===undefined)message=row.data.message;
  }
  return failure;
}
export async function registerNetworkRetry(bb:BbPluginApi,eligible:(threadId:string,providerId:string)=>Promise<boolean>,now=Date.now,random=Math.random) {
  const loaded=claimsSchema.safeParse((await bb.storage.kv.get(KEY))??[]);
  let claims=loaded.success?loaded.data:null;
  let disposed=false;
  if(!claims)bb.log.warn('Pooler retry journal is malformed; automatic retries are paused.');
  const flights=new Set<string>();
  let claimTail:Promise<void>=Promise.resolve();
  bb.onDispose(()=>{disposed=true;});
  async function cancelQueued(threadId:string){
    if(disposed||!claims)return;
    const owned=claims.filter(claim=>claim.threadId===threadId&&claim.queuedMessageId);
    if(!owned.length)return;
    const queue=await bb.sdk.threads.queue.list({threadId});
    for(const claim of owned){
      if(disposed)return;
      const entry=queue.find(row=>row.id===claim.queuedMessageId);
      if(entry?.payload.kind==='retry')await bb.sdk.threads.queuedMessages.delete({threadId,queuedMessageId:entry.id});
    }
  }
  // An own retry is removed from the queue before it activates its thread.
  // A still-queued owned row when something else starts (or stops) is stale.
  for(const name of ['thread.active','thread.idle'] as const)bb.events.on(name,async({thread})=>{
    try{await cancelQueued(thread.id);}catch{if(!disposed)bb.log.warn('Pooler queued retry cancellation could not be confirmed.');}
  });
  bb.events.on('turn.failed',async failure=>{
    if(disposed||!claims||!Number.isInteger(failure.attemptNumber)||failure.attemptNumber<1||failure.attemptNumber>3||flights.has(failure.threadId))return;
    flights.add(failure.threadId);
    try {
      const thread=await bb.sdk.threads.get({threadId:failure.threadId});
      if(disposed||thread.status!=='error'||thread.archivedAt!=null||thread.deletedAt!=null||thread.queuedMessageCount)return;
      if(!await eligible(thread.id,thread.providerId))return;
      const classified=thread.providerId==='acp-oxi-cursor'?await normalizedCursorFailure(bb,failure):failure;
      if(!retryableNetworkFailure(classified))return;
      if((await bb.sdk.threads.queue.list({threadId:thread.id})).length)return;
      const claim=claimTail.then(async()=>{
        if(disposed||!claims||claims.some(value=>value.threadId===thread.id&&value.requestId===failure.requestId))return false;
        const next=[...claims,{threadId:thread.id,requestId:failure.requestId}].slice(-256);
        await bb.storage.kv.set(KEY,next);claims=next;return true;
      });
      claimTail=claim.then(()=>undefined,()=>undefined);
      if(!await claim||disposed)return;
      const delay=DELAYS[failure.attemptNumber-1]!;
      // The core validates the exact failed request again, deduplicates the
      // original retry chain and preserves inputAccepted/attemptNumber semantics.
      const result=await bb.sdk.threads.retry({threadId:thread.id,turnRequestId:failure.requestId,
        sendAt:now()+delay+Math.floor(Math.max(0,Math.min(1,random()))*delay*0.1),
        reason:`Temporary connection failure. Retry ${failure.attemptNumber}/3.`});
      if(result.delivery==='queued'&&result.queuedMessageId){
        const record=claimTail.then(async()=>{
          if(disposed||!claims)return;
          const next=claims.map(value=>value.threadId===thread.id&&value.requestId===failure.requestId?{...value,queuedMessageId:result.queuedMessageId}:value);
          await bb.storage.kv.set(KEY,next);claims=next;
        });
        claimTail=record.then(()=>undefined,()=>undefined);await record;
        const current=await bb.sdk.threads.get({threadId:thread.id});
        if(current.status==='active'||current.status==='idle')await cancelQueued(thread.id);
      }
    } catch {
      // A timed-out RPC may already have queued the retry. Keep the durable
      // claim instead of blindly sending again; no raw exception in logs.
      if(!disposed)bb.log.warn('Pooler automatic network retry could not be confirmed; inspect the thread queue.');
    } finally {flights.delete(failure.threadId);}
  });
}
