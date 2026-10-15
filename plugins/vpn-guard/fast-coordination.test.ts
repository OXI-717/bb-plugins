import {expect,it,vi} from 'vitest';
import {createFakePluginHost,makeHostResponse,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import plugin from './server.js';
import {verifiedHostResult} from './vpn-test-fixture.js';
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
async function setup(options:{pending?:boolean;pauseAction?:string;hostId?:string}={}) {
 const hostId=options.hostId??'host-a';let nativeEnabled=true;let connected=true;let owner='';let pending=options.pending??false;let pausedAction:string|null=options.pauseAction??'status';
 let entered=deferred<void>();let pause=deferred<void>();const actions:string[]=[];let stops=0;
 const report=()=>({schema:'oxi-auto/protection-status/1',blocked:!!owner||pending,holds:owner?[{owner,reason:'Guard'}]:[],recoveryPending:pending,pausedCount:pending?1:0,activeRuns:[],errors:[],legacyBlocked:false,restoreRevision:'a'.repeat(64)});
 const fake=createFakePluginHost({pluginId:'vpn-guard',sdk:{plugins:{list:async()=>({plugins:[{id:'provider-codex',enabled:nativeEnabled},{id:'provider-claude-code',enabled:false}]}),disable:async()=>{nativeEnabled=false;return {} as never;}},system:{config:async()=>({primaryHostId:hostId}) as never},hosts:{list:async()=>[makeHostResponse({id:hostId})]},threads:{listRunning:async()=>[{id:'thread-a',hostId}],get:async()=>makeThreadResponse({id:'thread-a',providerId:'codex'}),stop:async()=>{stops++;return {} as never;}}},experimental_callHostRpc:async({method,input})=>{
  if(method==='readState')return verifiedHostResult(connected?'connected':'disconnected');
  const args=input as {action:string;instanceId:string};actions.push(args.action);
  if(args.action===pausedAction){pausedAction=null;entered.resolve();await pause.promise;}
  if(args.action==='hold'){owner='vpn-guard:'+args.instanceId;pending=true;}
  if(args.action==='resume')pending=false;
  if(args.action==='release')owner='';
  return report();
 }});
 await plugin(fake.bb);
 const rpc=fake.harness.behavior.callRpc;
 await rpc('setHosts',{hostIds:[hostId]});await rpc('setMode',{mode:'enforce'});
 return {fake,rpc,actions,nativeEnabled:()=>nativeEnabled,entered:()=>entered.promise,release:()=>pause.resolve(),pauseStatus:()=>{pausedAction='status';entered=deferred<void>();pause=deferred<void>();},pauseRelease:()=>{pausedAction='release';entered=deferred<void>();pause=deferred<void>();},setConnected:(value:boolean)=>{connected=value;},stops:()=>stops,owner:()=>owner};
}
async function idle(s:Awaited<ReturnType<typeof setup>>) {
 await vi.waitFor(async()=>{const v=await s.rpc('status',null) as {automations:{busy:boolean;needsReconcile:boolean}};expect(v.automations.busy).toBe(false);expect(v.automations.needsReconcile).toBe(false);});
}
it('applies a manual block and stops threads while controller status is pending',async()=>{
 const s=await setup();const connect=s.rpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});await s.entered();
 await expect(Promise.race([connect.then(()=>true),new Promise(r=>setTimeout(()=>r(false),500))])).resolves.toBe(true);
 await expect(Promise.race([s.rpc('setManualBlock',{blocked:true}).then(()=>true),new Promise(r=>setTimeout(()=>r(false),500))])).resolves.toBe(true);
 expect(s.stops()).toBeGreaterThan(0);expect(s.actions).toEqual(['status']);
 s.release();await idle(s);expect(s.owner()).toMatch(/^vpn-guard:/);
 await s.fake.harness.lifecycle.dispose();
});
it('keeps the periodic protection service independent of a slow controller',async()=>{
 const s=await setup();void s.rpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});await s.entered();
 s.setConnected(false);const service=s.fake.harness.runService('reconcile');
 await vi.waitFor(()=>expect(s.stops()).toBeGreaterThan(0));
 service.controller.abort();await service.done;s.release();await idle(s);
 expect(s.actions).toContain('hold');await s.fake.harness.lifecycle.dispose();
});
it('retains its binding after a stale release and reacquires the latest required hold',async()=>{
 const s=await setup();void s.rpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});await s.entered();
 await s.rpc('setManualBlock',{blocked:true});s.release();await idle(s);
 s.pauseRelease();await s.rpc('setManualBlock',{blocked:false});await s.entered();
 await s.rpc('setManualBlock',{blocked:true});s.release();await idle(s);
 expect(s.owner()).toMatch(/^vpn-guard:/);
 const status=await s.rpc('status',null) as {automations:{held:boolean};events:{kind:string}[]};
 expect(status.automations.held).toBe(true);expect(status.events.some(e=>e.kind==='automation_release')).toBe(false);
 await s.fake.harness.lifecycle.dispose();
});
it('does not persist a late controller response after disposal',async()=>{
 const s=await setup();void s.rpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});await s.entered();
 const save=s.fake.bb.storage.kv.set.bind(s.fake.bb.storage.kv);let writes=0;
 s.fake.bb.storage.kv.set=async(key,value)=>{writes++;return save(key,value);};
 await s.fake.harness.lifecycle.dispose();const before=writes;
 s.release();await new Promise(r=>setTimeout(r,10));
 expect(writes).toBe(before);
});

