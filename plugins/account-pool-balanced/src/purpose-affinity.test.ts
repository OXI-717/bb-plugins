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
