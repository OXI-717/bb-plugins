import {it,expect} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {createHub} from './hub.js';
import {accountPoolConfigSchema} from './contracts.js';
import {AccountStore,QuotaStore,PoolAffinityStore,QUOTA_MIGRATIONS} from './store.js';
import {ACCOUNT_QUEUE_MAX_WAIT_MS} from './account-admission.js';

it('refuses sending after the total admission deadline expires while acquiring the final metadata snapshot',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pressure-deadline-'));
 const host=createFakePluginHost({pluginId:'fixture-pool',dataDir:dir});
 const accounts=new AccountStore(host.bb.storage.kv,path.join(dir,'secrets'));
 const db=host.bb.storage.database();for(const sql of QUOTA_MIGRATIONS)db.exec(sql);
 await accounts.add({provider:'claude',kind:'api-key',label:'Fixture',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true,priority:100},{kind:'api-key',apiKey:'synthetic'});
 let now=1900000000000,calls=0;
 const original=accounts.withSnapshot.bind(accounts);
 accounts.withSnapshot=(action)=>original(rows=>{now+=ACCOUNT_QUEUE_MAX_WAIT_MS+1;return action(rows);});
 const settings=accountPoolConfigSchema.parse({vpnOnlyProviders:[],vpnPolicyVersion:2});
 const hub=createHub({route:'/pool',accounts,quotas:new QuotaStore(db,()=>now),affinity:new PoolAffinityStore(db),getSettings:()=>settings,
 hubTokens:{authenticate:async()=> 'host',list:async()=>[]},fetch:async()=>{calls++;return Response.json({});},now:()=>now});
 try{
  const internal=hub as unknown as {forward:Function;options:{adapters:Map<string,unknown>}};
  const request=new Request('http://localhost/v1/messages',{method:'POST',body:'{}'});
  const response=await internal.forward(request,new TextEncoder().encode('{}'),internal.options.adapters.get('claude'),'host','project') as Response;
  await response.text();
  expect({status:response.status,calls}).toEqual({status:503,calls:0});
 }finally{await hub.stop();await host.harness.lifecycle.dispose();await fs.rm(dir,{recursive:true,force:true});}
});
