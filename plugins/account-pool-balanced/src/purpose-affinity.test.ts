import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createHub } from './hub.js';
import { accountPoolConfigSchema } from './contracts.js';
import { AccountStore, PoolAffinityStore, QuotaStore, QUOTA_MIGRATIONS } from './store.js';

it('isolates identical host/project/session and inherited affinity across trusted purposes', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'purpose-affinity-'));
  const host=createFakePluginHost({pluginId:'fixture-pool',dataDir:dir});
  const accounts=new AccountStore(host.bb.storage.kv,path.join(dir,'secrets'));
  const db=host.bb.storage.database();for(const sql of QUOTA_MIGRATIONS) db.exec(sql);
  const common={provider:'claude' as const,kind:'api-key' as const,label:'Fixture',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true};
  await accounts.add({...common,priority:100},{kind:'api-key',apiKey:'ordinary-key'});
  await accounts.add({...common,priority:200,autopilotAllowed:true},{kind:'api-key',apiKey:'permitted-key'});
  const seen:string[]=[];
  const settings=accountPoolConfigSchema.parse({vpnOnlyProviders:[],vpnPolicyVersion:2});
  // Trusted auth fixture deliberately shares host/project so purpose is the only boundary.
  const hub=createHub({route:'/pool',accounts,quotas:new QuotaStore(db),affinity:new PoolAffinityStore(db),getSettings:()=>settings,
    hubTokens:{authenticate:async()=> 'shared-host',list:async()=>[],authenticateContext:async token=>({hostId:'shared-host',projectId:'shared-project',...(token==='purpose-token'?{purpose:'autopilot' as const}:{})})},
    fetch:async(_input,init)=>{seen.push(new Headers(init?.headers).get('x-api-key')!);return Response.json({id:'fixture-response'});},
    now:()=>1900000000000});
  const controller=new AbortController();const service=hub.start(controller.signal);
  try {
    await new Promise(resolve=>setImmediate(resolve));
    const request=async(token:string,session:string,parent?:string)=>{
      const response=await hub.handle(new Request('http://localhost/pool/v1/messages',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({metadata:{user_id:JSON.stringify({session_id:session,...(parent?{parent_session_id:parent}:{})})}})}),'claude');
      expect(response.status).toBe(200);await response.text();
    };
    await request('legacy-token','same');
    await request('purpose-token','same');
    await request('legacy-token','same');
    await request('purpose-token','child','same');
    await request('legacy-token','child','same');
    expect(seen).toEqual(['ordinary-key','permitted-key','ordinary-key','permitted-key','ordinary-key']);
  } finally {
    controller.abort();await service;await host.harness.lifecycle.dispose();await fs.rm(dir,{recursive:true,force:true});
  }
});

it('rechecks retry admission after the awaited network guard', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'purpose-retry-'));
  const host=createFakePluginHost({pluginId:'fixture-pool',dataDir:dir});
  const accounts=new AccountStore(host.bb.storage.kv,path.join(dir,'secrets'));
  const db=host.bb.storage.database();for(const sql of QUOTA_MIGRATIONS)db.exec(sql);
  const account=await accounts.add({provider:'claude',kind:'api-key',label:'Fixture',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true,autopilotAllowed:true,priority:100},{kind:'api-key',apiKey:'synthetic'});
  let checks=0;let enter!:()=>void,unblock!:()=>void;
  const reached=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>unblock=resolve);
  const allowedAtSend:boolean[]=[];
  const settings=accountPoolConfigSchema.parse({vpnOnlyProviders:[],vpnGuardEnabled:true,vpnPolicyVersion:2});
  const transport:typeof fetch=async()=>{
    allowedAtSend.push((await accounts.get(account.id))!.autopilotAllowed);
    return new Response('{}',{status:allowedAtSend.length===1?429:200,headers:{'retry-after':'0'}});
  };
  const hub=createHub({route:'/pool',accounts,quotas:new QuotaStore(db),affinity:new PoolAffinityStore(db),getSettings:()=>settings,hubTokens:{authenticate:async()=> 'host',list:async()=>[]},
    guardCheck:async()=>{if(++checks===3){enter();await gate;}return 'direct';},fetch:transport,fetchIpv4:transport,now:()=>1900000000000});
  try {
    // Exercise the actual forwarding/retry/NetworkFlights seam without background usage.
    const internal=hub as unknown as {forward:Function;options:{adapters:Map<string,unknown>}};
    const request=new Request('http://localhost/v1/messages',{method:'POST',body:'{}'});
    const pending=internal.forward(request,new TextEncoder().encode('{}'),internal.options.adapters.get('claude'),'host','project',null,'autopilot') as Promise<Response>;
    await reached;expect(allowedAtSend).toEqual([true]);
    await accounts.setAutopilotAllowed(account.id,false,true);unblock();
    const response=await pending;await response.text();
    expect(response.status).toBe(403);expect(allowedAtSend).toEqual([true]);
  } finally {unblock();await hub.stop();await host.harness.lifecycle.dispose();await fs.rm(dir,{recursive:true,force:true});}
});

