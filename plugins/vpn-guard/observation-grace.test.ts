import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createFakePluginHost,makeHostResponse,makeMessageDispatchHookContext,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import plugin from './server.js';
import {statusSchema} from './contract.js';
import {OBSERVATION_GRACE_MS} from './observation.js';
import {verifiedHostResult} from './vpn-test-fixture.js';

type State='connected'|'disconnected'|'unknown';
async function setup() {
  const vpn=new Map<string,State>([['host-a','connected'],['vm','connected']]);
  const failing=new Set<string>();
  const service=new Map<string,'connected'|'disconnected'>();
  const native=new Map([['provider-codex',true],['provider-claude-code',false]]);
  const running=[{id:'turn-a',hostId:'host-a'},{id:'kimi-a',hostId:'host-a'},{id:'turn-vm',hostId:'vm'}];
  const stopped:string[]=[];
  const actions:string[]=[];
  let listFails=false;let owner='';
  const report=()=>({schema:'oxi-auto/protection-status/1',blocked:!!owner,holds:owner?[{owner,reason:'Guard'}]:[],recoveryPending:false,pausedCount:0,activeRuns:[],errors:[],legacyBlocked:false,restoreRevision:'a'.repeat(64)});
  const fake=createFakePluginHost({pluginId:'vpn-guard',sdk:{
    hosts:{list:async()=>{if(listFails)throw Error('synthetic catalog outage');return ['host-a','vm'].map(id=>makeHostResponse({id,name:id,status:service.get(id)??'connected'}));}},
    system:{config:async()=>({primaryHostId:'host-a'}) as never},
    plugins:{
      list:async()=>({plugins:[...native].map(([id,enabled])=>({id,enabled}))}) as never,
      disable:async({pluginId})=>{native.set(pluginId,false);return {} as never;},
      enable:async({pluginId})=>{native.set(pluginId,true);return {} as never;},
      callRpc:async()=>({vpnGuardEnabled:true,vpnPolicyVersion:2,vpnOnlyProviders:['codex','claude','cursor','devin']}) as never,
    },
    threads:{
      events:{list:async()=>[] as never},
      listRunning:async()=>running.filter(r=>!stopped.includes(r.id)),
      get:async({threadId})=>makeThreadResponse({id:threadId,providerId:threadId.startsWith('kimi')?'kimi':'codex'}),
      stop:async({threadId})=>{stopped.push(threadId);return {} as never;},
    },
  },experimental_callHostRpc:async({hostId,method,input})=>{
    if(method==='automation') {
      const args=input as {action:string;instanceId:string};actions.push(args.action);
      if(args.action==='hold')owner=`vpn-guard:${args.instanceId}`;
      if(args.action==='release')owner='';
      return report();
    }
    if(failing.has(hostId))throw Object.assign(Error('Host is not connected'),{code:'host_unavailable'});
    return verifiedHostResult(vpn.get(hostId)??'unknown');
  }});
  await plugin(fake.bb);
  const rpc=fake.harness.behavior.callRpc;
  const dispatch=(hostId:string)=>fake.harness.registrations.hooks['message.dispatch']!(makeMessageDispatchHookContext({requestedExecution:{providerId:'codex'},host:{id:hostId,name:hostId}}));
  /** One periodic reconciliation through the real service loop. */
  const cycle=async()=>{const run=fake.harness.behavior.runService('reconcile');await Promise.resolve();run.controller.abort();await run.done;};
  const status=async()=>statusSchema.parse(await rpc('status',null));
  const advance=(ms:number)=>vi.setSystemTime(Date.now()+ms);
  await rpc('setHosts',{hostIds:['host-a','vm']});
  return {fake,rpc,vpn,failing,service,native,running,stopped,actions,dispatch,cycle,status,advance,setListFails:(value:boolean)=>{listFails=value;}};
}
const enforce=(s:Awaited<ReturnType<typeof setup>>)=>s.rpc('setMode',{mode:'enforce'});
const rpcWarnings=(s:Awaited<ReturnType<typeof setup>>)=>s.fake.harness.logEntries.filter(e=>e.level==='warn'&&e.message.includes('status RPC failed'));

beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});});
afterEach(()=>{vi.useRealTimers();});

describe('observation grace for running work',()=>{
  it('keeps running threads through a failed read and stops them after continuous unobservability',async()=>{
    const s=await setup();
    try {
      await enforce(s);
      s.failing.add('host-a');
      await enforce(s);await s.cycle();
      expect(s.stopped).toEqual([]);
      expect((await s.status()).events.filter(e=>e.kind==='vpn_blocked')).toEqual([]);
      s.advance(OBSERVATION_GRACE_MS-1_000);await s.cycle();
      expect(s.stopped).toEqual([]);
      s.advance(2_000);await s.cycle();
      expect(s.stopped).toEqual(['turn-a']);
      const after=await s.status();
      expect(after.stopHistory?.at(-1)).toMatchObject({threadId:'turn-a',hostId:'host-a',reason:'host_rpc_failed'});
      expect(after.events.filter(e=>e.kind==='vpn_blocked')).toEqual([expect.objectContaining({hostId:'host-a',reason:'host_rpc_failed'})]);
    } finally {await s.fake.harness.lifecycle.dispose();}
  });
  it('restarts the grace period after one successful read',async()=>{
    const s=await setup();
    try {
      await enforce(s);
      s.failing.add('host-a');await s.cycle();
      s.advance(60_000);s.failing.delete('host-a');await s.cycle();
      s.advance(60_000);s.failing.add('host-a');await s.cycle();
      s.advance(60_000);await s.cycle();
      expect(s.stopped).toEqual([]);
      s.advance(31_000);await s.cycle();
      expect(s.stopped).toEqual(['turn-a']);
    } finally {await s.fake.harness.lifecycle.dispose();}
  });
  it.each(['message.dispatch','networkDecisionV2'])('restarts grace after successful admission via %s',async method=>{
    const s=await setup();
    try {
      await enforce(s);
      s.failing.add('host-a');await s.cycle();
      s.advance(60_000);s.failing.delete('host-a');
      if(method==='message.dispatch')expect(await s.dispatch('host-a')).toEqual({action:'proceed'});
      else expect(await s.rpc(method,{hostId:'host-a',provider:'codex'})).toMatchObject({allowed:true});
      s.advance(10_000);s.failing.add('host-a');await s.cycle();
      s.advance(30_000);await s.cycle();
      // The original outage is over 90 seconds old; the new one is only 30 seconds old.
      expect(s.stopped).toEqual([]);
      s.advance(60_000);await s.cycle();
      expect(s.stopped).toEqual([]);
      s.advance(1);await s.cycle();
      expect(s.stopped).toEqual(['turn-a']);
    } finally {await s.fake.harness.lifecycle.dispose();}
  });
  it.each(['message.dispatch','networkDecisionV2'])('starts unobservability at failed admission via %s',async method=>{
    const s=await setup();
    try {
      await enforce(s);
      s.advance(1_000);s.failing.add('host-a');
      if(method==='message.dispatch')expect(await s.dispatch('host-a')).toMatchObject({action:'wait'});
      else expect(await s.rpc(method,{hostId:'host-a',provider:'codex'})).toMatchObject({allowed:false});
      s.advance(60_000);await s.cycle();
      expect(s.stopped).toEqual([]);
      s.advance(30_001);await s.cycle();
      expect(s.stopped).toEqual(['turn-a']);
    } finally {await s.fake.harness.lifecycle.dispose();}
  });
  it('stops immediately on not-connected evidence, which stays effective during the grace period',async()=>{
    const s=await setup();
    try {
      await enforce(s);
      s.failing.add('host-a');await s.cycle();
      s.failing.delete('host-a');s.vpn.set('host-a','disconnected');await s.cycle();
      expect(s.stopped).toEqual(['turn-a']);
      expect((await s.status()).stopHistory?.at(-1)?.reason).toBe('probe_failed');
      // A turn that bypassed admission while the machine is briefly unreachable.
      s.running.push({id:'turn-a2',hostId:'host-a'});
      s.failing.add('host-a');await s.cycle();
      expect(s.stopped).toEqual(['turn-a','turn-a2']);
      expect((await s.status()).stopHistory?.at(-1)).toMatchObject({threadId:'turn-a2',reason:'probe_failed'});
    } finally {await s.fake.harness.lifecycle.dispose();}
  });
  it('applies a manual machine block immediately while the machine is unobservable',async()=>{
    const s=await setup();
    try {
      s.failing.add('host-a');
      await enforce(s);
      expect(s.stopped).toEqual([]);
      await s.rpc('setHostManualBlock',{hostId:'host-a',blocked:true});
      expect(s.stopped).toEqual(['turn-a']);
      expect((await s.status()).stopHistory?.at(-1)?.reason).toBe('manual_block');
    } finally {await s.fake.harness.lifecycle.dispose();}
  });
  it('counts the grace period from the first failed read when no evidence exists since start',async()=>{
    const s=await setup();
    await enforce(s);
    s.failing.add('host-a');
    // Restart drops in-memory evidence: the connected read before reload no longer counts.
    const reloaded=await s.fake.harness.lifecycle.reload(plugin);
    try {
      const read=async()=>statusSchema.parse(await reloaded.harness.behavior.callRpc('status',null)).hosts.find(h=>h.id==='host-a');
      const started=Date.now();
      await reloaded.harness.behavior.callRpc('setMode',{mode:'enforce'});
      expect(await read()).toMatchObject({vpn:'unknown',lastEvidenceAt:null,unobservedSince:started});
      expect(s.stopped).toEqual([]);
      s.advance(OBSERVATION_GRACE_MS+1);
      await reloaded.harness.behavior.callRpc('setMode',{mode:'enforce'});
      expect(s.stopped).toEqual(['turn-a']);
    } finally {await reloaded.harness.lifecycle.dispose();}
  });
  it('never stops direct-machine threads for catalog or service failures, but honours its manual block',async()=>{
    const s=await setup();
    try {
      await s.rpc('setDirectHosts',{hostIds:['vm']});
      await enforce(s);
      s.service.set('vm','disconnected');
      s.advance(OBSERVATION_GRACE_MS+1);await s.cycle();
      s.advance(OBSERVATION_GRACE_MS+1);await s.cycle();
      expect(s.stopped).toEqual([]);
      s.service.delete('vm');s.setListFails(true);
      await s.cycle();
      expect(await s.dispatch('vm')).toMatchObject({action:'wait'});
      s.advance(OBSERVATION_GRACE_MS+1);await s.cycle();
      // The VPN machine loses its catalog entry too and is stopped after the same grace.
      expect(s.stopped).toEqual(['turn-a']);
      expect((await s.status()).stopHistory?.at(-1)).toMatchObject({hostId:'host-a',reason:'host_catalog_unavailable'});
      s.setListFails(false);
      await s.rpc('setHostManualBlock',{hostId:'vm',blocked:true});
      expect(s.stopped).toEqual(['turn-a','turn-vm']);
      expect((await s.status()).stopHistory?.at(-1)).toMatchObject({hostId:'vm',reason:'manual_block'});
    } finally {await s.fake.harness.lifecycle.dispose();}
  });
});

