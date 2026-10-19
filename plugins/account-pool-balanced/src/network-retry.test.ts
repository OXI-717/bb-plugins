import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse, makeTurnFailedEvent } from '@get-bb/plugin-sdk/testing';
import { expect, it, vi } from 'vitest';
import { registerNetworkRetry } from './network-retry.js';
async function setup() {
 const retry=vi.fn(async(_input:unknown)=>({ok:true,delivery:'queued'}) as never);
 const fake=createFakePluginHost({pluginId:'account-pool-balanced',sdk:{threads:{get:async()=>makeThreadResponse({id:'thread-one',status:'error'}),queue:{list:async()=>[]},events:{list:async()=>[{threadId:'thread-one',type:'client/turn/requested',data:{requestId:'request-one'}}] as never},retry}}});
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
it('cancels an uncertain native retry after reload when the user has moved on',async()=>{
 const {fake,retry,fail}=await setup();retry.mockRejectedValue(Error('lost reply'));await fail();
 const reloaded=await fake.harness.lifecycle.reload(bb=>registerNetworkRetry(bb,async()=>true));
 reloaded.harness.sdk.stub('threads.get',async()=>makeThreadResponse({id:'thread-one',status:'idle'}));
 reloaded.harness.sdk.stub('threads.queue.list',async()=>[{id:'uncertain-retry',payload:{kind:'retry',retryOfTurnRequestId:'request-one',reason:'Temporary connection failure. Retry 1/3.'}},{id:'user-retry',payload:{kind:'retry',retryOfTurnRequestId:'request-one',reason:'Manual retry'}}] as never);
 const remove=vi.fn(async()=>({ok:true}) as never);reloaded.harness.sdk.stub('threads.queuedMessages.delete',remove);
 const service=reloaded.harness.behavior.runService('network-retry-recovery');await service.done;
 expect(remove).toHaveBeenCalledExactlyOnceWith({threadId:'thread-one',queuedMessageId:'uncertain-retry'});expect(retry).toHaveBeenCalledTimes(1);await reloaded.harness.lifecycle.dispose();
});
it('removes an old retry on reload when newer user work also ended in error',async()=>{
 const {fake,retry,fail}=await setup();retry.mockRejectedValue(Error('lost reply'));await fail();
 const reloaded=await fake.harness.lifecycle.reload(bb=>registerNetworkRetry(bb,async()=>true));
 reloaded.harness.sdk.stub('threads.events.list',async()=>[{threadId:'thread-one',type:'client/turn/requested',data:{requestId:'new-request'}}] as never);
 reloaded.harness.sdk.stub('threads.queue.list',async()=>[{id:'owned',payload:{kind:'retry',retryOfTurnRequestId:'request-one',reason:'Temporary connection failure. Retry 1/3.'}},{id:'foreign',payload:{kind:'retry',retryOfTurnRequestId:'different-request',reason:'Manual'}}] as never);
 const remove=vi.fn(async()=>({ok:true}) as never);reloaded.harness.sdk.stub('threads.queuedMessages.delete',remove);
 const service=reloaded.harness.behavior.runService('network-retry-recovery');await service.done;
 expect(remove).toHaveBeenCalledExactlyOnceWith({threadId:'thread-one',queuedMessageId:'owned'});await reloaded.harness.lifecycle.dispose();
});
it('removes a late scheduling result after a newer user failure',async()=>{
 const {fake,retry,fail}=await setup();let release!:(value:never)=>void;let entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});
 retry.mockImplementation(()=>{entered();return new Promise(r=>{release=r;});});
 const failed=fail();await ready;
 await fake.harness.behavior.emitThreadEvent('thread.active',{thread:makeThreadResponse({id:'thread-one',status:'active'})});
 fake.harness.sdk.stub('threads.events.list',async()=>[{threadId:'thread-one',type:'client/turn/requested',data:{requestId:'new-user-request'}}] as never);
 fake.harness.sdk.stub('threads.queue.list',async()=>[{id:'late-owned',payload:{kind:'retry',retryOfTurnRequestId:'request-one',reason:'Temporary connection failure. Retry 1/3.'}}] as never);
 const remove=vi.fn(async()=>({ok:true}) as never);fake.harness.sdk.stub('threads.queuedMessages.delete',remove);
 release({ok:true,delivery:'queued',queuedMessageId:'late-owned'} as never);await failed;
 expect(remove).toHaveBeenCalledExactlyOnceWith({threadId:'thread-one',queuedMessageId:'late-owned'});await fake.harness.lifecycle.dispose();
});

