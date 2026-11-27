import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {it,expect,vi} from 'vitest';
import {nativeAccountsSchema} from './native-accounts.js';
import {createAccountPoolPlugin} from './management-test-fixture.js';

it('authenticates prepared runtime grants against the server profile registry before a native task',async()=>{
  const host=createFakePluginHost({pluginId:'account-pool',sdk:{hosts:{list:async()=>[{id:'host-one',name:'One'}]}}});
  const upstream=vi.fn(async()=>new Response('{}'));
  try{
    await createAccountPoolPlugin({fetch:upstream})(host.bb);
    const execution={runtimeId:'runtime-one',gatewayId:'gateway-one',runtimeSha256:'a'.repeat(64),profile:{id:'fixture-exit',version:1}};
    const executor={id:'native-one',accountId:'subscription-one',hostId:'host-one',callerIds:['host-one'],projectIds:['project-one'],enabled:true,execution};
    const configure=()=>host.harness.behavior.runCli(['native','configure',JSON.stringify(executor)]);
    expect((await configure()).exitCode).toBe(1);
    const profile={id:'fixture-exit',version:1,label:'Fixture',node:'node-one',hostIds:['host-one'],transport:'ssh-connect',endpoint:'http://127.0.0.1:19081',dns:'remote',ipv4:true,ipv6:false,failure:'closed',expectedExit:['192.0.2.1'],assurance:'proxy-enforced'};
    expect((await host.harness.behavior.runCli(['egress','configure',JSON.stringify(profile)])).exitCode).toBe(0);
    expect((await configure()).exitCode).toBe(0);
    expect((await host.harness.behavior.runCli(['native','mode','managed'])).exitCode).toBe(0);
    const visible=await host.harness.behavior.callRpc('native.accounts',null);
    expect(visible).toEqual({managed:true,selectionRevision:expect.any(String),accounts:[{accountId:'subscription-one',projects:{onlySelected:true,rules:[{projectId:'project-one',role:'inherit'}]},projectsRevision:expect.any(String),mixedProjects:false,executors:[{id:'native-one',hostId:'host-one',enabled:true,autopilotAllowed:false}],active:0,queued:0,uncertain:0}]});
    const env=await host.harness.behavior.resolveProviderEnv('acp-agy',{hostId:'host-one',projectId:'project-one',threadId:'thread-one'});
    const token=env.find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')!.value;
    const sessionId=randomUUID();
    const denied=await host.harness.behavior.fetchHttp('POST','/native/agy',{
      headers:{authorization:`Bearer ${token}`,'x-bb-native-task-process':'1858e38e-2aa0-4f82-a565-1e154b3adcf9/23456'},
      body:JSON.stringify({action:'acquire',executorId:'native-one',sessionId}),
    });
    expect(await denied.json()).toEqual({error:'native-task-process-denied'});
    const response=await host.harness.behavior.fetchHttp('POST','/native/agy',{headers:{authorization:`Bearer ${token}`},body:JSON.stringify({action:'acquire',executorId:'native-one',sessionId})});
    expect(response.status).toBe(200);
    expect((await response.json()).binding).toMatchObject({...execution,schema:'bb-account-pool/native-execution/1',sessionId,accountId:'subscription-one',hostId:'host-one',kind:'task',caller:{hostId:'host-one',projectId:'project-one',threadId:'thread-one'}});
    expect(upstream).not.toHaveBeenCalled();
  }finally{await host.harness.lifecycle.dispose();}
});