describe('admission stays fail-closed',()=>{
  it('holds new turns and Pooler decisions on the first failed read',async()=>{
    const s=await setup();
    try {
      await enforce(s);
      expect(await s.dispatch('host-a')).toEqual({action:'proceed'});
      s.failing.add('host-a');
      expect(await s.dispatch('host-a')).toMatchObject({action:'wait'});
      for(const method of ['networkDecision','networkDecisionV2'])
        expect(await s.rpc(method,{hostId:'host-a',provider:'codex'})).toMatchObject({allowed:false,reason:'vpn_unavailable'});
      expect(s.stopped).toEqual([]);
    } finally {await s.fake.harness.lifecycle.dispose();}
  });
});

describe('native plugins and automation holds use the same grace',()=>{
  it('suspends native plugins only after continuous unobservability',async()=>{
    const s=await setup();
    try {
      await s.rpc('setHosts',{hostIds:['host-a']});
      await s.rpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
      await enforce(s);
      s.failing.add('host-a');await s.cycle();
      expect(s.native.get('provider-codex')).toBe(true);
      s.advance(OBSERVATION_GRACE_MS+1);await s.cycle();
      expect(s.native.get('provider-codex')).toBe(false);
      // Recovery still needs a live connected read.
      s.failing.delete('host-a');await s.cycle();
      expect(s.native.get('provider-codex')).toBe(true);
    } finally {await s.fake.harness.lifecycle.dispose();}
  });
  it('places an automation hold only after continuous unobservability',async()=>{
    const s=await setup();
    const settled=async()=>vi.waitFor(async()=>{const v=await s.status();expect(v.automations.busy).toBe(false);expect(v.automations.needsReconcile).toBe(false);});
    try {
      await enforce(s);
      await s.rpc('setAutomationCoordination',{enabled:true,executable:'/controller/synthetic'});
      await settled();
      s.failing.add('host-a');await s.cycle();await settled();
      expect(s.actions).not.toContain('hold');
      s.advance(OBSERVATION_GRACE_MS+1);await s.cycle();await settled();
      expect(s.actions).toContain('hold');
      expect((await s.status()).automations.held).toBe(true);
    } finally {await s.fake.harness.lifecycle.dispose();}
  });
});

