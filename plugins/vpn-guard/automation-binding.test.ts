import {expect,it,vi} from 'vitest';
import {createFakePluginHost,makeHostResponse} from '@get-bb/plugin-sdk/testing';
import plugin from './server.js';
import {verifiedHostResult} from './vpn-test-fixture.js';

async function setup(){
 let primary='mac';let connected=true;let offline=false;
 const calls:{hostId:string;action:string}[]=[];
 const report={schema:'oxi-auto/protection-status/1',blocked:false,holds:[] as {owner:string;reason:string}[],recoveryPending:false,pausedCount:0,activeRuns:[],errors:[],legacyBlocked:false,restoreRevision:'a'.repeat(64)};
 const fake=createFakePluginHost({pluginId:'vpn-guard',sdk:{
  system:{config:async()=>({primaryHostId:primary}) as never},
  hosts:{list:async()=>['mac','vm'].map(id=>makeHostResponse({id}))},
  threads:{listRunning:async()=>[]},
 },experimental_callHostRpc:async({hostId,method,input})=>{
  if(offline&&hostId==='mac')throw Error('Mac offline');
  if(method==='readState')return verifiedHostResult(connected?'connected':'disconnected');
  const args=input as {action:string;instanceId:string};calls.push({hostId,action:args.action});
  if(args.action==='hold'){report.holds=[{owner:'vpn-guard:'+args.instanceId,reason:'VPN'}];report.blocked=true;}
  if(args.action==='release'){report.holds=[];report.recoveryPending=true;}
  if(args.action==='resume'){report.recoveryPending=false;report.blocked=false;}
  return {...report,holds:[...report.holds]};
 }});
 await plugin(fake.bb);
 const rpc=(method:string,input:unknown)=>fake.harness.behavior.callRpc(method,input);
 async function settle(){await vi.waitFor(async()=>{const s:any=await rpc('status',null);expect(s.automations.busy).toBe(false);expect(s.automations.needsReconcile).toBe(false);});}
 await rpc('setHosts',{hostIds:['mac','vm']});
 await rpc('setDirectHosts',{hostIds:['vm']});
 await rpc('setMode',{mode:'enforce'});
 return {fake,rpc,settle,calls,report,offline:()=>{offline=true;},move:()=>{primary='vm';},vpn:(value:boolean)=>{connected=value;}};
}

it('keeps explicitly pinned Mac controller through primary-server migration and VPN recovery',async()=>{
 const s=await setup();try{
  await s.rpc('setAutomationHost',{hostId:'mac'});
  await s.rpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});await s.settle();
  s.move();s.calls.length=0;s.vpn(false);
  await s.rpc('setMode',{mode:'enforce'});await s.settle();
  expect(s.calls).toContainEqual({hostId:'mac',action:'hold'});
  await expect(s.rpc('setAutomationHost',{hostId:'vm'})).rejects.toThrow(/hold|busy/i);
  s.vpn(true);await s.rpc('setMode',{mode:'enforce'});await s.settle();
  expect(s.calls).toContainEqual({hostId:'mac',action:'release'});
  expect(s.calls).toContainEqual({hostId:'mac',action:'resume'});
  await s.rpc('automationAction',{action:'pause'});await s.settle();
  expect(s.calls.every(c=>c.hostId==='mac')).toBe(true);
  expect(await s.rpc('status',null)).toMatchObject({serverHostId:'vm',automationHostId:'mac'});
 }finally{await s.fake.harness.lifecycle.dispose();}
});

it('requires a selected enrolled controller host and preserves its selection while linked',async()=>{
 const s=await setup();try{
  await expect(s.rpc('setAutomationHost',{hostId:'unknown'})).rejects.toThrow(/selected|enrolled/i);
  await s.rpc('setAutomationHost',{hostId:'mac'});
  await s.rpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});await s.settle();
  await expect(s.rpc('setHosts',{hostIds:['vm']})).rejects.toThrow(/automation|controller/i);
 }finally{await s.fake.harness.lifecycle.dispose();}
});

it('preserves legacy primary-host behavior when no controller host was pinned',async()=>{
 const s=await setup();try{
  await s.rpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});await s.settle();
  expect(s.calls.some(c=>c.hostId==='mac')).toBe(true);
  expect(await s.rpc('status',null)).toMatchObject({automationHostId:null});
 }finally{await s.fake.harness.lifecycle.dispose();}
});

it('does not send a pinned controller operation to the direct server when Mac is offline',async()=>{
 const s=await setup();try{
  await s.rpc('setAutomationHost',{hostId:'mac'});
  await s.rpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});await s.settle();
  s.move();s.calls.length=0;s.offline();
  await s.rpc('setMode',{mode:'enforce'});
  await vi.waitFor(async()=>{const value:any=await s.rpc('status',null);expect(value.automations.error).toContain('Mac offline');expect(value.automations.busy).toBe(false);});
  expect(s.calls.some(c=>c.hostId==='vm')).toBe(false);
  await expect(s.rpc('automationAction',{action:'resume'})).rejects.toThrow();
 }finally{await s.fake.harness.lifecycle.dispose();}
});