it('real registration binds CLI, BB env, authenticated HTTP and forbids the old model/OAuth path',async()=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'native-pool-'));
  const upstream=vi.fn(async()=>new Response('{}'));
  const host=createFakePluginHost({pluginId:'account-pool',dataDir,sdk:{hosts:{list:async()=>[{id:'host-one',name:'One'}]}}});
  try{
    await createAccountPoolPlugin({fetch:upstream})(host.bb);
    const executor={id:'native-one',accountId:'subscription-one',hostId:'host-one',callerIds:['host-one'],catalogCallerIds:['catalog-client'],projectIds:['project-one'],enabled:true};
    expect((await host.harness.behavior.runCli(['native','configure',JSON.stringify(executor)])).exitCode).toBe(0);
    expect((await host.harness.behavior.runCli(['native','mode','managed'])).exitCode).toBe(0);
    const env=await host.harness.behavior.resolveProviderEnv('acp-agy',{hostId:'host-one',projectId:'project-one',threadId:'thread-one'});
    expect(env.find(e=>e.name==='OXI_AGY_NATIVE_REQUIRED')?.value).toBe('1');
    expect(env.find(e=>e.name==='OXI_AGY_NATIVE_EXECUTOR')?.value).toBe('native-one');
    expect(env.some(e=>e.name==='OXI_AGY_POOL_AUTH_TOKEN')).toBe(false);
    // Real discovery sends null scope; the fake host helper types only threads.
    const discoveryContext={hostId:'host-one',projectId:null,threadId:null};
    const discovery=await host.harness.behavior.resolveProviderEnv('acp-agy',discoveryContext as unknown as Parameters<typeof host.harness.behavior.resolveProviderEnv>[1]);
    expect(discovery.find(e=>e.name==='OXI_AGY_NATIVE_EXECUTOR')?.value).toBe('native-one');
    expect(discovery.find(e=>e.name==='OXI_AGY_NATIVE_CATALOG_ONLY')?.value).toBe('1');
    expect(discovery.find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')?.value).toBe('');
    expect(env.find(e=>e.name==='OXI_AGY_NATIVE_CATALOG_ONLY')?.value).toBe('0');
    const token=env.find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')!.value as string;
    const response=await host.harness.behavior.fetchHttp('POST','/native/agy',{headers:{authorization:`Bearer ${token}`},body:JSON.stringify({action:'acquire',executorId:'native-one',sessionId:randomUUID()})});
    expect(response.status).toBe(200);const lease=await response.json();expect(lease.state).toBe('active');
    expect((await host.harness.behavior.runCli(['bypass','thread-one'])).exitCode).toBe(0);
    for(const input of [{action:'poll',leaseId:lease.leaseId},{action:'acquire',executorId:'native-one',sessionId:randomUUID()}]){
      const bypassed=await host.harness.behavior.fetchHttp('POST','/native/agy',{headers:{authorization:`Bearer ${token}`},body:JSON.stringify(input)});
      expect(bypassed.status).toBe(403);expect(await bypassed.json()).toEqual({error:'native-thread-bypassed'});
    }
    const foreign=await host.harness.behavior.resolveProviderEnv('acp-agy',{hostId:'host-one',projectId:'foreign',threadId:'thread-foreign'});
    const denied=await host.harness.behavior.fetchHttp('POST','/native/agy',{headers:{authorization:`Bearer ${foreign.find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')!.value}`},body:JSON.stringify({action:'poll',leaseId:lease.leaseId})});
    expect(denied.status).toBe(403);
    expect(foreign.find(e=>e.name==='OXI_AGY_NATIVE_EXECUTOR')?.value).toBe('');
    const old=await host.harness.behavior.fetchHttp('GET','/agy/v1beta/models',{headers:{authorization:`Bearer ${token}`}});expect(old.status).toBe(410);
    const login=await host.harness.behavior.runCli(['account','add','--provider','agy','--login']);expect(login.exitCode).toBe(1);
    expect(upstream).not.toHaveBeenCalled();
    const release=await host.harness.behavior.fetchHttp('POST','/native/agy',{headers:{authorization:`Bearer ${token}`},body:JSON.stringify({action:'release',leaseId:lease.leaseId,stopped:true})});
    expect(release.status).toBe(200);
    const state=JSON.parse((await host.harness.behavior.runCli(['native','status','--json'])).stdout);
    expect(state.leases).toHaveLength(0);expect(state.events.map((e:{event:string})=>e.event)).toEqual(['queued','active','released']);
  }finally{await host.harness.lifecycle.dispose();await rm(dataDir,{recursive:true,force:true});}
});


