import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createFakePluginHost, makeHostResponse, makeThreadResponse, makeMessageDispatchHookContext } from '@get-bb/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import plugin from './server.js';

type PluginList = Awaited<ReturnType<BbPluginApi['sdk']['plugins']['list']>>;
async function setup(options:{failDisable?:boolean}={}) {
  const states=new Map([['host-a','disconnected'],['host-b','connected']]);
  const available=new Set(['host-a','host-b']);
  const enabled=new Map([['provider-codex',true],['provider-claude-code',false],['provider-acp',true]]);
  const stopped:string[]=[];
  const hostCalls:string[]=[];
  const mutations:string[]=[];
  const fake=createFakePluginHost({
    pluginId:'vpn-guard',
    sdk:{
      hosts:{list:async()=>[...available].map(id=>makeHostResponse({id,name:id}))},
      plugins:{
        list:async()=>({plugins:[...enabled].map(([id,value])=>({id,enabled:value}))}) as PluginList,
        disable:async({pluginId})=>{if(options.failDisable) throw Error('interrupted');enabled.set(pluginId,false);mutations.push(`disable:${pluginId}`);return {} as never;},
        enable:async({pluginId})=>{enabled.set(pluginId,true);mutations.push(`enable:${pluginId}`);return {} as never;},
      },
      threads:{
        listRunning:async()=>[{id:'protected',hostId:'host-a'},{id:'chinese',hostId:'host-a'},{id:'healthy',hostId:'host-b'}],
        get:async({threadId})=>makeThreadResponse({id:threadId,providerId:threadId==='chinese'?'kimi':'codex'}),
        stop:async({threadId})=>{stopped.push(threadId);return {} as never;},
      },
    },
    experimental_callHostRpc:({hostId})=>{hostCalls.push(hostId);if(!available.has(hostId)) throw Error('host unavailable');return {state:states.get(hostId)??'unknown'};},
  });
  await plugin(fake.bb);
  const hook=fake.harness.registrations.hooks['message.dispatch'];
  if(!hook) throw Error('missing hook');
  const dispatch=(providerId:string,hostId:string|null)=>hook(makeMessageDispatchHookContext({requestedExecution:{providerId},host:hostId?{id:hostId,name:hostId}:null}));
  return {fake,states,available,enabled,stopped,hostCalls,mutations,dispatch};
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
});
