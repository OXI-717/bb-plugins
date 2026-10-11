import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createFakePluginHost, makeHostResponse, makeThreadResponse, makeMessageDispatchHookContext } from '@get-bb/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import plugin from './server.js';

type Catalog = Awaited<ReturnType<BbPluginApi['sdk']['providers']['catalog']>>;
const entry = (id:string, enabled=true) => ({id,enabled,pluginEnabled:true}) as Catalog[number];
async function setup() {
  const states=new Map([['host-a','disconnected'],['host-b','connected']]);
  const enabled=new Map([['codex',true],['claude-code',false],['kimi',true]]);
  const stopped:string[]=[];
  const fake=createFakePluginHost({
    pluginId:'vpn-guard',
    sdk:{
      hosts:{list:async()=>[makeHostResponse({id:'host-a',name:'A'}),makeHostResponse({id:'host-b',name:'B'})]},
      providers:{catalog:async()=>[...enabled].map(([id,value])=>entry(id,value)),setEnabled:async({providerId,value,enabled:next}:any)=>{enabled.set(providerId,next);return [] as Catalog;}},
      threads:{listRunning:async()=>[{id:'protected',hostId:'host-a'},{id:'chinese',hostId:'host-a'},{id:'healthy',hostId:'host-b'}],get:async({threadId})=>makeThreadResponse({id:threadId,providerId:threadId==='chinese'?'kimi':'codex'}),stop:async({threadId})=>{stopped.push(threadId);return {} as never;}},
    },
    experimental_callHostRpc:({hostId})=>({state:states.get(hostId)??'unknown'}),
  });
  await plugin(fake.bb);
  return {fake,states,enabled,stopped};
}
describe('guard admission and reconciliation',()=>{
  it('observes by default without mutation and waits only protected disconnected host after opt-in',async()=>{
    const {fake,enabled,stopped}=await setup();
    const hook=fake.harness.registrations.hooks['message.dispatch'];
    if(!hook) throw Error('missing hook');
    const context=(providerId:string,hostId:string)=>makeMessageDispatchHookContext({requestedExecution:{providerId},host:{id:hostId,name:hostId}});
    expect(await hook(context('codex','host-a'))).toEqual({action:'proceed'});
    expect(stopped).toEqual([]);
    await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
    expect(await hook(context('codex','host-a'))).toMatchObject({action:'wait'});
    expect(await hook(context('codex','host-b'))).toEqual({action:'proceed'});
    expect(await hook(context('kimi','host-a'))).toEqual({action:'proceed'});
    expect(stopped).toEqual(['protected']);
    expect(enabled.get('codex')).toBe(false);
    expect(enabled.get('claude-code')).toBe(false);
    expect(enabled.get('kimi')).toBe(true);
    await fake.harness.lifecycle.dispose();
  });
  it('keeps remote host state separate and survives plugin reload with its journal',async()=>{
    const {fake,states,enabled,stopped}=await setup();
    states.set('host-a','unknown');
    await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
    expect(stopped).toEqual(['protected']);
    expect(enabled.get('codex')).toBe(false);
    const reloaded=await fake.harness.lifecycle.reload(plugin);
    const blocked=await reloaded.harness.behavior.callRpc('status',null);
    expect(blocked).toMatchObject({ownedDisabledProviders:['codex']});
    states.set('host-a','connected');
    await reloaded.harness.behavior.callRpc('setMode',{mode:'enforce'});
    expect(enabled.get('codex')).toBe(true);
    expect(enabled.get('claude-code')).toBe(false);
    await reloaded.harness.lifecycle.dispose();
  });
  it('reapplies a manually re-enabled protected provider while the host is blocked',async()=>{
    const {fake,enabled}=await setup();
    await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
    enabled.set('codex',true);
    await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
    expect(enabled.get('codex')).toBe(false);
    expect(enabled.get('kimi')).toBe(true);
    await fake.harness.lifecycle.dispose();
  });
  it('asks BB to recheck queued work when observation replaces enforcement',async()=>{
    const {fake}=await setup();
    await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
    const before=fake.harness.recheckCount;
    await fake.harness.behavior.callRpc('setMode',{mode:'observe'});
    expect(fake.harness.recheckCount).toBeGreaterThan(before);
    await fake.harness.lifecycle.dispose();
  });
  it('releases only its own opt-out on recovery',async()=>{
    const {fake,states,enabled}=await setup();
    await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
    states.set('host-a','connected');
    await fake.harness.behavior.callRpc('setMode',{mode:'enforce'});
    expect(enabled.get('codex')).toBe(true);
    expect(enabled.get('claude-code')).toBe(false);
    await fake.harness.lifecycle.dispose();
  });
});