it('saves native projects through RPC and contributes the executor for a future project',async()=>{
  const host=createFakePluginHost({pluginId:'account-pool',sdk:{hosts:{list:async()=>[{id:'host-one',name:'One'}]}}});
  try{
    await createAccountPoolPlugin({fetch:vi.fn(async()=>new Response('{}'))})(host.bb);
    const executor={id:'native-one',accountId:'subscription-one',hostId:'host-one',callerIds:['host-one'],projectIds:['project-one'],enabled:true};
    expect((await host.harness.behavior.runCli(['native','configure',JSON.stringify(executor)])).exitCode).toBe(0);
    await host.harness.behavior.runCli(['native','mode','managed']);
    const context={hostId:'host-one',projectId:'future-project',threadId:'thread-new'};
    const before=await host.harness.behavior.resolveProviderEnv('acp-agy',context);
    expect(before.find(e=>e.name==='OXI_AGY_NATIVE_EXECUTOR')?.value).toBe('');
    const account=nativeAccountsSchema.parse(await host.harness.behavior.callRpc('native.accounts',null)).accounts[0];
    const input={accountId:account.accountId,projects:{onlySelected:false,rules:[]},expectedRevision:account.projectsRevision};
    await host.harness.behavior.callRpc('native.setProjects',input);
    const after=await host.harness.behavior.resolveProviderEnv('acp-agy',context);
    expect(after.find(e=>e.name==='OXI_AGY_NATIVE_EXECUTOR')?.value).toBe('native-one');
    await expect(host.harness.behavior.callRpc('native.setProjects',input)).rejects.toThrow();
  }finally{await host.harness.lifecycle.dispose();}
});


it('maintenance denies native acquire and poll while allowing confirmed cleanup',async()=>{
  const host=createFakePluginHost({pluginId:'account-pool',sdk:{hosts:{list:async()=>[{id:'host-one',name:'One'}]}}});
  try{
    await createAccountPoolPlugin({fetch:vi.fn(async()=>new Response('{}'))})(host.bb);
    const executor={id:'native-one',accountId:'subscription-one',hostId:'host-one',callerIds:['host-one'],projectIds:['project-one'],enabled:true};
    await host.harness.behavior.runCli(['native','configure',JSON.stringify(executor)]);
    await host.harness.behavior.runCli(['native','mode','managed']);
    const env=await host.harness.behavior.resolveProviderEnv('acp-agy',{hostId:'host-one',projectId:'project-one',threadId:'thread-one'});
    const token=env.find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')!.value;
    const request=(input:object)=>host.harness.behavior.fetchHttp('POST','/native/agy',{headers:{authorization:`Bearer ${token}`},body:JSON.stringify(input)});
    const acquired=await request({action:'acquire',executorId:'native-one',sessionId:randomUUID()});
    const lease=await acquired.json();expect(acquired.status).toBe(200);
    const owner='11111111-1111-4111-8111-111111111111';
    expect((await host.harness.behavior.runCli(['maintenance','acquire','--owner',owner,'--json'])).exitCode).toBe(0);
    for(const input of [{action:'poll',leaseId:lease.leaseId},{action:'acquire',executorId:'native-one',sessionId:randomUUID()}]){
      const denied=await request(input);expect(denied.status).toBe(503);expect(await denied.json()).toEqual({error:'POOL_MAINTENANCE'});
    }
    expect(JSON.parse((await host.harness.behavior.runCli(['native','status','--json'])).stdout).leases).toHaveLength(1);
    expect((await request({action:'release',leaseId:lease.leaseId,stopped:true})).status).toBe(200);
    expect(JSON.parse((await host.harness.behavior.runCli(['native','status','--json'])).stdout).leases).toHaveLength(0);
  }finally{await host.harness.lifecycle.dispose();}
});

