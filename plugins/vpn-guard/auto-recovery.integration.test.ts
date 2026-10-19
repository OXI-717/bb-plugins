import {createFakePluginHost,makeThreadResponse,makeHostResponse,makeMessageDispatchHookContext} from '@get-bb/plugin-sdk/testing';
import {expect,it,vi} from 'vitest';
import plugin from './server.js';
import {verifiedHostResult} from './vpn-test-fixture.js';
import {statusSchema} from './contract.js';

async function setup(swap?:'request'|'provider'){
 let connected=false;let running=true;let updatedAt=0;let sent=0;let providerId='codex';let requestId='request-one';let interruptedAt=0;
 const fake=createFakePluginHost({pluginId:'vpn-guard',sdk:{hosts:{list:async()=>[makeHostResponse({id:'host-a'})]},plugins:{list:async()=>({plugins:[]}) as never},threads:{events:{list:async()=>[...(!running?[{threadId:'thread-one',seq:3,createdAt:interruptedAt,type:'turn/completed',scope:{kind:'turn',turnId:'turn-one'},data:{status:'interrupted'}}]:[]),{threadId:'thread-one',seq:2,type:'turn/started',scope:{kind:'turn',turnId:'turn-one'},data:{}},{threadId:'thread-one',seq:requestId==='request-one'?1:4,type:'client/turn/requested',scope:{kind:'thread'},data:{requestId}}] as never},listRunning:async()=>running?[{id:'thread-one',hostId:'host-a'}]:[],get:async()=>makeThreadResponse({id:'thread-one',providerId,status:running?'active':'idle',updatedAt}),stop:async()=>{running=false;updatedAt=Date.now();interruptedAt=updatedAt;if(swap){updatedAt-=500;if(swap==='provider')providerId='acp-opencode-kimi';else requestId='new-user-request';}return {} as never;},send:async()=>{const hook=fake.harness.registrations.hooks['message.dispatch']!;expect(await hook(makeMessageDispatchHookContext({requestedExecution:{providerId:'codex'},host:{id:'host-a',name:'host-a'}}))).toEqual({action:'proceed'});sent++;return {ok:true,delivery:'sent'} as never;}}},experimental_callHostRpc:async()=>verifiedHostResult(connected?'connected':'disconnected')});
 await plugin(fake.bb);await fake.harness.behavior.callRpc('setHosts',{hostIds:['host-a']});await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
 return {fake,connect:()=>{connected=true;},change:()=>{updatedAt=Date.now()+10_000;},sent:()=>sent};
}
it('automatically continues a new Guard stop after proof recovers, through admission',async()=>{
 const t=await setup();expect(t.sent()).toBe(0);t.connect();const service=t.fake.harness.behavior.runService('reconcile');
 try{await vi.waitFor(()=>expect(t.sent()).toBe(1));}finally{service.controller.abort();await service.done;await t.fake.harness.lifecycle.dispose();}
});
it('does not auto-continue after later user activity',async()=>{
 const t=await setup();t.connect();t.change();const service=t.fake.harness.behavior.runService('reconcile');
 try{await new Promise(r=>setTimeout(r,50));expect(t.sent()).toBe(0);}finally{service.controller.abort();await service.done;await t.fake.harness.lifecycle.dispose();}
});
it('waits through manual block and continues after explicit unblock',async()=>{
 const t=await setup();t.connect();await t.fake.harness.behavior.callRpc('setManualBlock',{blocked:true});
 const blocked=t.fake.harness.behavior.runService('reconcile');await new Promise(r=>setTimeout(r,30));expect(t.sent()).toBe(0);blocked.controller.abort();await blocked.done;
 await t.fake.harness.behavior.callRpc('setManualBlock',{blocked:false});const released=t.fake.harness.behavior.runService('reconcile');
 try{await vi.waitFor(()=>expect(t.sent()).toBe(1));const state=statusSchema.parse(await t.fake.harness.behavior.callRpc('status',null));expect(state.manualBlock).toBe(false);}finally{released.controller.abort();await released.done;await t.fake.harness.lifecycle.dispose();}
});
it('keeps manual blocking responsive during an automatic continuation send',async()=>{
 const t=await setup();t.connect();let entered!:()=>void;let release!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 t.fake.harness.sdk.stub('threads.send',async()=>{entered();await gate;return {ok:true,delivery:'sent'} as never;});
 const service=t.fake.harness.behavior.runService('reconcile');
 try{await ready;await t.fake.harness.behavior.callRpc('setManualBlock',{blocked:true});expect(await t.fake.harness.behavior.callRpc('status',null)).toMatchObject({manualBlock:true});}
 finally{release();service.controller.abort();await service.done;await t.fake.harness.lifecycle.dispose();}
});
it('never duplicates an uncertain automatic send after reload',async()=>{
 const t=await setup();t.connect();let sends=0;
 t.fake.harness.sdk.stub('threads.send',async()=>{sends++;throw Error('unknown outcome');});
 const service=t.fake.harness.behavior.runService('reconcile');
 await vi.waitFor(()=>expect(sends).toBe(1));service.controller.abort();await service.done;
 const reloaded=await t.fake.harness.lifecycle.reload(plugin);const again=reloaded.harness.behavior.runService('reconcile');
 try{await new Promise(r=>setTimeout(r,50));expect(sends).toBe(1);}
 finally{again.controller.abort();await again.done;await reloaded.harness.lifecycle.dispose();}
});
it('continues a newly stopped thread after explicit unblock also in Observe',async()=>{
 const t=await setup();await t.fake.harness.behavior.callRpc('setManualBlock',{blocked:true});await t.fake.harness.behavior.callRpc('setMode',{mode:'observe'});t.connect();await t.fake.harness.behavior.callRpc('setManualBlock',{blocked:false});
 const service=t.fake.harness.behavior.runService('reconcile');
 try{await vi.waitFor(()=>expect(t.sent()).toBe(1));}finally{service.controller.abort();await service.done;await t.fake.harness.lifecycle.dispose();}
});
it.each(['request','provider'] as const)('does not claim newer %s work completed before the old stop ACK',async swap=>{
 const t=await setup(swap);t.connect();const service=t.fake.harness.behavior.runService('reconcile');
 try{await new Promise(r=>setTimeout(r,50));expect(t.sent()).toBe(0);expect(await t.fake.bb.storage.kv.get('thread-resume-claims-v1')).toBeUndefined();}
 finally{service.controller.abort();await service.done;await t.fake.harness.lifecycle.dispose();}
});
