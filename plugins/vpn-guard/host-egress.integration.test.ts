import {expect,it} from 'vitest';
import {createFakePluginHost,makeHostResponse,makeThreadResponse,makeMessageDispatchHookContext} from '@get-bb/plugin-sdk/testing';
import plugin from './server.js';

async function setup(){
 const available=new Set(['mac','vm']);
 const stopped:string[]=[];
 const running:{id:string,hostId:string}[]=[];
 const hostCalls:string[]=[];
 const fake=createFakePluginHost({pluginId:'vpn-guard',sdk:{
  hosts:{list:async()=>[...available].map(id=>makeHostResponse({id,name:id}))},
  system:{config:async()=>({primaryHostId:'vm'}) as never},
  plugins:{list:async()=>({plugins:[]}) as never,callRpc:async()=>({vpnGuardEnabled:true,vpnPolicyVersion:2,vpnOnlyProviders:['codex','claude','cursor','devin']}) as never},
  threads:{listRunning:async()=>running,get:async({threadId})=>makeThreadResponse({id:threadId,providerId:'codex'}),stop:async({threadId})=>{stopped.push(threadId);return {} as never}},
 },experimental_callHostRpc:async({hostId})=>{hostCalls.push(hostId);return {state:'disconnected',evidence:{state:'disconnected',assurance:'unverified',reason:'probe_failed',updatedAt:Date.now(),probeAt:Date.now()}}}});
 await plugin(fake.bb);await fake.harness.behavior.callRpc('setHosts',{hostIds:['mac','vm']});
 return {fake,available,stopped,running,hostCalls,dispatch:(hostId:string)=>fake.harness.registrations.hooks['message.dispatch']!(makeMessageDispatchHookContext({requestedExecution:{providerId:'codex'},host:{id:hostId,name:hostId}}))};
}
it('direct VM is independent of Mac VPN, while manual block wins',async()=>{
 const {fake}=await setup();try{
  await fake.harness.behavior.callRpc('setDirectHosts',{hostIds:['vm']});
  await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
  expect(await fake.harness.behavior.callRpc('networkDecisionV2',{hostId:'vm',provider:'codex'})).toMatchObject({allowed:true,reason:'direct',hostId:'vm'});
  expect(await fake.harness.behavior.callRpc('networkDecisionV2',{hostId:'mac',provider:'codex'})).toMatchObject({allowed:false,reason:'vpn_unavailable',hostId:'mac'});
  const status:any=await fake.harness.behavior.callRpc('status',null);
  expect(status.hosts.find((h:any)=>h.id==='vm')).toMatchObject({networkMode:'direct',vpn:null});
  await fake.harness.behavior.callRpc('setManualBlock',{blocked:true});
  expect(await fake.harness.behavior.callRpc('networkDecisionV2',{hostId:'vm',provider:'cursor'})).toMatchObject({allowed:false,reason:'manual_block'});
 }finally{await fake.harness.lifecycle.dispose();}
});
it('direct mode cannot be granted outside scope and is revoked when host is removed',async()=>{
 const {fake,available}=await setup();try{
  await expect(fake.harness.behavior.callRpc('setDirectHosts',{hostIds:['other']})).rejects.toThrow();
  await fake.harness.behavior.callRpc('setDirectHosts',{hostIds:['vm']});
  await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
  available.delete('vm');
  expect(await fake.harness.behavior.callRpc('networkDecisionV2',{hostId:'vm',provider:'codex'})).toMatchObject({allowed:false});
  await fake.harness.behavior.callRpc('setHosts',{hostIds:['mac']});
  expect((await fake.harness.behavior.callRpc('status',null) as any).directHostIds).toEqual([]);
 }finally{await fake.harness.lifecycle.dispose();}
});

it('keeps Mac dispatch and running-turn enforcement after the primary server moves',async()=>{
 const {fake,running,stopped,dispatch,hostCalls}=await setup();try{
  await fake.harness.behavior.callRpc('setDirectHosts',{hostIds:['vm']});
  hostCalls.length=0;
  running.push({id:'mac-turn',hostId:'mac'},{id:'vm-turn',hostId:'vm'});
  await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
  expect(stopped).toEqual(['mac-turn']);
  expect(await dispatch('mac')).toMatchObject({action:'wait'});
  expect(await dispatch('vm')).toMatchObject({action:'proceed'});
  expect(hostCalls).toContain('mac');
  expect(hostCalls).not.toContain('vm');
  await expect(fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true})).rejects.toThrow();
  expect(await fake.harness.behavior.callRpc('networkDecision',{hostId:'vm',provider:'codex'})).toMatchObject({allowed:false});
 }finally{await fake.harness.lifecycle.dispose();}
});
it('revokes direct admission when its grant is removed',async()=>{
 const {fake,dispatch}=await setup();try{
  await fake.harness.behavior.callRpc('setDirectHosts',{hostIds:['vm']});
  await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
  expect(await dispatch('vm')).toMatchObject({action:'proceed'});
  await fake.harness.behavior.callRpc('setDirectHosts',{hostIds:[]});
  expect(await dispatch('vm')).toMatchObject({action:'wait'});
 }finally{await fake.harness.lifecycle.dispose();}
});