it('applies native account settings through the real RPC contract and routes each project without widening caller authority',async()=>{
  const host=createFakePluginHost({pluginId:'account-pool',sdk:{hosts:{list:async()=>[{id:'host-one',name:'One'}]}}});
  try{
    await createAccountPoolPlugin({fetch:vi.fn(async()=>new Response('{}'))})(host.bb);
    for(const [id,accountId] of [['native-one','subscription-one'],['native-two','subscription-two']]){
      expect((await host.harness.behavior.runCli(['native','configure',JSON.stringify({id,accountId,hostId:'host-one',callerIds:['host-one'],projectIds:['project-one'],enabled:true})])).exitCode).toBe(0);
    }
    await host.harness.behavior.runCli(['native','mode','managed']);
    const update=async(input:Record<string,unknown>)=>{
      const state=nativeAccountsSchema.parse(await host.harness.behavior.callRpc('native.accounts',null));
      return host.harness.behavior.callRpc('native.updateAccount',{...input,expectedRevision:state.selectionRevision});
    };
    await update({accountId:'subscription-one',role:'primary',priority:1,projects:{onlySelected:false,rules:[]}});
    await update({accountId:'subscription-two',role:'reserve',priority:2,projects:{onlySelected:true,rules:[{projectId:'project-two',role:'primary'}]}});
    const context={hostId:'host-one',projectId:'project-two',threadId:'thread-one'};
    const chosen=await host.harness.behavior.resolveProviderEnv('acp-agy',context);
    expect(chosen.find(e=>e.name==='OXI_AGY_NATIVE_EXECUTOR')?.value).toBe('native-two');
    const other=await host.harness.behavior.resolveProviderEnv('acp-agy',{...context,projectId:'other'});
    expect(other.find(e=>e.name==='OXI_AGY_NATIVE_EXECUTOR')?.value).toBe('native-one');
    const foreign=await host.harness.behavior.resolveProviderEnv('acp-agy',{...context,hostId:'foreign'});
    expect(foreign.find(e=>e.name==='OXI_AGY_NATIVE_EXECUTOR')?.value).toBe('');
    await expect(update({accountId:'subscription-two',callerIds:['foreign']})).rejects.toThrow();
    await expect(update({accountId:'subscription-two',executor:{id:'native-one',enabled:false}})).rejects.toThrow();
  }finally{await host.harness.lifecycle.dispose();}
});

it('targeted probe reports unavailable without enabling, acquiring or calling upstream',async()=>{
  const host=createFakePluginHost({pluginId:'account-pool',sdk:{hosts:{list:async()=>[{id:'host-one',name:'One'}]}}});
  const upstream=vi.fn(async()=>new Response('{}'));
  try{
    await createAccountPoolPlugin({fetch:upstream})(host.bb);
    const executor={id:'native-second',accountId:'subscription-two',hostId:'host-one',callerIds:['host-one'],projectIds:['project-one'],enabled:false};
    expect((await host.harness.behavior.runCli(['native','configure',JSON.stringify(executor)])).exitCode).toBe(0);
    expect((await host.harness.behavior.runCli(['native','mode','managed'])).exitCode).toBe(0);
    const before=await host.harness.behavior.runCli(['native','status','--json']);
    expect(await host.harness.behavior.callRpc('native.probe',{accountId:'subscription-two',executorId:'native-second',hostId:'host-one',projectId:'project-one'})).toEqual({accountId:'subscription-two',executorId:'native-second',hostId:'host-one',projectId:'project-one',status:'runtime-unavailable',verified:false,observedAt:expect.any(Number),catalog:[]});
    await expect(host.harness.behavior.callRpc('native.probe',{accountId:'other',executorId:'native-second',hostId:'host-one',projectId:'project-one'})).rejects.toThrow('native-diagnostic-denied');
    expect(await host.harness.behavior.runCli(['native','status','--json'])).toEqual(before);
    expect(upstream).not.toHaveBeenCalled();
  }finally{await host.harness.lifecycle.dispose();}
});

it('reports expired native leases through pool status until the operator confirms the stop',async()=>{
  const host=createFakePluginHost({pluginId:'account-pool',sdk:{hosts:{list:async()=>[{id:'host-one',name:'One'}]}}});
  let now=1_800_000_000_000;
  try {
    await createAccountPoolPlugin({now:()=>now})(host.bb);
    const executor={id:'example-executor',accountId:'subscription-one',hostId:'host-one',
      callerIds:['host-one'],projectIds:['project-one'],enabled:true};
    const cli=async(...args:string[])=>(await host.harness.behavior.runCli(args));
    expect((await cli('native','configure',JSON.stringify(executor))).exitCode).toBe(0);
    expect((await cli('native','mode','managed')).exitCode).toBe(0);
    const env=await host.harness.behavior.resolveProviderEnv('acp-agy',{hostId:'host-one',projectId:'project-one',threadId:'thread-one'});
    const token=env.find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')!.value;
    const response=await host.harness.behavior.fetchHttp('POST','/native/agy',{
      headers:{authorization:`Bearer ${token}`},body:JSON.stringify({action:'acquire',executorId:executor.id,sessionId:randomUUID()}),
    });
    expect(response.status).toBe(200);
    const {leaseId}=await response.json();
    const status=async()=>JSON.parse((await cli('status','--json')).stdout);
    expect((await status()).uncertainNativeLeases).toEqual([]);
    now+=125_000;
    const expected=[{leaseId,executorId:executor.id,kind:'task',ageMs:125_000}];
    expect((await status()).uncertainNativeLeases).toEqual(expected);
    expect(await host.harness.behavior.callRpc('status.get',null)).toMatchObject({uncertainNativeLeases:expected});
    expect((await cli('status')).stdout).toContain(`bb pool native attest-stopped ${leaseId} --confirmed`);
    expect((await status()).uncertainNativeLeases).toEqual(expected);
    expect((await cli('native','attest-stopped',leaseId,'--confirmed')).exitCode).toBe(0);
    expect((await status()).uncertainNativeLeases).toEqual([]);
  } finally {await host.harness.lifecycle.dispose();}
});

