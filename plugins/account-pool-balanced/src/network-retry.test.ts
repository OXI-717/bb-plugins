import { createFakePluginHost, makeThreadResponse, makeTurnFailedEvent } from '@get-bb/plugin-sdk/testing';
import { expect, it, vi } from 'vitest';
import { registerNetworkRetry } from './network-retry.js';
async function setup() {
 const retry=vi.fn(async(_input:unknown)=>({ok:true,delivery:'queued'}) as never);
 const fake=createFakePluginHost({pluginId:'account-pool-balanced',sdk:{threads:{get:async()=>makeThreadResponse({id:'thread-one',status:'error'}),queue:{list:async()=>[]},retry}}});
 const eligible=vi.fn(async()=>true);await registerNetworkRetry(fake.bb,eligible,()=>100_000,()=>0);
 const fail=async(overrides:Parameters<typeof makeTurnFailedEvent>[0]={})=>fake.harness.behavior.emitThreadEvent('turn.failed',makeTurnFailedEvent({threadId:'thread-one',requestId:'request-one',attemptNumber:1,errorInfo:{category:'connection-failed',httpStatusCode:502,providerCode:'POOL_UPSTREAM_UNAVAILABLE'},...overrides}));
 return {fake,retry,eligible,fail};
}
it('queues by failed-turn reference without a new message',async()=>{
 const {fake,retry,fail}=await setup();await fail();expect(retry).toHaveBeenCalledExactlyOnceWith({threadId:'thread-one',turnRequestId:'request-one',sendAt:130_000,reason:'Temporary connection failure. Retry 1/3.'});expect(fake.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);await fake.harness.lifecycle.dispose();
});
it.each([[2,220_000],[3,400_000]])('bounds backoff for attempt %i',async(attemptNumber,sendAt)=>{
 const {fake,retry,fail}=await setup();await fail({attemptNumber});expect(retry.mock.calls[0]?.[0]).toMatchObject({sendAt});await fake.harness.lifecycle.dispose();
});
it.each([4,5,10])('respects the shared attempt budget at %i',async(attemptNumber)=>{
 const {fake,retry,fail}=await setup();await fail({attemptNumber});expect(retry).not.toHaveBeenCalled();await fake.harness.lifecycle.dispose();
});
it.each(['unauthorized','policy','rate-limit','overloaded','billing','bad-request','internal','unknown'] as const)('does not compete with core policy for %s',async category=>{
 const {fake,retry,fail}=await setup();await fail({errorInfo:{category,httpStatusCode:500,providerCode:null}});expect(retry).not.toHaveBeenCalled();await fake.harness.lifecycle.dispose();
});
it('ignores null failures and unrelated routes',async()=>{
 const {fake,retry,fail,eligible}=await setup();await fail({errorInfo:null});eligible.mockResolvedValue(false);await fail();expect(retry).not.toHaveBeenCalled();await fake.harness.lifecycle.dispose();
});
it('does not replace user work or an existing retry',async()=>{
 const {fake,retry,fail}=await setup();fake.harness.sdk.stub('threads.queue.list',async()=>[{id:'existing'}] as never);await fail();expect(retry).not.toHaveBeenCalled();await fake.harness.lifecycle.dispose();
});
it('does not retry after a thread moved on or was archived',async()=>{
 const {fake,retry,fail}=await setup();fake.harness.sdk.stub('threads.get',async()=>makeThreadResponse({id:'thread-one',status:'idle'}));await fail();fake.harness.sdk.stub('threads.get',async()=>makeThreadResponse({id:'thread-one',status:'error',archivedAt:1}));await fail();expect(retry).not.toHaveBeenCalled();await fake.harness.lifecycle.dispose();
});
it('deduplicates notifications',async()=>{
 const {fake,retry,fail}=await setup();await Promise.all([fail(),fail()]);await fail();expect(retry).toHaveBeenCalledTimes(1);await fake.harness.lifecycle.dispose();
});
it('does not replay an uncertain scheduling call or log its raw error',async()=>{
 const {fake,retry,fail}=await setup();retry.mockRejectedValue(new Error('private'));await fail();await fail();expect(retry).toHaveBeenCalledTimes(1);expect(JSON.stringify(fake.harness.inspection.logEntries)).not.toContain('private');await fake.harness.lifecycle.dispose();
});
it('uses only a normalized Cursor provider error inside the exact failed request',async()=>{
 const {fake,retry,fail}=await setup();
 fake.harness.sdk.stub('threads.get',async()=>makeThreadResponse({id:'thread-one',providerId:'acp-oxi-cursor',status:'error'}));
 fake.harness.sdk.stub('threads.events.list',async()=>[
  {threadId:'thread-one',type:'provider/error',data:{message:'[POOL_UPSTREAM_UNAVAILABLE] Pooler connection temporarily unavailable.'}},
  {threadId:'thread-one',type:'client/turn/requested',data:{requestId:'request-one'}}
 ] as never);
 await fail({errorInfo:null});expect(retry).toHaveBeenCalledTimes(1);await fake.harness.lifecycle.dispose();
});
it.each(['wrong-request','assistant-only','later-error'])('does not guess a Cursor failure from %s',async kind=>{
 const {fake,retry,fail}=await setup();
 fake.harness.sdk.stub('threads.get',async()=>makeThreadResponse({id:'thread-one',providerId:'acp-oxi-cursor',status:'error'}));
 const provider={threadId:'thread-one',type:'provider/error',data:{message:'[POOL_UPSTREAM_UNAVAILABLE] Pooler connection temporarily unavailable.'}};
 fake.harness.sdk.stub('threads.events.list',async()=>[
  ...(kind==='later-error'?[{...provider,data:{message:'different failure'}}]:[]),
  {...provider,type:kind==='assistant-only'?'item/agentMessage/delta':'provider/error'},
  {threadId:'thread-one',type:'client/turn/requested',data:{requestId:kind==='wrong-request'?'new-request':'request-one'}}
 ] as never);
 await fail({errorInfo:null});expect(retry).not.toHaveBeenCalled();await fake.harness.lifecycle.dispose();
});
it('cancels only its still-queued retry after the user starts another turn',async()=>{
 const {fake,retry,fail}=await setup();retry.mockResolvedValue({ok:true,delivery:'queued',queuedMessageId:'owned-retry'} as never);
 const remove=vi.fn(async()=>({}) as never);fake.harness.sdk.stub('threads.queuedMessages.delete',remove);
 await fail();fake.harness.sdk.stub('threads.queue.list',async()=>[{id:'owned-retry',payload:{kind:'retry'}},{id:'user-message',payload:{kind:'inline'}}] as never);
 await fake.harness.behavior.emitThreadEvent('thread.active',{thread:makeThreadResponse({id:'thread-one',status:'active'})});
 expect(remove).toHaveBeenCalledExactlyOnceWith({threadId:'thread-one',queuedMessageId:'owned-retry'});await fake.harness.lifecycle.dispose();
});
it('retains the failed-turn reference when the original input was never accepted',async()=>{
 const {fake,retry,fail}=await setup();await fail({inputAccepted:false});
 expect(retry.mock.calls[0]?.[0]).toMatchObject({turnRequestId:'request-one'});expect(fake.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);await fake.harness.lifecycle.dispose();
});
it('retains durable ownership across reload and does not schedule twice',async()=>{
 const {fake,retry,fail}=await setup();await fail();
 const reloaded=await fake.harness.lifecycle.reload(bb=>registerNetworkRetry(bb,async()=>true,()=>100_000,()=>0));
 await reloaded.harness.behavior.emitThreadEvent('turn.failed',makeTurnFailedEvent({threadId:'thread-one',requestId:'request-one',attemptNumber:1,errorInfo:{category:'connection-failed',httpStatusCode:502,providerCode:null}}));
 expect(retry).toHaveBeenCalledTimes(1);await reloaded.harness.lifecycle.dispose();
});
