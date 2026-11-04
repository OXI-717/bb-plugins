import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {it,expect,vi} from 'vitest';
import {createAccountPoolPlugin} from './server.js';

it('real registration binds CLI, BB env, authenticated HTTP and forbids the old model/OAuth path',async()=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'native-pool-'));
  const upstream=vi.fn(async()=>new Response('{}'));
  const host=createFakePluginHost({pluginId:'account-pool',dataDir,sdk:{hosts:{list:async()=>[{id:'host-one',name:'One'}]}}});
  try{
    await createAccountPoolPlugin({fetch:upstream})(host.bb);
    const executor={id:'native-one',accountId:'subscription-one',hostId:'host-one',callerIds:['host-one'],projectIds:['project-one'],enabled:true};
    expect((await host.harness.behavior.runCli(['native','configure',JSON.stringify(executor)])).exitCode).toBe(0);
    expect((await host.harness.behavior.runCli(['native','mode','managed'])).exitCode).toBe(0);
    const env=await host.harness.behavior.resolveProviderEnv('acp-agy',{hostId:'host-one',projectId:'project-one',threadId:'thread-one'});
    expect(env.find(e=>e.name==='OXI_AGY_NATIVE_REQUIRED')?.value).toBe('1');
    expect(env.find(e=>e.name==='OXI_AGY_NATIVE_EXECUTOR')?.value).toBe('native-one');
    expect(env.some(e=>e.name==='OXI_AGY_POOL_AUTH_TOKEN')).toBe(false);
    const token=env.find(e=>e.name==='OXI_AGY_NATIVE_TOKEN')!.value as string;
    const response=await host.harness.behavior.fetchHttp('POST','/native/agy',{headers:{authorization:`Bearer ${token}`},body:JSON.stringify({action:'acquire',executorId:'native-one',sessionId:randomUUID()})});
    expect(response.status).toBe(200);const lease=await response.json();expect(lease.state).toBe('active');
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
