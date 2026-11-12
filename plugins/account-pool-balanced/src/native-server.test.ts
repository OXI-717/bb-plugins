import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {it,expect,vi} from 'vitest';
import {nativeAccountsSchema} from './native-accounts.js';
import {createAccountPoolPlugin} from './server.js';

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
    expect(visible).toEqual({managed:true,selectionRevision:expect.any(String),accounts:[{accountId:'subscription-one',projects:{onlySelected:true,rules:[{projectId:'project-one',role:'inherit'}]},projectsRevision:expect.any(String),mixedProjects:false,executors:[{id:'native-one',enabled:true,autopilotAllowed:false}],active:0,queued:0,uncertain:0}]});
    const env=await host.harness.behavior.resolveProviderEnv('acp-agy',{hostId:'host-one',projectId:'project-one',threadId:'thread-one'});
    const token=env.find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')!.value;
    const sessionId=randomUUID();
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
