import {it,expect} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {createHub} from './hub.js';
import {accountPoolConfigSchema} from './contracts.js';
import {AccountStore,QuotaStore,PoolAffinityStore,QUOTA_MIGRATIONS} from './store.js';

it('serializes actual Claude dispatch starts after a shared cooldown while leaving running streams alive',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'claude-paced-'));const host=createFakePluginHost({pluginId:'fixture-pool',dataDir:dir});
 const accounts=new AccountStore(host.bb.storage.kv,path.join(dir,'secrets'));const db=host.bb.storage.database();for(const sql of QUOTA_MIGRATIONS)db.exec(sql);
 const account=await accounts.add({provider:'claude',kind:'api-key',label:'Fixture',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true,priority:100},{kind:'api-key',apiKey:'synthetic'});
 const settings=accountPoolConfigSchema.parse({vpnOnlyProviders:[],claudeRequestStartIntervalMs:60});const quotas=new QuotaStore(db,Date.now);
 quotas.put({...quotas.get(account.id),heldUntil:Date.now()+100});
 const starts:number[]=[],streams:ReadableStreamDefaultController<Uint8Array>[]=[];
 const hub=createHub({route:'/pool',accounts,quotas,affinity:new PoolAffinityStore(db),getSettings:()=>settings,hubTokens:{authenticate:async()=> 'host',list:async()=>[]},fetch:async()=>{starts.push(Date.now());return new Response(new ReadableStream<Uint8Array>({start(c){streams.push(c);}}));},now:Date.now});
 try{
  const internal=hub as unknown as {forward:Function;options:{adapters:Map<string,unknown>}};
  const send=()=>internal.forward(new Request('http://localhost/v1/messages',{method:'POST',body:'{}'}),new TextEncoder().encode('{}'),internal.options.adapters.get('claude'),'host','project') as Promise<Response>;
  const [one,two]=await Promise.all([send(),send()]);expect(starts).toHaveLength(2);expect(starts[1]!-starts[0]!).toBeGreaterThanOrEqual(60);
  expect(streams).toHaveLength(2);const bodies=[one.text(),two.text()];for(const stream of streams)stream.close();await Promise.all(bodies);
 }finally{await hub.stop();await host.harness.lifecycle.dispose();await fs.rm(dir,{recursive:true,force:true});}
});

it('does not apply Claude spacing to another provider',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'other-provider-paced-'));const host=createFakePluginHost({pluginId:'fixture-pool',dataDir:dir});
 const accounts=new AccountStore(host.bb.storage.kv,path.join(dir,'secrets'));const db=host.bb.storage.database();for(const sql of QUOTA_MIGRATIONS)db.exec(sql);
 await accounts.add({provider:'kimi',kind:'api-key',label:'Fixture',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true,priority:100},{kind:'api-key',apiKey:'synthetic'});
 const settings=accountPoolConfigSchema.parse({vpnOnlyProviders:[],claudeRequestStartIntervalMs:60000});let calls=0;
 const now=()=>1900000000000;
 const hub=createHub({route:'/pool',accounts,quotas:new QuotaStore(db,now),affinity:new PoolAffinityStore(db),getSettings:()=>settings,hubTokens:{authenticate:async()=> 'host',list:async()=>[]},fetch:async()=>{calls++;return Response.json({});},now});
 try{
  const internal=hub as unknown as {forward:Function;options:{adapters:Map<string,unknown>}};
  const send=()=>internal.forward(new Request('http://localhost/v1/messages',{method:'POST',body:'{}'}),new TextEncoder().encode('{}'),internal.options.adapters.get('kimi'),'host','project') as Promise<Response>;
  for(let i=0;i<2;i++)await(await send()).text();expect(calls).toBe(2);
 }finally{await hub.stop();await host.harness.lifecycle.dispose();await fs.rm(dir,{recursive:true,force:true});}
});
