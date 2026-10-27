import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createHub } from './hub.js';
import { accountPoolConfigSchema } from './contracts.js';
import { AccountStore, PoolAffinityStore, QuotaStore, QUOTA_MIGRATIONS } from './store.js';
import { zaiBudgetQuota } from './zai-budget.js';

const epoch=1900000000000;
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.restoreAllMocks();vi.useRealTimers();});
async function fixture(options:{latency?:number;pending?:boolean}={}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'usage-scheduler-'));
 const host=createFakePluginHost({pluginId:'fixture-pool',dataDir:dir});
 cleanups.push(async()=>{await host.harness.lifecycle.dispose();await fs.rm(dir,{recursive:true,force:true});});
 const accounts=new AccountStore(host.bb.storage.kv,path.join(dir,'secrets'));
 const common={kind:'api-key' as const,label:'Synthetic',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true,priority:100};
 const zai=await accounts.add({...common,provider:'zai'},{kind:'api-key',apiKey:'synthetic'});
 await accounts.add({...common,provider:'kimi'},{kind:'api-key',apiKey:'synthetic'});
 vi.spyOn(accounts,'readSecret').mockResolvedValue({kind:'api-key',apiKey:'synthetic'});
 const db=host.bb.storage.database();for(const sql of QUOTA_MIGRATIONS)db.exec(sql);const quotas=new QuotaStore(db);
 const calls:Array<{provider:string;at:number}>=[];
 const fetch:typeof globalThis.fetch=async(input,init)=>{
  const provider=String(input).endsWith('/zai')?'zai':'kimi';calls.push({provider,at:Date.now()-epoch});
  if(options.pending)await new Promise<void>((_resolve,reject)=>{
   const signal=init!.signal!;const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
  if(options.latency)await new Promise<void>((resolve,reject)=>{
   const signal=init!.signal!;const abort=()=>{clearTimeout(timer);reject(signal.reason);};
   const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},options.latency);
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
  return Response.json(provider==='zai'?{code:200,success:true,data:{limits:[
   {type:'TOKENS_LIMIT',unit:3,percentage:1,nextResetTime:Date.now()+3600000},
   {type:'TOKENS_LIMIT',unit:6,percentage:14,nextResetTime:Date.now()+604800000},
  ]}}:{});
 };
 const settings=accountPoolConfigSchema.parse({vpnOnlyProviders:[],vpnPolicyVersion:2});
 const hub=createHub({route:'/pool',accounts,quotas,affinity:new PoolAffinityStore(db),getSettings:()=>settings,
  hubTokens:{authenticate:async()=>null,list:async()=>[]},fetch,now:()=>Date.now(),zaiUsagesUrl:'https://quota.invalid/zai',kimiUsagesUrl:'https://quota.invalid/kimi'});
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});vi.setSystemTime(epoch);
 const controller=new AbortController();const service=hub.start(controller.signal);
 cleanups.push(async()=>{controller.abort();await service;});
 await vi.advanceTimersByTimeAsync(0);
 return {hub,quotas,zai,calls,controller,service};
}

it('refreshes an off-phase manual ZAI seed before expiry without increasing other-provider frequency',async()=>{
 const f=await fixture();expect(f.calls).toEqual([{provider:'zai',at:0},{provider:'kimi',at:0}]);
 await vi.advanceTimersByTimeAsync(30000);await f.hub.refreshUsage(f.zai.id,true);
 await vi.advanceTimersByTimeAsync(240000);
 expect(f.calls.filter(x=>x.provider==='zai').map(x=>x.at)).toEqual([0,30000,180000]);
 expect(f.calls.filter(x=>x.provider==='kimi')).toHaveLength(1);
 expect(zaiBudgetQuota(f.quotas.get(f.zai.id),Date.now())).toMatchObject({budgetReady:true,usage:{observedAt:epoch+180000}});
 await vi.advanceTimersByTimeAsync(30000);
 expect(f.calls.filter(x=>x.provider==='zai').map(x=>x.at)).toEqual([0,30000,180000,300000]);
 expect(f.calls.filter(x=>x.provider==='kimi').map(x=>x.at)).toEqual([0,300000]);
});

it('retains freshness margin with collector latency and last-start scheduling',async()=>{
 const f=await fixture({latency:20000});
 await vi.advanceTimersByTimeAsync(300000);
 expect(f.calls.filter(x=>x.provider==='zai').map(x=>x.at)).toEqual([0,140000,280000]);
 expect(f.calls.filter(x=>x.provider==='kimi').map(x=>x.at)).toEqual([0]);
 expect(zaiBudgetQuota(f.quotas.get(f.zai.id),Date.now()).budgetReady).toBe(true);
 await vi.advanceTimersByTimeAsync(60000);
 expect(f.calls.filter(x=>x.provider==='kimi').map(x=>x.at)).toEqual([0,360000]);
});

it('coalesces a forced check with the running collector and aborts without another pass',async()=>{
 const f=await fixture({pending:true});
 const forced=f.hub.refreshUsage(f.zai.id,true,true);const rejection=expect(forced).rejects.toBeDefined();
 await vi.advanceTimersByTimeAsync(60000);expect(f.calls).toHaveLength(2);
 f.controller.abort();await f.service;await rejection;
 await vi.advanceTimersByTimeAsync(600000);expect(f.calls).toHaveLength(2);
 expect(f.quotas.get(f.zai.id).zaiUsageEvidence).toBeUndefined();
});

it('retains ZAI busy refusal and stops future scheduler passes',async()=>{
 const f=await fixture();const flights=(f.hub as unknown as {inFlightByAccount:Map<string,number>}).inFlightByAccount;
 flights.set(f.zai.id,1);await expect(f.hub.refreshUsage(f.zai.id,true,true)).rejects.toThrow('занят');
 await vi.advanceTimersByTimeAsync(180000);expect(f.calls.filter(x=>x.provider==='zai')).toHaveLength(1);
 flights.clear();f.controller.abort();await f.service;const count=f.calls.length;
 await vi.advanceTimersByTimeAsync(600000);expect(f.calls).toHaveLength(count);
});
