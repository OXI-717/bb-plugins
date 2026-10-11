import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createFakePluginHost, makeHostResponse, makeThreadResponse, makeMessageDispatchHookContext } from '@get-bb/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import plugin from './server.js';

type PluginList = Awaited<ReturnType<BbPluginApi['sdk']['plugins']['list']>>;
async function setup(options:{failDisable?:boolean;failCodexDisable?:boolean}={}) {
  const states=new Map([['host-a','disconnected'],['host-b','connected']]);
  const available=new Set(['host-a','host-b']);
  const enabled=new Map([['provider-codex',true],['provider-claude-code',false],['provider-acp',true]]);
  const stopped:string[]=[];
  const hostCalls:string[]=[];
  const mutations:string[]=[];
  let failListRunning=false;
  let failHostList=false;
  let pausedRpc:{hostId:string;entered:()=>void;release:Promise<void>}|null=null;
  let pausedDisable:{entered:()=>void;release:Promise<void>}|null=null;
  const fake=createFakePluginHost({
    pluginId:'vpn-guard',
    sdk:{
      hosts:{list:async()=>{if(failHostList) throw Error('host list unavailable');return [...available].map(id=>makeHostResponse({id,name:id}));}},
      plugins:{
        list:async()=>({plugins:[...enabled].map(([id,value])=>({id,enabled:value}))}) as PluginList,
        disable:async({pluginId})=>{if(pluginId==='provider-codex'&&pausedDisable){const pause=pausedDisable;pausedDisable=null;pause.entered();await pause.release;}if(options.failDisable||(options.failCodexDisable&&pluginId==='provider-codex')) throw Error('interrupted');enabled.set(pluginId,false);mutations.push(`disable:${pluginId}`);return {} as never;},
        enable:async({pluginId})=>{enabled.set(pluginId,true);mutations.push(`enable:${pluginId}`);return {} as never;},
      },
      threads:{
        listRunning:async()=>{if(failListRunning) throw Error('thread list unavailable');return [{id:'protected',hostId:'host-a'},{id:'chinese',hostId:'host-a'},{id:'healthy',hostId:'host-b'}];},
        get:async({threadId})=>makeThreadResponse({id:threadId,providerId:threadId==='chinese'?'kimi':'codex'}),
        stop:async({threadId})=>{stopped.push(threadId);return {} as never;},
      },
    },
    experimental_callHostRpc:async({hostId})=>{hostCalls.push(hostId);if(!available.has(hostId)) throw Error('host unavailable');if(pausedRpc?.hostId===hostId){const pause=pausedRpc;pausedRpc=null;pause.entered();await pause.release;}return {state:states.get(hostId)??'unknown'};},
  });
  await plugin(fake.bb);
  const hook=fake.harness.registrations.hooks['message.dispatch'];
  if(!hook) throw Error('missing hook');
  const dispatch=(providerId:string,hostId:string|null)=>hook(makeMessageDispatchHookContext({requestedExecution:{providerId},host:hostId?{id:hostId,name:hostId}:null}));
  return {fake,states,available,enabled,stopped,hostCalls,mutations,dispatch,setFailListRunning:(value:boolean)=>{failListRunning=value;},setFailHostList:(value:boolean)=>{failHostList=value;},pauseNextRpc:(pause:{hostId:string;entered:()=>void;release:Promise<void>})=>{pausedRpc=pause;},pauseNextCodexDisable:(pause:{entered:()=>void;release:Promise<void>})=>{pausedDisable=pause;}};
}
const select=async(fake:Awaited<ReturnType<typeof setup>>['fake'],hostIds:string[])=>fake.harness.behavior.callRpc('setHosts',{hostIds});
const mode=async(fake:Awaited<ReturnType<typeof setup>>['fake'],next:'observe'|'enforce')=>fake.harness.behavior.callRpc('setMode',{mode:next});