describe('diagnostics',()=>{
  it('logs an unreachable machine once per state change, not on every cycle',async()=>{
    const s=await setup();
    try {
      await enforce(s);
      s.failing.add('host-a');
      for(let i=0;i<4;i++){s.advance(5_000);await s.cycle();}
      expect(rpcWarnings(s)).toHaveLength(1);
      expect(rpcWarnings(s)[0]!.message).toContain('host_unavailable');
      s.failing.delete('host-a');await s.cycle();await s.cycle();
      expect(s.fake.harness.logEntries.filter(e=>e.message.includes('status RPC recovered'))).toHaveLength(1);
      s.failing.add('host-a');await s.cycle();await s.cycle();
      expect(rpcWarnings(s)).toHaveLength(2);
    } finally {await s.fake.harness.lifecycle.dispose();}
  });
  it('reports observation times for selected machines and still accepts older status',async()=>{
    const s=await setup();
    try {
      await s.rpc('setHosts',{hostIds:['host-a']});
      const seen=Date.now();
      s.advance(10_000);s.failing.add('host-a');
      const raw=await s.rpc('status',null) as {hosts:Record<string,unknown>[]};
      const failedAt=Date.now();
      expect(raw.hosts.find(h=>h.id==='host-a')).toMatchObject({lastEvidenceAt:seen,unobservedSince:failedAt,vpn:'unknown',rpc:{category:'host_unavailable'}});
      expect(raw.hosts.find(h=>h.id==='vm')).not.toHaveProperty('lastEvidenceAt');
      expect(raw.hosts.find(h=>h.id==='vm')).not.toHaveProperty('unobservedSince');
      expect(statusSchema.safeParse(raw).success).toBe(true);
      const older={...raw,hosts:raw.hosts.map(({lastEvidenceAt:_a,unobservedSince:_b,...host})=>host)};
      expect(statusSchema.safeParse(older).success).toBe(true);
      s.failing.delete('host-a');
      expect((await s.status()).hosts.find(h=>h.id==='host-a')).toMatchObject({lastEvidenceAt:failedAt,unobservedSince:null,vpn:'connected'});
    } finally {await s.fake.harness.lifecycle.dispose();}
  });
});