it('rejects a late owned queued retry at dispatch after a lost scheduling reply and newer user failure',async()=>{
 const {fake,retry,fail}=await setup();retry.mockRejectedValue(Error('lost reply'));await fail();
 fake.harness.sdk.stub('threads.events.list',async()=>[{threadId:'thread-one',type:'client/turn/requested',data:{requestId:'new-user-request'}}] as never);
 const hook=fake.harness.registrations.hooks['message.dispatch'];expect(hook).toBeTypeOf('function');
 const result=await hook!(makeMessageDispatchHookContext({thread:{id:'thread-one',status:'error'},queuedMessage:{id:'late-owned',payload:{kind:'retry',retryOfTurnRequestId:'request-one',attempt:2,reason:'Temporary connection failure. Retry 1/3.'}}}));
 expect(result.action).toBe('reject');await fake.harness.lifecycle.dispose();
});
it('permits the current owned queued retry and never fences manual retries or ordinary messages',async()=>{
 const {fake,fail}=await setup();await fail();const hook=fake.harness.registrations.hooks['message.dispatch'];expect(hook).toBeTypeOf('function');
 const context=makeMessageDispatchHookContext({thread:{id:'thread-one',status:'error'},queuedMessage:{payload:{kind:'retry',retryOfTurnRequestId:'request-one',attempt:2,reason:'Temporary connection failure. Retry 1/3.'}}});
 expect(await hook!(context)).toEqual({action:'proceed'});
 fake.harness.sdk.stub('threads.events.list',async()=>{throw Error('unavailable');});
 expect(await hook!({...context,queuedMessage:{...context.queuedMessage!,payload:{kind:'retry',retryOfTurnRequestId:'request-one',attempt:2,reason:'Manual retry'}}})).toEqual({action:'proceed'});
 expect(await hook!({...context,queuedMessage:null})).toEqual({action:'proceed'});await fake.harness.lifecycle.dispose();
});
it('holds an owned queued retry when current request history is unavailable',async()=>{
 const {fake,fail}=await setup();await fail();fake.harness.sdk.stub('threads.events.list',async()=>{throw Error('private');});
 const hook=fake.harness.registrations.hooks['message.dispatch'];expect(hook).toBeTypeOf('function');
 expect(await hook!(makeMessageDispatchHookContext({thread:{id:'thread-one',status:'error'},queuedMessage:{payload:{kind:'retry',retryOfTurnRequestId:'request-one',attempt:2,reason:'Temporary connection failure. Retry 1/3.'}}}))).toMatchObject({action:'wait',sendAt:110_000});
 await fake.harness.lifecycle.dispose();
});

it('bounds a stalled dispatch history read and shares its slot until the underlying I/O settles',async()=>{
 vi.useFakeTimers();const {fake,fail}=await setup();await fail();let release!:(rows:never)=>void;
 const read=vi.fn(()=>new Promise<never>(resolve=>{release=resolve;}));fake.harness.sdk.stub('threads.events.list',read);
 const hook=fake.harness.registrations.hooks['message.dispatch']!;
 const context=makeMessageDispatchHookContext({thread:{id:'thread-one',status:'error'},queuedMessage:{payload:{kind:'retry',retryOfTurnRequestId:'request-one',attempt:2,reason:'Temporary connection failure. Retry 1/3.'}}});
 try{
  const first=hook(context);await vi.advanceTimersByTimeAsync(1_500);expect(await first).toMatchObject({action:'wait'});
  const second=hook(context);await vi.advanceTimersByTimeAsync(1_500);expect(await second).toMatchObject({action:'wait'});expect(read).toHaveBeenCalledTimes(1);
  release([{threadId:'thread-one',type:'client/turn/requested',data:{requestId:'request-one'}}] as never);await Promise.resolve();await Promise.resolve();
 }finally{await fake.harness.lifecycle.dispose();vi.useRealTimers();}
});