it('shares in-flight native Guard checks per host without caching completed decisions and distinguishes block vs unavailability',async()=>{
  let decision:{allowed:boolean;reason:string}={allowed:true,reason:'direct'};
  let rpcMode:'resolve'|'deferred'|'fail'='resolve';
  let rpcCalls=0;
  let releaseDeferred:(()=>void)|undefined;
  const host=createFakePluginHost({
    pluginId:'account-pool',
    sdk:{
      hosts:{list:async()=>[{id:'host-one',name:'One'}]},
      plugins:{
        callRpc:async(request)=>{
          if(request.pluginId==='vpn-guard'&&request.method==='networkDecisionV2'){
            const input=request.input as {hostId:string;provider:string};
            rpcCalls+=1;
            if(rpcMode==='fail')throw Error('guard rpc failed');
            if(rpcMode==='deferred'){
              await new Promise<void>(resolve=>{releaseDeferred=resolve;});
            }
            return {schema:'bb-vpn-guard/network-decision/2',hostId:input.hostId,...decision};
          }
          throw Error(`unexpected rpc ${request.pluginId}.${request.method}`);
        },
      },
    },
  });
  try {
    await createAccountPoolPlugin({fetch:vi.fn(async()=>new Response('{}'))})(host.bb);
    const cli=async(...args:string[])=>(await host.harness.behavior.runCli(args));
    expect((await cli('config','set','vpnGuardEnabled','true')).exitCode).toBe(0);
    const executor={id:'native-one',accountId:'subscription-one',hostId:'host-one',callerIds:['host-one'],projectIds:['project-one'],enabled:true};
    expect((await cli('native','configure',JSON.stringify(executor))).exitCode).toBe(0);
    expect((await cli('native','mode','managed')).exitCode).toBe(0);
    const accounts=nativeAccountsSchema.parse(await host.harness.behavior.callRpc('native.accounts',null));
    await host.harness.behavior.callRpc('native.updateAccount',{accountId:'subscription-one',maxConcurrentSessions:2,expectedRevision:accounts.selectionRevision});
    const envA=await host.harness.behavior.resolveProviderEnv('acp-agy',{hostId:'host-one',projectId:'project-one',threadId:'thread-one'});
    const envB=await host.harness.behavior.resolveProviderEnv('acp-agy',{hostId:'host-one',projectId:'project-one',threadId:'thread-two'});
    const tokA=envA.find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')!.value as string;
    const tokB=envB.find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')!.value as string;
    const post=(tok:string,body:object)=>host.harness.behavior.fetchHttp('POST','/native/agy',{headers:{authorization:`Bearer ${tok}`},body:JSON.stringify(body)});
    const leaseA=await (await post(tokA,{action:'acquire',executorId:'native-one',sessionId:randomUUID()})).json();
    const leaseB=await (await post(tokB,{action:'acquire',executorId:'native-one',sessionId:randomUUID()})).json();
    expect((await cli('maintenance','acquire-upgrade','--owner',upgradeOwner,'--json')).exitCode).toBe(0);
    const beforeConcurrent=rpcCalls;
    rpcMode='deferred';
    const pendingA=post(tokA,{action:'poll',leaseId:leaseA.leaseId});
    const pendingB=post(tokB,{action:'poll',leaseId:leaseB.leaseId});
    await vi.waitFor(()=>expect(releaseDeferred).toBeDefined());
    // Give second concurrent poll a tick to join the same in-flight Guard read.
    await new Promise(resolve=>setTimeout(resolve,15));
    (releaseDeferred as ()=>void)();
    const [resA,resB]=await Promise.all([pendingA,pendingB]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(rpcCalls-beforeConcurrent).toBe(1);
    // Completed decision is never cached: next poll triggers a fresh Guard read.
    rpcMode='resolve';
    expect((await post(tokA,{action:'poll',leaseId:leaseA.leaseId})).status).toBe(200);
    expect(rpcCalls-beforeConcurrent).toBe(2);
    // Explicit Guard block returns 403 native-guard-blocked.
    decision={allowed:false,reason:'manual_block'};
    const blocked=await post(tokA,{action:'poll',leaseId:leaseA.leaseId});
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({error:'native-guard-blocked'});
    // Guard RPC unavailability returns 503 native-guard-unavailable.
    rpcMode='fail';
    const unavailable=await post(tokA,{action:'poll',leaseId:leaseA.leaseId});
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({error:'native-guard-unavailable'});
    // Release still succeeds without Guard check.
    expect((await post(tokA,{action:'release',leaseId:leaseA.leaseId,stopped:true})).status).toBe(200);
    expect((await post(tokB,{action:'release',leaseId:leaseB.leaseId,stopped:true})).status).toBe(200);
  } finally {await host.harness.lifecycle.dispose();}
});

const upgradeOwner = '11111111-1111-4111-8111-111111111111';

async function upgradeFixture(now = Date.now, checkHost = async()=>{}) {
  const host = createFakePluginHost({pluginId:'account-pool',sdk:{hosts:{list:async()=>{
    await checkHost();
    return [{id:'host-one',name:'One'}];
  }}}});
  const plugin = createAccountPoolPlugin({now,fetch:vi.fn(async()=>new Response('{}'))});
  await plugin(host.bb);
  const cli = (...args:string[]) => host.harness.behavior.runCli(args);
  const executor = {id:'native-one',accountId:'subscription-one',hostId:'host-one',callerIds:['host-one'],projectIds:['project-one'],enabled:true};
  const configure = (changes = {}) => cli('native','configure',JSON.stringify({...executor,...changes}));
  expect((await configure()).exitCode).toBe(0);
  expect((await cli('native','mode','managed')).exitCode).toBe(0);
  const tokenFor = async (threadId:string) => (await host.harness.behavior.resolveProviderEnv(
    'acp-agy',{hostId:'host-one',projectId:'project-one',threadId},
  )).find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')!.value;
  const token = await tokenFor('thread-one');
  const foreign = await tokenFor('thread-two');
  const post = (input:object, caller=token) => host.harness.behavior.fetchHttp('POST','/native/agy',{
    headers:{authorization:`Bearer ${caller}`},body:JSON.stringify(input),
  });
  const maintenance = (action:string) => cli('maintenance',action,...(action==='status'?[]:['--owner',upgradeOwner]),'--json');
  const acquire = () => ({action:'acquire',executorId:executor.id,sessionId:randomUUID()});
  return {host, plugin, cli, post, maintenance, acquire, foreign};
}

it('drains only owned active native polls and seals once only queued leases remain', async()=>{
  const f = await upgradeFixture();
  try {
    const original = f.acquire();
    const active = await (await f.post(original)).json();
    const queued = await (await f.post(f.acquire())).json();
    expect(active.state).toBe('active');
    expect(queued.state).toBe('queued');
    expect((await f.maintenance('acquire-upgrade')).exitCode).toBe(0);
    const poll = {action:'poll',leaseId:active.leaseId};
    expect((await f.post(poll)).status).toBe(200);
    expect((await f.post(poll,f.foreign)).status).toBe(403);
    expect(JSON.parse((await f.maintenance('status')).stdout)).toMatchObject({transportInFlight:1,nativeDrain:true});
    expect(await f.host.harness.behavior.callRpc('maintenance.status',null)).toMatchObject({transportInFlight:1,nativeDrain:true});
    expect((await f.maintenance('seal-upgrade')).exitCode).toBe(1);
    for (const input of [original,f.acquire(),{action:'unlock-start',leaseId:active.leaseId}]) {
      expect(await (await f.post(input)).json()).toEqual({error:'POOL_MAINTENANCE'});
    }
    expect((await f.post({action:'unlock-cancel',leaseId:active.leaseId})).status).toBe(200);
    expect((await f.post({action:'release',leaseId:active.leaseId,completed:true})).status).toBe(200);
    const queuedPoll = {action:'poll',leaseId:queued.leaseId};
    expect(await (await f.post(queuedPoll)).json()).toEqual({error:'POOL_MAINTENANCE'});
    const sealed = await f.maintenance('seal-upgrade');
    expect(sealed.exitCode).toBe(0);
    expect(JSON.parse(sealed.stdout)).toMatchObject({transportInFlight:0,lease:{upgrade:'sealed'}});
    expect(await (await f.post(queuedPoll)).json()).toEqual({error:'POOL_MAINTENANCE'});
  } finally {await f.host.harness.lifecycle.dispose();}
});

it('draining rechecks thread policy and treats expired active leases as blockers',async()=>{
  let now = 1_800_000_000_000;
  const f = await upgradeFixture(()=>now);
  try {
    const {leaseId} = await (await f.post(f.acquire())).json();
    expect((await f.maintenance('acquire-upgrade')).exitCode).toBe(0);
    expect((await f.cli('bypass','thread-one')).exitCode).toBe(0);
    const poll = {action:'poll',leaseId};
    expect(await (await f.post(poll)).json()).toEqual({error:'native-thread-bypassed'});
    now += 125_000;
    expect((await f.post(poll)).status).toBe(503);
    expect(JSON.parse((await f.maintenance('status')).stdout).transportInFlight).toBe(1);
    expect((await f.maintenance('seal-upgrade')).exitCode).toBe(1);
    expect((await f.post({action:'release',leaseId,completed:true})).status).toBe(409);
    expect((await f.post({action:'release',leaseId,stopped:true})).status).toBe(200);
    expect((await f.maintenance('seal-upgrade')).exitCode).toBe(0);
  } finally {await f.host.harness.lifecycle.dispose();}
});

it.each(['activate','release','failed-release'])('orders seal after an in-flight native %s write',async operation=>{
  const f = await upgradeFixture();
  const release = operation!=='activate';
  const {leaseId} = release ? await (await f.post(f.acquire())).json() : {};
  const kv = f.host.bb.storage.kv;
  const set = kv.set.bind(kv);
  let openWrite!:()=>void;
  let entered!:()=>void;
  const blocked = new Promise<void>(resolve=>{entered=resolve;});
  const resume = new Promise<void>(resolve=>{openWrite=resolve;});
  const spy = vi.spyOn(kv,'set').mockImplementation(async(key,value)=>{
    if(key==='native-agy-sessions-v1'){
      entered();
      await resume;
      if(operation==='failed-release')throw Error('fixture write failure');
    }
    return set(key,value);
  });
  try {
    const pending = f.post(release ? {action:'release',leaseId,stopped:true} : f.acquire());
    await blocked;
    expect((await f.maintenance('acquire-upgrade')).exitCode).toBe(0);
    expect(JSON.parse((await f.maintenance('status')).stdout).transportInFlight).toBe(1);
    let finished = false;
    const sealing = f.maintenance('seal-upgrade').then(result=>{finished=true;return result;});
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(finished).toBe(false);
    openWrite();
    expect((await pending).status).toBe(operation==='failed-release'?503:200);
    expect((await sealing).exitCode).toBe(operation==='release'?0:1);
  } finally {
    openWrite();
    spy.mockRestore();
    await f.host.harness.lifecycle.dispose();
  }
});

it('rechecks admission after host verification for acquire, queued poll and unlock-start',async()=>{
  let checks=0;
  let resume!:()=>void;
  const gate=new Promise<void>(resolve=>{resume=resolve;});
  let hold=false;
  const f=await upgradeFixture(Date.now,async()=>{
    if(hold){checks++;await gate;}
  });
  try {
    const active=await (await f.post(f.acquire())).json();
    const queued=await (await f.post(f.acquire())).json();
    hold=true;
    const incoming=[
      f.post(f.acquire()),
      f.post({action:'poll',leaseId:queued.leaseId}),
      f.post({action:'unlock-start',leaseId:active.leaseId}),
    ];
    await vi.waitFor(()=>expect(checks).toBe(3));
    expect((await f.maintenance('acquire-upgrade')).exitCode).toBe(0);
    expect((await f.post({action:'release',leaseId:active.leaseId,completed:true})).status).toBe(200);
    resume();
    for(const response of await Promise.all(incoming)) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({error:'POOL_MAINTENANCE'});
    }
    expect((await f.maintenance('seal-upgrade')).exitCode).toBe(0);
  } finally {resume();await f.host.harness.lifecycle.dispose();}
});