it('does not accept a late automatic resume after a new manual block',async()=>{
 const s=await setup({pending:true,pauseAction:'resume'});void s.rpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});await s.entered();
 await s.rpc('setManualBlock',{blocked:true});s.release();await idle(s);
 expect(s.owner()).toMatch(/^vpn-guard:/);
 const status=await s.rpc('status',null) as {events:{kind:string}[]};
 expect(status.events.some(e=>e.kind==='automation_restored')).toBe(false);
 await s.fake.harness.lifecycle.dispose();
});
it('reconciles current VPN denial instead of resuming from a delayed healthy status',async()=>{
 const s=await setup({pending:true});void s.rpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});await s.entered();
 s.setConnected(false);await s.rpc('setMode',{mode:'enforce'});s.release();await idle(s);
 expect(s.actions).not.toContain('resume');expect(s.owner()).toMatch(/^vpn-guard:/);
 await s.fake.harness.lifecycle.dispose();
});

it('stops protected threads without awaiting optional event persistence',async()=>{
 const s=await setup();await s.rpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});const stalled=deferred<void>();const save=s.fake.bb.storage.kv.set.bind(s.fake.bb.storage.kv);
 s.fake.bb.storage.kv.set=async(key,value)=>{if(key==='protection-events-v1')await stalled.promise;return save(key,value);};
 try {
  await expect(Promise.race([s.rpc('setManualBlock',{blocked:true}).then(()=>true),new Promise(r=>setTimeout(()=>r(false),500))])).resolves.toBe(true);
  expect(s.stops()).toBeGreaterThan(0);expect(s.nativeEnabled()).toBe(false);
  const status=await s.rpc('status',null) as {events:{kind:string}[]};expect(status.events.some(e=>e.kind==='manual_block_on')).toBe(true);
 } finally {stalled.resolve();await s.fake.harness.lifecycle.dispose();}
});

it('reports a passive status-only poll without pending policy changes',async()=>{
 const s=await setup();void s.rpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});await s.entered();s.release();await idle(s);
 s.pauseStatus();const service=s.fake.harness.runService('reconcile');await s.entered();
 try {
  const status=await s.rpc('status',null) as {automations:{busy:boolean;needsReconcile:boolean}};
  expect(status.automations.busy).toBe(true);expect(status.automations.needsReconcile).toBe(false);
 } finally {service.controller.abort();s.release();await service.done;await s.fake.harness.lifecycle.dispose();}
});

it('contains rejected diagnostic identifiers before native disable and thread stop',async()=>{
 const s=await setup({hostId:'h'.repeat(161)});
 await s.rpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
 await s.rpc('setManualBlock',{blocked:true});expect(s.stops()).toBeGreaterThan(0);expect(s.nativeEnabled()).toBe(false);
 await s.fake.harness.lifecycle.dispose();
});