it('releases the metadata lock once transport has started and lets an in-flight call finish after opt-out',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'purpose-inflight-'));
  const host=createFakePluginHost({pluginId:'fixture-pool',dataDir:dir});
  const accounts=new AccountStore(host.bb.storage.kv,path.join(dir,'secrets'));
  const db=host.bb.storage.database();for(const sql of QUOTA_MIGRATIONS)db.exec(sql);
  const account=await accounts.add({provider:'claude',kind:'api-key',label:'Fixture',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true,autopilotAllowed:true,priority:100},{kind:'api-key',apiKey:'synthetic'});
  let enter!:()=>void,unblock!:()=>void;
  const reached=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>unblock=resolve);
  const settings=accountPoolConfigSchema.parse({vpnOnlyProviders:[],vpnPolicyVersion:2});
  const hub=createHub({route:'/pool',accounts,quotas:new QuotaStore(db),affinity:new PoolAffinityStore(db),getSettings:()=>settings,hubTokens:{authenticate:async()=> 'host',list:async()=>[]},
    fetch:async()=>{enter();await gate;return Response.json({});},now:()=>1900000000000});
  try {
    const internal=hub as unknown as {forward:Function;options:{adapters:Map<string,unknown>}};
    const request=new Request('http://localhost/v1/messages',{method:'POST',body:'{}'});
    const pending=internal.forward(request,new TextEncoder().encode('{}'),internal.options.adapters.get('claude'),'host','project',null,'autopilot') as Promise<Response>;
    await reached;
    await accounts.setAutopilotAllowed(account.id,false,true); // Must finish BEFORE provider headers arrive.
    unblock();const response=await pending;expect(response.status).toBe(200);await response.text();
  } finally {unblock();await hub.stop();await host.harness.lifecycle.dispose();await fs.rm(dir,{recursive:true,force:true});}
});

it('honors a cooldown arriving during the network guard and rechecks network policy after waiting',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pressure-guard-'));
  const host=createFakePluginHost({pluginId:'fixture-pool',dataDir:dir});
  const accounts=new AccountStore(host.bb.storage.kv,path.join(dir,'secrets'));
  const db=host.bb.storage.database();for(const sql of QUOTA_MIGRATIONS)db.exec(sql);
  const account=await accounts.add({provider:'claude',kind:'api-key',label:'Fixture',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true,priority:100},{kind:'api-key',apiKey:'synthetic'});
  let enter!:()=>void,unblock!:()=>void,checks=0;const reached=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>unblock=r);
  const quotas=new QuotaStore(db);const times:number[]=[];
  const settings=accountPoolConfigSchema.parse({vpnOnlyProviders:[],vpnGuardEnabled:true,vpnPolicyVersion:2});
  const transport:typeof fetch=async()=>{times.push(Date.now());return Response.json({});};
  const hub=createHub({route:'/pool',accounts,quotas,affinity:new PoolAffinityStore(db),getSettings:()=>settings,
    hubTokens:{authenticate:async()=> 'host',list:async()=>[]},guardCheck:async()=>{if(++checks===1){enter();await gate;}return 'direct';},
    fetch:transport,fetchIpv4:transport,now:Date.now});
  try {
    const internal=hub as unknown as {forward:Function;options:{adapters:Map<string,unknown>}};
    const request=new Request('http://localhost/v1/messages',{method:'POST',body:'{}'});
    const pending=internal.forward(request,new TextEncoder().encode('{}'),internal.options.adapters.get('claude'),'host','project') as Promise<Response>;
    await reached;const deadline=Date.now()+100;quotas.put({...quotas.get(account.id),heldUntil:deadline});unblock();
    const response=await pending;await response.text();
    expect(response.status).toBe(200);expect(times).toHaveLength(1);expect(times[0]).toBeGreaterThanOrEqual(deadline);
    expect(checks).toBeGreaterThanOrEqual(3); // pre-send, post-wait, post-response
  } finally {unblock();await hub.stop();await host.harness.lifecycle.dispose();await fs.rm(dir,{recursive:true,force:true});}
});
