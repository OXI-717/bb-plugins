import {expect,it,vi} from 'vitest';
import {createFakePluginHost,makeHostResponse} from '@get-bb/plugin-sdk/testing';
import plugin from './server.js';
import {verifiedHostResult} from './vpn-test-fixture.js';

async function setup(options:{holds?:{owner:string;reason:string}[];legacy?:boolean;revision?:string|null;connected?:boolean}={}) {
 const calls:{action:string;reviewed:boolean;restoreRevision:string|null}[]=[];
 let connected=options.connected??true;
 const report={schema:'oxi-auto/protection-status/1',blocked:true,holds:options.holds??[],recoveryPending:true,pausedCount:1,activeRuns:[],errors:[],legacyBlocked:options.legacy??false,restoreRevision:options.revision===undefined?'a'.repeat(64):options.revision};
 const fake=createFakePluginHost({pluginId:'vpn-guard',sdk:{system:{config:async()=>({primaryHostId:'host-a'}) as never},hosts:{list:async()=>[makeHostResponse({id:'host-a'})]},threads:{listRunning:async()=>[]}},experimental_callHostRpc:async({method,input})=>{
  if(method==='readState')return verifiedHostResult(connected?'connected':'disconnected');
  const args=input as typeof calls[number]&{instanceId:string};calls.push(args);
  if(args.action==='hold')report.holds=[...report.holds.filter(h=>h.owner!=='vpn-guard:'+args.instanceId),{owner:'vpn-guard:'+args.instanceId,reason:'VPN'}];
  if(args.action==='release'){report.holds=report.holds.filter(h=>h.owner!=='vpn-guard:'+args.instanceId);report.restoreRevision='b'.repeat(64);}
  if(args.action==='resume'){report.blocked=false;report.recoveryPending=false;report.pausedCount=0;}
  return {...report,holds:[...report.holds]};
 }});
 await plugin(fake.bb);
 await fake.harness.behavior.callRpc('setHosts',{hostIds:['host-a']});
 await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
 async function settled(){let result:any;await vi.waitFor(async()=>{result=await fake.harness.behavior.callRpc('status',null);expect(result.automations.busy).toBe(false);expect(result.automations.error!==null||!result.automations.needsReconcile).toBe(true);});return result;}
 return {fake,calls,report,settled,setConnected:(value:boolean)=>{connected=value;},connect:async()=>{await fake.harness.behavior.callRpc('setAutomationCoordination',{enabled:true,executable:'/controller/oxi-auto'});return settled();}};
}

it('recovers existing pending schedules with fresh revision and no operator checkbox',async()=>{
 const {connect,calls}=await setup();await connect();
 expect(calls).toContainEqual(expect.objectContaining({action:'resume',reviewed:true,restoreRevision:'a'.repeat(64),schedulesOnly:true}));
});

it('releases its hold and automatically resumes when VPN returns',async()=>{
 const s=await setup({connected:false});await s.connect();
 expect(s.calls.some(c=>c.action==='resume')).toBe(false);
 s.setConnected(true);
 await s.fake.harness.behavior.callRpc('setMode',{mode:'enforce'});await s.settled();
 expect(s.calls).toContainEqual(expect.objectContaining({action:'resume',reviewed:true,restoreRevision:'b'.repeat(64)}));
 expect(s.report.recoveryPending).toBe(false);
});

it.each(['manual','emergency','vpn-guard:other'])('preserves %s hold instead of auto-resuming',async owner=>{
 const s=await setup({holds:[{owner,reason:'External pause'}]});await s.connect();
 expect(s.calls.some(c=>c.action==='resume')).toBe(false);
});

it('preserves legacy lock instead of auto-resuming',async()=>{
 const s=await setup({legacy:true});await s.connect();
 expect(s.calls.some(c=>c.action==='resume')).toBe(false);
});

it('does not resume without a complete recovery snapshot',async()=>{
 const s=await setup({revision:null});const result=await s.connect();expect(result.automations.error).toMatch(/snapshot/i);
 expect(s.calls.some(c=>c.action==='resume')).toBe(false);
});

it('explicit Resume obtains its own revision without asking for review',async()=>{
 const s=await setup({holds:[{owner:'manual',reason:'Explicit pause'}]});await s.connect();
 await s.fake.harness.behavior.callRpc('automationAction',{action:'resume'});
 expect(s.calls).toContainEqual(expect.objectContaining({action:'resume',reviewed:true,restoreRevision:'a'.repeat(64)}));
});