describe('guard admission and reconciliation',()=>{
  it('requires explicit scope and ignores an offline unrelated host',async()=>{
    const {fake,enabled,stopped,hostCalls,dispatch,states}=await setup();
    await expect(mode(fake,'enforce')).rejects.toThrow();
    await select(fake,['host-b']);
    await mode(fake,'enforce');
    expect(await dispatch('codex','host-a')).toEqual({action:'proceed'});
    expect(await dispatch('codex','host-b')).toEqual({action:'proceed'});
    expect(enabled.get('provider-codex')).toBe(true);
    expect(stopped).toEqual([]);
    expect(hostCalls).not.toContain('host-a');
    states.set('host-b','unknown');
    expect(await dispatch('codex','host-b')).toMatchObject({action:'wait'});
    await fake.harness.lifecycle.dispose();
  });
  it('stops only protected turns on a selected bad host and leaves Chinese ACP available',async()=>{
    const {fake,stopped,enabled,dispatch}=await setup();
    await select(fake,['host-a']);
    await mode(fake,'enforce');
    expect(stopped).toEqual(['protected']);
    expect(enabled.get('provider-codex')).toBe(true);
    expect(enabled.get('provider-acp')).toBe(true);
    expect(await dispatch('acp-cursor','host-a')).toMatchObject({action:'wait'});
    expect(await dispatch('kimi','host-a')).toEqual({action:'proceed'});
    expect(await dispatch('codex','host-b')).toEqual({action:'proceed'});
    await fake.harness.lifecycle.dispose();
  });
  it('keeps a missing selected host unknown without treating other hosts as selected',async()=>{
    const {fake,available,dispatch}=await setup();
    await select(fake,['host-b']);
    available.delete('host-b');
    await mode(fake,'enforce');
    const status=await fake.harness.behavior.callRpc('status',null);
    expect(status).toMatchObject({hosts:expect.arrayContaining([expect.objectContaining({id:'host-b',selected:true,available:false,vpn:'unknown'})])});
    expect(await dispatch('codex','host-b')).toMatchObject({action:'wait'});
    expect(await dispatch('codex','host-a')).toEqual({action:'proceed'});
    await fake.harness.lifecycle.dispose();
  });
  it('requires separate global impact acknowledgment and never disables ACP',async()=>{
    const {fake,enabled,mutations}=await setup();
    await select(fake,['host-a']);
    await expect(fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:false})).rejects.toThrow();
    await fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
    await mode(fake,'enforce');
    expect(mutations).toEqual(['disable:provider-codex']);
    expect(enabled.get('provider-claude-code')).toBe(false);
    expect(enabled.get('provider-acp')).toBe(true);
    await fake.harness.lifecycle.dispose();
  });
  it('persists plugin ownership across restart and restores only after an explicit action',async()=>{
    const {fake,states,enabled,mutations}=await setup();
    await select(fake,['host-a']);
    await fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
    await mode(fake,'enforce');
    const reloaded=await fake.harness.lifecycle.reload(plugin);
    states.set('host-a','connected');
    await reloaded.harness.behavior.callRpc('setMode',{mode:'enforce'});
    expect(enabled.get('provider-codex')).toBe(false);
    expect(await reloaded.harness.behavior.callRpc('status',null)).toMatchObject({ownedDisabledPlugins:['provider-codex']});
    await reloaded.harness.behavior.callRpc('restoreOwned',null);
    expect(enabled.get('provider-codex')).toBe(true);
    expect(enabled.get('provider-claude-code')).toBe(false);
    expect(mutations).toEqual(['disable:provider-codex','enable:provider-codex']);
    await reloaded.harness.lifecycle.dispose();
  });
  it('reapplies an externally enabled owned plugin while the selected host is blocked',async()=>{
    const {fake,enabled,mutations}=await setup();
    await select(fake,['host-a']);
    await fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
    await mode(fake,'enforce');
    enabled.set('provider-codex',true);
    await mode(fake,'enforce');
    expect(enabled.get('provider-codex')).toBe(false);
    expect(mutations).toEqual(['disable:provider-codex','disable:provider-codex']);
    await fake.harness.lifecycle.dispose();
  });
  it('does not claim ownership if native plugin disable is interrupted',async()=>{
    const {fake,enabled,states}=await setup({failDisable:true});
    await select(fake,['host-a']);
    await fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
    await expect(mode(fake,'enforce')).rejects.toThrow('interrupted');
    expect(enabled.get('provider-codex')).toBe(true);
    const reloaded=await fake.harness.lifecycle.reload(plugin);
    const status=await reloaded.harness.behavior.callRpc('status',null);
    expect(status).toMatchObject({ownedDisabledPlugins:[],ambiguousPluginChanges:['provider-codex']});
    states.set('host-a','connected');
    await reloaded.harness.behavior.callRpc('restoreOwned',null);
    expect(enabled.get('provider-codex')).toBe(true);
    await reloaded.harness.lifecycle.dispose();
  });
  it('rechecks queued work after mode changes',async()=>{
    const {fake}=await setup();
    await select(fake,['host-a']);
    await mode(fake,'enforce');
    const before=fake.harness.recheckCount;
    await mode(fake,'observe');
    expect(fake.harness.recheckCount).toBeGreaterThan(before);
    await fake.harness.lifecycle.dispose();
  });
  it('serializes concurrent RPC mode writes and their KV persistence',async()=>{
    const {fake}=await setup();
    await select(fake,['host-a']);
    const original=fake.bb.storage.kv.set.bind(fake.bb.storage.kv);
    let release!:()=>void;
    const stalled=new Promise<void>(resolve=>{release=resolve;});
    let first=true;
    fake.bb.storage.kv.set=async(key,value)=>{
      if(key==='configuration-v2' && first){first=false;await stalled;}
      return original(key,value);
    };
    const enforcing=mode(fake,'enforce');
    await Promise.resolve();
    const observing=mode(fake,'observe');
    release();
    await Promise.all([enforcing,observing]);
    expect(await fake.harness.behavior.callRpc('status',null)).toMatchObject({mode:'observe'});
    expect(await fake.bb.storage.kv.get('configuration-v2')).toMatchObject({mode:'observe'});
    await fake.harness.lifecycle.dispose();
  });
  it('serializes CLI and RPC changes through a delayed journal write',async()=>{
    const {fake,enabled,states}=await setup();
    await select(fake,['host-a']);
    await fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
    const original=fake.bb.storage.kv.set.bind(fake.bb.storage.kv);
    let release!:()=>void;
    const stalled=new Promise<void>(resolve=>{release=resolve;});
    let first=true;
    fake.bb.storage.kv.set=async(key,value)=>{
      if(key==='pending-native-plugin-changes-v2' && first){first=false;await stalled;}
      return original(key,value);
    };
    const enforcing=fake.harness.behavior.runCli(['enforce']);
    await Promise.resolve();
    const observing=mode(fake,'observe');
    release();
    expect((await enforcing).exitCode).toBe(0);
    await observing;
    expect(enabled.get('provider-codex')).toBe(false);
    expect(await fake.harness.behavior.callRpc('status',null)).toMatchObject({mode:'observe',ownedDisabledPlugins:['provider-codex'],ambiguousPluginChanges:[]});
    expect(await fake.bb.storage.kv.get('configuration-v2')).toMatchObject({mode:'observe'});
    states.set('host-a','connected');
    await fake.harness.lifecycle.dispose();
  });
  it('rechecks ownership after an asynchronous host decision',async()=>{
    const {fake,dispatch,pauseNextRpc,enabled}=await setup();
    await select(fake,['host-b']);
    await fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
    await mode(fake,'enforce');
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    let release!:()=>void;const stalled=new Promise<void>(resolve=>{release=resolve;});
    pauseNextRpc({hostId:'host-b',entered,release:stalled});
    const sending=dispatch('codex','host-b');
    await started;
    await select(fake,['host-a','host-b']);
    expect(enabled.get('provider-codex')).toBe(false);
    release();
    expect(await sending).toMatchObject({action:'wait'});
    await fake.harness.lifecycle.dispose();
  });
  it('holds a healthy-host dispatch while native disable is still pending',async()=>{
    const {fake,dispatch,pauseNextRpc,pauseNextCodexDisable,enabled}=await setup();
    await select(fake,['host-b']);
    await fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
    await mode(fake,'enforce');
    let enteredRpc!:()=>void;const rpcStarted=new Promise<void>(resolve=>{enteredRpc=resolve;});
    let releaseRpc!:()=>void;const stalledRpc=new Promise<void>(resolve=>{releaseRpc=resolve;});
    pauseNextRpc({hostId:'host-b',entered:enteredRpc,release:stalledRpc});
    const sending=dispatch('codex','host-b');
    await rpcStarted;
    let enteredDisable!:()=>void;const disableStarted=new Promise<void>(resolve=>{enteredDisable=resolve;});
    let releaseDisable!:()=>void;const stalledDisable=new Promise<void>(resolve=>{releaseDisable=resolve;});
    pauseNextCodexDisable({entered:enteredDisable,release:stalledDisable});
    const selecting=select(fake,['host-a','host-b']);
    await disableStarted;
    expect(enabled.get('provider-codex')).toBe(true);
    releaseRpc();
    expect(await sending).toMatchObject({action:'wait'});
    releaseDisable();await selecting;
    await fake.harness.lifecycle.dispose();
  });
  it('attempts native suspension when listing running threads fails',async()=>{
    const {fake,enabled,setFailListRunning}=await setup();
    await select(fake,['host-a']);
    await fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
    setFailListRunning(true);
    await expect(mode(fake,'enforce')).rejects.toThrow('thread list unavailable');
    expect(enabled.get('provider-codex')).toBe(false);
    await fake.harness.lifecycle.dispose();
  });
  it('treats a failed host catalog as unknown for selected machines',async()=>{
    const {fake,setFailHostList,enabled,dispatch}=await setup();
    await select(fake,['host-b']);
    await fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
    setFailHostList(true);
    await mode(fake,'enforce');
    expect(enabled.get('provider-codex')).toBe(false);
    expect(await dispatch('acp-cursor','host-b')).toMatchObject({action:'wait'});
    await fake.harness.lifecycle.dispose();
  });
  it('attempts Claude and thread cleanup when Codex suspension fails',async()=>{
    const {fake,enabled,stopped,mutations}=await setup({failCodexDisable:true});
    enabled.set('provider-claude-code',true);
    await select(fake,['host-a']);
    await fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
    await expect(mode(fake,'enforce')).rejects.toThrow('interrupted');
    expect(enabled.get('provider-claude-code')).toBe(false);
    expect(mutations).toContain('disable:provider-claude-code');
    expect(stopped).toContain('protected');
    await fake.harness.lifecycle.dispose();
  });
  it('reports independent suspension and thread-list failures together',async()=>{
    const {fake,enabled,setFailListRunning}=await setup({failCodexDisable:true});
    enabled.set('provider-claude-code',true);
    await select(fake,['host-a']);
    await fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
    setFailListRunning(true);
    await expect(mode(fake,'enforce')).rejects.toThrow(/provider-codex.*threads\.listRunning/);
    expect(enabled.get('provider-claude-code')).toBe(false);
    await fake.harness.lifecycle.dispose();
  });
  it('retries a host-state recheck after a transient recheck failure',async()=>{
    const {fake,states}=await setup();
    await select(fake,['host-a']);
    await mode(fake,'enforce');
    states.set('host-a','connected');
    const original=fake.bb.experimental_hooks.recheck.bind(fake.bb.experimental_hooks);
    let failed!:()=>void;const attempted=new Promise<void>(resolve=>{failed=resolve;});
    let once=true;
    fake.bb.experimental_hooks.recheck=async hook=>{
      if(once){once=false;failed();throw Error('wake failed');}
      return original(hook);
    };
    const first=fake.harness.behavior.runService('reconcile');
    await attempted;first.controller.abort();await first.done;
    const before=fake.harness.recheckCount;
    const second=fake.harness.behavior.runService('reconcile');
    await Promise.resolve();second.controller.abort();await second.done;
    expect(fake.harness.recheckCount).toBeGreaterThan(before);
    await fake.harness.lifecycle.dispose();
  });
  it('retries a failed policy-only wake after switching to Observe',async()=>{
    const {fake}=await setup();
    await select(fake,['host-a']);
    await mode(fake,'enforce');
    const original=fake.bb.experimental_hooks.recheck.bind(fake.bb.experimental_hooks);
    let once=true;
    fake.bb.experimental_hooks.recheck=async hook=>{
      if(once){once=false;throw Error('wake failed');}
      return original(hook);
    };
    await expect(mode(fake,'observe')).rejects.toThrow('wake failed');
    const before=fake.harness.recheckCount;
    const retry=fake.harness.behavior.runService('reconcile');
    await Promise.resolve();retry.controller.abort();await retry.done;
    expect(fake.harness.recheckCount).toBeGreaterThan(before);
    await fake.harness.lifecycle.dispose();
  });
  it('acknowledges a reviewed ambiguous entry without enabling any plugin',async()=>{
    const {fake,enabled,dispatch}=await setup({failDisable:true});
    await select(fake,['host-a']);
    await fake.harness.behavior.callRpc('setGlobalSuspension',{enabled:true,acknowledgeGlobalImpact:true});
    await expect(mode(fake,'enforce')).rejects.toThrow();
    expect(await dispatch('codex','host-b')).toMatchObject({action:'wait'});
    await expect(fake.harness.behavior.callRpc('acknowledgeAmbiguous',{pluginId:'provider-codex',acknowledgeReviewed:false})).rejects.toThrow();
    const beforeAck=fake.harness.recheckCount;
    await fake.harness.behavior.callRpc('acknowledgeAmbiguous',{pluginId:'provider-codex',acknowledgeReviewed:true});
    const afterAck=fake.harness.recheckCount;
    expect(afterAck).toBeGreaterThan(beforeAck);
    expect(await dispatch('codex','host-b')).toEqual({action:'proceed'});
    expect(enabled.get('provider-codex')).toBe(true);
    expect(await fake.bb.storage.kv.get('pending-native-plugin-changes-v2')).toEqual([]);
    expect(await fake.harness.behavior.callRpc('status',null)).toMatchObject({ambiguousPluginChanges:[]});
    await expect(mode(fake,'enforce')).rejects.toThrow();
    const cleared=await fake.harness.behavior.runCli(['acknowledge-ambiguous','provider-codex','--reviewed']);
    expect(cleared.exitCode).toBe(0);
    expect(fake.harness.recheckCount).toBeGreaterThan(afterAck);
    expect(enabled.get('provider-codex')).toBe(true);
    expect(await fake.bb.storage.kv.get('pending-native-plugin-changes-v2')).toEqual([]);
    const reloaded=await fake.harness.lifecycle.reload(plugin);
    expect(await reloaded.harness.behavior.callRpc('status',null)).toMatchObject({ambiguousPluginChanges:[]});
    await reloaded.harness.lifecycle.dispose();
  });
  it('lets a removed selected machine be taken out of scope while another remains missing',async()=>{
    const {fake,available,setFailHostList}=await setup();
    await select(fake,['host-a','host-b']);
    available.delete('host-a');
    setFailHostList(true);
    await select(fake,['host-a']);
    expect(await fake.harness.behavior.callRpc('status',null)).toMatchObject({hostIds:['host-a']});
    await select(fake,[]);
    expect(await fake.harness.behavior.callRpc('status',null)).toMatchObject({hostIds:[]});
    setFailHostList(false);
    await expect(select(fake,['host-a'])).rejects.toThrow('newly selected');
    await fake.harness.lifecycle.dispose();
  });
});