it('refuses new scheduling at capacity without evicting queued ownership, and reclaims confirmed completed rows',async()=>{
 const fake=createFakePluginHost({pluginId:'account-pool-balanced'});
 const claims=Array.from({length:256},(_,i)=>({threadId:`old-${i}`,requestId:`request-${i}`,originalRequestId:`request-${i}`,attempt:1,queuedMessageId:`queue-${i}`}));
 await fake.bb.storage.kv.set('network-retry-claims-v1',claims);
 const retry=vi.fn(async()=>({ok:true,delivery:'queued',queuedMessageId:'fresh-queue'}) as never);
 fake.harness.sdk.stub('threads.retry',retry);fake.harness.sdk.stub('threads.get',async()=>makeThreadResponse({id:'fresh-thread',status:'error'}));
 fake.harness.sdk.stub('threads.events.list',async()=>[{threadId:'fresh-thread',type:'client/turn/requested',data:{requestId:'fresh-request'}}] as never);
 fake.harness.sdk.stub('threads.queue.list',async()=>[]);
 await registerNetworkRetry(fake.bb,async()=>true);
 const fail=()=>fake.harness.behavior.emitThreadEvent('turn.failed',makeTurnFailedEvent({threadId:'fresh-thread',requestId:'fresh-request',errorInfo:{category:'connection-failed',httpStatusCode:503,providerCode:null}}));
 await fail();expect(retry).not.toHaveBeenCalled();expect(await fake.bb.storage.kv.get('network-retry-claims-v1')).toEqual(claims);
 fake.harness.sdk.stub('threads.queue.list',async()=>[]);
 await fake.harness.behavior.emitThreadEvent('thread.active',{thread:makeThreadResponse({id:'old-0',status:'active'})});
 await fail();expect(retry).toHaveBeenCalledTimes(1);
 expect((await fake.bb.storage.kv.get('network-retry-claims-v1') as unknown[])).toHaveLength(256);await fake.harness.lifecycle.dispose();
});
it('rejects an owned retry when the user bypasses routing or disables its usable accounts during the delay',async()=>{
 const {fake,fail,eligible}=await setup();await fail();eligible.mockResolvedValue(false);
 const hook=fake.harness.registrations.hooks['message.dispatch']!;
 expect(await hook(makeMessageDispatchHookContext({thread:{id:'thread-one',status:'error'},queuedMessage:{payload:{kind:'retry',retryOfTurnRequestId:'request-one',attempt:2,reason:'Temporary connection failure. Retry 1/3.'}}}))).toMatchObject({action:'reject'});
 expect(fake.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);await fake.harness.lifecycle.dispose();
});
it('rejects an owned retry when the provider changes before queue drain',async()=>{
 const {fake,fail}=await setup();await fail();const hook=fake.harness.registrations.hooks['message.dispatch']!;
 expect(await hook(makeMessageDispatchHookContext({thread:{id:'thread-one',status:'error'},requestedExecution:{providerId:'different-provider'},queuedMessage:{payload:{kind:'retry',retryOfTurnRequestId:'request-one',attempt:2,reason:'Temporary connection failure. Retry 1/3.'}}}))).toMatchObject({action:'reject'});
 await fake.harness.lifecycle.dispose();
});
it('holds recognizable automatic queue rows when their ownership journal is malformed without affecting manual retries',async()=>{
 const fake=createFakePluginHost({pluginId:'account-pool-balanced'});await fake.bb.storage.kv.set('network-retry-claims-v1',{invalid:true});await registerNetworkRetry(fake.bb,async()=>true);
 const hook=fake.harness.registrations.hooks['message.dispatch']!;
 const context=makeMessageDispatchHookContext({queuedMessage:{payload:{kind:'retry',retryOfTurnRequestId:'request-one',attempt:2,reason:'Temporary connection failure. Retry 1/3.'}}});
 expect(await hook(context)).toMatchObject({action:'wait'});
 expect(await hook({...context,queuedMessage:{...context.queuedMessage!,payload:{kind:'retry',retryOfTurnRequestId:'request-one',attempt:2,reason:'Manual retry'}}})).toEqual({action:'proceed'});
 await fake.harness.lifecycle.dispose();
});