it('reload quarantines active leases and refuses to seal a persisted drain',async()=>{
  const f=await upgradeFixture();
  let host=f.host;
  try {
    const {leaseId}=await (await f.post(f.acquire())).json();
    expect((await f.maintenance('acquire-upgrade')).exitCode).toBe(0);
    host=await host.harness.lifecycle.reload(f.plugin);
    const cli=(...args:string[])=>host.harness.behavior.runCli(args);
    expect(JSON.parse((await cli('native','status','--json')).stdout).leases).toMatchObject([{id:leaseId,state:'uncertain'}]);
    expect(JSON.parse((await cli('maintenance','status','--json')).stdout)).toMatchObject({transportInFlight:1,lease:{upgrade:'draining'}});
    expect((await cli('maintenance','seal-upgrade','--owner',upgradeOwner,'--json')).exitCode).toBe(1);
    const env=await host.harness.behavior.resolveProviderEnv('acp-agy',{hostId:'host-one',projectId:'project-one',threadId:'thread-one'});
    const token=env.find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')!.value;
    const poll=await host.harness.behavior.fetchHttp('POST','/native/agy',{
      headers:{authorization:`Bearer ${token}`},body:JSON.stringify({action:'poll',leaseId}),
    });
    expect(poll.status).toBe(503);
    expect(await poll.json()).toEqual({error:'POOL_MAINTENANCE'});
    expect((await cli('native','attest-stopped',leaseId,'--confirmed')).exitCode).toBe(0);
    expect((await cli('maintenance','seal-upgrade','--owner',upgradeOwner,'--json')).exitCode).toBe(0);
  } finally {await host.harness.lifecycle.dispose();}
});

