import {verifiedHostResult} from './vpn-test-fixture.js';
import {expect,it} from 'vitest';
import {createFakePluginHost,makeHostResponse} from '@get-bb/plugin-sdk/testing';
import plugin from './server.js';
import {statusSchema} from './contract.js';

it('retains ownership and retries when release leaves its hold active',async()=>{
 let owner='';let releases=0;
 const fake=createFakePluginHost({pluginId:'vpn-guard',sdk:{system:{config:async()=>({primaryHostId:'host-a'}) as never},hosts:{list:async()=>[makeHostResponse({id:'host-a'})]},threads:{listRunning:async()=>[]}},experimental_callHostRpc:async({method,input})=>{
  if(method==='readState')return verifiedHostResult('connected');
  const args=input as {action:string;instanceId:string};
  if(args.action==='hold')owner='vpn-guard:'+args.instanceId;
  if(args.action==='release')releases++;
  return {schema:'oxi-auto/protection-status/1',blocked:true,holds:owner?[{owner,reason:'Protection'}]:[],recoveryPending:true,pausedCount:0,activeRuns:[],errors:args.action==='release'?['Release incomplete']:[],legacyBlocked:false};
 }});
 await plugin(fake.bb);
 await fake.harness.behavior.callRpc('setHosts',{hostIds:['host-a']});
 await fake.harness.behavior.callRpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});
 await fake.harness.behavior.callRpc('setManualBlock',{blocked:true});
 await expect(fake.harness.behavior.callRpc('setManualBlock',{blocked:false})).rejects.toThrow();
 expect(statusSchema.parse(await fake.harness.behavior.callRpc('status',null)).automations.held).toBe(true);
 await expect(fake.harness.behavior.callRpc('setManualBlock',{blocked:false})).rejects.toThrow();
 expect(releases).toBe(2);
});

it('requires both host proof and strict pool transport under verified enforcement',async()=>{
 let poolPolicyVersion=1;
 let verified=true;
 const fake=createFakePluginHost({pluginId:'vpn-guard',sdk:{hosts:{list:async()=>[makeHostResponse({id:'host-a'})]},threads:{listRunning:async()=>[]},plugins:{callRpc:async()=>({vpnGuardEnabled:true,vpnPolicyVersion:poolPolicyVersion,vpnOnlyProviders:['codex']}) as never}},experimental_callHostRpc:async()=>({state:'connected',evidence:{state:'connected',assurance:verified?'verified_ipv4':'unverified',reason:'ok',updatedAt:Date.now(),probeAt:Date.now()}})});
 await plugin(fake.bb);
 await fake.harness.behavior.callRpc('setHosts',{hostIds:['host-a']});
 await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
 const decision=()=>fake.harness.behavior.callRpc('networkDecision',{hostId:'host-a',provider:'codex'});
 expect(await decision()).toMatchObject({allowed:false});
 poolPolicyVersion=2;
 expect(await decision()).toMatchObject({allowed:true});
 verified=false;
 expect(await decision()).toMatchObject({allowed:false});
});

it('coordinates a manual block, preserves external pause and does not auto-resume',async()=>{
 const actions:string[]=[];
 const controller={schema:'oxi-auto/protection-status/1' as const,blocked:false,holds:[] as {owner:string;reason:string}[],recoveryPending:false,pausedCount:0,activeRuns:[],errors:[],legacyBlocked:false};
 const fake=createFakePluginHost({pluginId:'vpn-guard',sdk:{system:{config:async()=>({primaryHostId:'host-a'}) as never},hosts:{list:async()=>[makeHostResponse({id:'host-a'})]},threads:{listRunning:async()=>[]}},experimental_callHostRpc:async({method,input})=>{
  if(method==='readState')return verifiedHostResult('connected');
  const args=input as {action:string;instanceId:string};actions.push(args.action);
  if(args.action==='hold'){controller.holds.push({owner:'vpn-guard:'+args.instanceId,reason:'Protection'});controller.blocked=true;controller.pausedCount=1;}
  if(args.action==='release'){controller.holds=controller.holds.filter(h=>!h.owner.startsWith('vpn-guard:'));controller.recoveryPending=true;controller.blocked=true;}
  if(args.action==='pause'){controller.holds.push({owner:'manual',reason:'Raycast'});controller.blocked=true;}
  return {...controller};
 }});
 await plugin(fake.bb);
 await fake.harness.behavior.callRpc('setHosts',{hostIds:['host-a']});
 await fake.harness.behavior.callRpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});
 await fake.harness.behavior.callRpc('setManualBlock',{blocked:true});
 expect(actions).toContain('hold');
 await fake.harness.behavior.callRpc('setManualBlock',{blocked:false});
 const status=statusSchema.parse(await fake.harness.behavior.callRpc('status',null));
 expect(status.automations.status).toMatchObject({recoveryPending:true,pausedCount:1});
 expect(actions).not.toContain('resume');
 await fake.harness.behavior.callRpc('automationAction',{action:'pause',reviewed:false});
 expect(controller.holds.some(h=>h.owner==='manual')).toBe(true);
});

it('strict mode rejects an old host response and controller failures remain visible',async()=>{
 const fake=createFakePluginHost({pluginId:'vpn-guard',sdk:{system:{config:async()=>({primaryHostId:'host-a'}) as never},hosts:{list:async()=>[makeHostResponse({id:'host-a'})]},threads:{listRunning:async()=>[]}},experimental_callHostRpc:async({method})=>{
  if(method==='readState')return {state:'connected'};
  throw Error('Controller offline');
 }});
 await plugin(fake.bb);
 await fake.harness.behavior.callRpc('setHosts',{hostIds:['host-a']});
 await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
 expect(await fake.harness.behavior.callRpc('networkDecision',{hostId:'host-a',provider:'codex'})).toMatchObject({allowed:false});
 await expect(fake.harness.behavior.callRpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'})).rejects.toThrow();
 expect(statusSchema.parse(await fake.harness.behavior.callRpc('status',null)).automations.error).toContain('offline');
 expect(statusSchema.parse(await fake.harness.behavior.callRpc('status',null)).coordinateAutomations).toBe(true);
});