it('reconciles an authenticated route lease through the assigned host on the native timer',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  let now=1000;
  const bootId='1858e38e-2aa0-4f82-a565-1e154b3adcf9';
  const groupId=23456;
  const host=createFakePluginHost({
    pluginId:'account-pool',
    sdk:{hosts:{list:async()=>[{id:'executor-host',name:'Fixture'}]}},
    experimental_callHostRpc:async()=>({stopped:true}),
  });
  try{
    await createAccountPoolPlugin({now:()=>now,fetch:vi.fn(async()=>new Response('{}'))})(host.bb);
    const cli=(...args:string[])=>host.harness.behavior.runCli(args);
    expect((await cli('native','configure',JSON.stringify({
      id:'native-one',accountId:'subscription-one',hostId:'executor-host',
      callerIds:['executor-host'],projectIds:['project-one'],enabled:true,
    }))).exitCode).toBe(0);
    expect((await cli('native','mode','managed')).exitCode).toBe(0);
    const env=await host.harness.behavior.resolveProviderEnv('acp-agy',{
      hostId:'executor-host',projectId:'project-one',threadId:'thread-one',
    });
    const token=env.find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')!.value;
    const requestId=randomUUID();
    const post=(sessionId:string,callerToken=token)=>host.harness.behavior.fetchHttp('POST','/native/agy',{
      headers:{authorization:`Bearer ${callerToken}`,'x-request-id':requestId,'x-bb-native-task-process':`${bootId}/${groupId}`},
      body:JSON.stringify({action:'acquire',executorId:'native-one',sessionId}),
    });
    const unauthorized=await post(randomUUID(),'fixture-unauthorized');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('x-request-id')).toBe(requestId);
    const reject=host.harness.inspection.logEntries.find(e=>JSON.stringify(e).includes('native admission rejected'));
    expect(JSON.stringify(reject)).toContain(requestId);
    expect(JSON.stringify(reject)).not.toMatch(/fixture-unauthorized|23456|sessionId/);
    const first=await (await post(randomUUID())).json();
    expect(first.state).toBe('active');
    now+=15_000;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(host.harness.inspection.experimental_hostRpcCalls).toEqual([]);
    now+=15_001;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(host.harness.inspection.experimental_hostRpcCalls).toEqual([
      {method:'catalogProcessStatus',hostId:'executor-host',input:{bootId,groupId}},
    ]);
    expect((await (await post(randomUUID())).json()).state).toBe('active');
  }finally{
    await host.harness.lifecycle.dispose();
    vi.useRealTimers();
  }
});
