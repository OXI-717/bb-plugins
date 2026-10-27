import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { AccountStore, QuotaStore, QUOTA_MIGRATIONS } from './store.js';
import { zaiEvidenceFromUsages, zaiBudgetQuota, ZAI_BUDGET_MAX_AGE_MS } from './zai-budget.js';
import { zaiQuotaFromUsages } from './openai-compatible-usage.js';
import { createOpenAiCompatibleAdapter } from './openai-compatible-adapter.js';
import { quotaFromHeaders } from './quota.js';
import { createAccountPoolPlugin } from './server.js';
import { AccountPoolHub } from './hub.js';

const id='11111111-1111-4111-8111-111111111111',now=1900000000000;
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close();});
function store(){const db=new Database(':memory:');for(const sql of QUOTA_MIGRATIONS)db.exec(sql);cleanup.push(()=>{db.close();});return new QuotaStore(db);}
function payload(){return {code:200,success:true,data:{limits:[
  {type:'TOKENS_LIMIT',unit:6,percentage:14,nextResetTime:now+86400000},
  {type:'TOKENS_LIMIT',unit:3,percentage:1,nextResetTime:now+3600000},
  {type:'TIME_LIMIT',unit:5,percentage:99},
]}};}
function complete(){const quotas=store();return zaiQuotaFromUsages(id,payload(),quotas.get(id),now)!;}

it('derives strict unit-based proof from the existing payload, never from normalized cache or reset ordering',()=>{
 const q=complete();expect(zaiBudgetQuota(q,now)).toMatchObject({budgetReady:true,usage:{source:'usage',observedAt:now,complete:true},
  windows:{fiveHour:{state:'present',remainingPercent:99,resetAt:now+3600000},weekly:{state:'present',remainingPercent:86,resetAt:now+86400000}}});
 expect(zaiBudgetQuota({...q,zaiUsageEvidence:undefined},now)).toMatchObject({budgetReady:false,windows:{fiveHour:{state:'unknown'},weekly:{state:'unknown'}}});
 const p=payload();p.data.limits[0]!.nextResetTime=now+1000;expect(zaiEvidenceFromUsages(p,now)?.weekly.resetAt).toBe(now+1000);
 const strings=JSON.parse(JSON.stringify(payload()));strings.data.limits[0].percentage='14.5';strings.data.limits[0].nextResetTime=String(now+86400000);
 expect(zaiEvidenceFromUsages(strings,now)?.weekly.usedPercent).toBe(14.5);
});

it.each(['missing','partial','duplicate','unknown-unit','string-unit','negative','over100','boolean','empty','NaN','Infinity','hex','missing-percent','missing-reset','empty-reset','oversized-reset','expired','fractional-reset','seconds-reset','boolean-reset','refused','error-code'] as const)('refuses %s raw evidence before legacy normalization',kind=>{
 const p:any=payload();
 if(kind==='missing')delete p.data;
 if(kind==='partial')p.data.limits.splice(1,1);
 if(kind==='duplicate')p.data.limits.push({...p.data.limits[1]});
 if(kind==='unknown-unit')p.data.limits.push({...p.data.limits[1],unit:8});
 if(kind==='string-unit')p.data.limits[1].unit='3';
 if(kind==='negative')p.data.limits[1].percentage=-1;
 if(kind==='over100')p.data.limits[1].percentage=101;
 if(kind==='boolean')p.data.limits[1].percentage=true;
 if(kind==='empty')p.data.limits[1].percentage='';
 if(kind==='NaN')p.data.limits[1].percentage=NaN;
 if(kind==='Infinity')p.data.limits[1].percentage=Infinity;
 if(kind==='hex')p.data.limits[1].percentage='0x10';
 if(kind==='missing-percent')delete p.data.limits[1].percentage;
 if(kind==='missing-reset')delete p.data.limits[1].nextResetTime;
 if(kind==='empty-reset')p.data.limits[1].nextResetTime='';
 if(kind==='oversized-reset')p.data.limits[1].nextResetTime=Number.MAX_SAFE_INTEGER+1;
 if(kind==='expired')p.data.limits[1].nextResetTime=now;
 if(kind==='fractional-reset')p.data.limits[1].nextResetTime=now+1.5;
 if(kind==='seconds-reset')p.data.limits[1].nextResetTime=(now+3600000)/1000;
 if(kind==='boolean-reset')p.data.limits[1].nextResetTime=true;
 if(kind==='refused')p.success=false;
 if(kind==='error-code')p.code=401;
 expect(zaiEvidenceFromUsages(p,now)).toBeUndefined();
 const prior=complete(),q=zaiQuotaFromUsages(id,p,prior,now+1);
 if(q)expect(zaiBudgetQuota(q,now+1).budgetReady).toBe(false);
});

it.each(['stale','future','expired','error','malformed'] as const)('cached %s proof fails closed without invented absence',kind=>{
 const q=complete();
 if(kind==='stale')q.zaiUsageEvidence!.observedAt=now-ZAI_BUDGET_MAX_AGE_MS-1;
 if(kind==='future')q.zaiUsageEvidence!.observedAt=now+1;
 if(kind==='expired')q.zaiUsageEvidence!.weekly.resetAt=now;
 if(kind==='error')q.error='synthetic unavailable';
 if(kind==='malformed')q.zaiUsageEvidence!.fiveHour.usedPercent=101;
 expect(zaiBudgetQuota(q,now)).toMatchObject({budgetReady:false,windows:{fiveHour:{state:'unknown',remainingPercent:null},weekly:{state:'unknown',remainingPercent:null}}});
});

it('preserves proof through ordinary inference without renewing its age and invalidates actual quota-header changes',()=>{
 const q=complete();const ordinary=quotaFromHeaders(id,new Headers({'content-type':'text/event-stream'}),q,'other',now+1000);
 expect(ordinary.zaiUsageEvidence).toBe(q.zaiUsageEvidence);
 expect(zaiBudgetQuota(ordinary,now+ZAI_BUDGET_MAX_AGE_MS+1).budgetReady).toBe(false);
 const changed=quotaFromHeaders(id,new Headers({'anthropic-ratelimit-unified-5h-utilization':'0.2'}),q,'other',now+1000);
 expect(changed.zaiUsageEvidence).toBeUndefined();
});

it('migrates old normalized rows as unknown and persists only new source proof through reopen',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zai-proof-'));cleanup.push(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'quota.db');
 let db=new Database(file);for(const sql of QUOTA_MIGRATIONS.slice(0,-1))db.exec(sql);
 db.prepare("INSERT INTO account_quota(account_id,bucket_exhaustion_json,five_hour_utilization,seven_day_utilization,observed_at) VALUES (?, '{}', 0.01, 0.14, ?)").run(id,now);
 db.exec(QUOTA_MIGRATIONS.at(-1)!);let quotas=new QuotaStore(db);
 expect(zaiBudgetQuota(quotas.get(id),now).budgetReady).toBe(false);
 quotas.put(complete());db.close();db=new Database(file);cleanup.push(()=>{db.close();});quotas=new QuotaStore(db);
 expect(zaiBudgetQuota(quotas.get(id),now).budgetReady).toBe(true);
});

it('uses the existing collector once and clears old strict proof on malformed or partial payloads',async()=>{
 const quotas=store();quotas.put(complete());
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json({data:{limits:[]}}));
 const adapter=createOpenAiCompatibleAdapter({provider:'zai',upstreamName:'Synthetic',mountPrefix:'zai/',upstreamBaseUrl:()=> 'https://upstream.example',usagesUrl:'https://usage.example',parseUsages:zaiQuotaFromUsages});
 const context={account:{id},freshSecret:async()=>({kind:'api-key',apiKey:'synthetic-private-key'}),quotas,fetch,now:()=>now+1} as unknown as Parameters<NonNullable<typeof adapter.refreshUsage>>[0];
 await adapter.refreshUsage!(context);expect(fetch).toHaveBeenCalledTimes(1);expect(quotas.get(id).zaiUsageEvidence).toBeUndefined();
 expect(quotas.get(id).fiveHourUtilization).toBe(0.01);
 fetch.mockImplementationOnce(async()=>Response.json(payload()));await adapter.refreshUsage!(context);
 expect(fetch).toHaveBeenCalledTimes(2);expect(zaiBudgetQuota(quotas.get(id),now+1).budgetReady).toBe(true);
 fetch.mockImplementationOnce(async()=>Response.json({data:{limits:[payload().data.limits[1]]}}));await adapter.refreshUsage!(context);
 expect(quotas.get(id).zaiUsageEvidence).toBeUndefined();
});

it('attests the actual project/purpose selectable set read-only, including unknown and held accounts, without upstream calls',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'zai-budget-route-'));cleanup.push(()=>fs.rm(dataDir,{recursive:true,force:true}));let clock=now;
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>{throw Error('Unexpected synthetic upstream');});
 const host=createFakePluginHost({pluginId:'account-pool-balanced',dataDir,sdk:{hosts:{list:async()=>[{id:'fixture-host',name:'Fixture'}]},system:{providerStates:async()=>({providers:[]})}}});cleanup.push(()=>host.harness.lifecycle.dispose());
 await host.bb.storage.kv.set('config',{vpnOnlyProviders:[],vpnPolicyVersion:2});
 await createAccountPoolPlugin({fetch,fetchIpv4:fetch,now:()=>clock})(host.bb);
 const service=host.harness.behavior.runService('hub');cleanup.push(async()=>{service.controller.abort();await service.done;});await new Promise(resolve=>setImmediate(resolve));
 const secretDir=path.join(dataDir,'plugins',host.bb.pluginId,'secrets','accounts');const accounts=new AccountStore(host.bb.storage.kv,secretDir);
 const add=()=>accounts.add({provider:'zai',kind:'api-key',label:'Synthetic',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true,autopilotAllowed:true,priority:100},{kind:'api-key',apiKey:'synthetic-provider-key'});
 const first=await add(),second=await add(),foreign=await add();
 await accounts.setProjects(foreign.id,{onlySelected:true,rules:[{projectId:'other-project',role:'inherit'}]});
 const quotas=new QuotaStore(host.bb.storage.database());quotas.put({...complete(),accountId:first.id});
 const clientFile=path.join(dataDir,'purpose.token');
 const issued=await host.harness.behavior.runCli(['client','add','fixture','--project','project-one','--purpose','autopilot','--output',clientFile]);expect(issued.exitCode).toBe(0);
 const token=(await fs.readFile(clientFile,'utf8')).trim();
 const unboundFile=path.join(dataDir,'unbound.token');expect((await host.harness.behavior.runCli(['client','add','unbound','--output',unboundFile])).exitCode).toBe(0);const unbound=(await fs.readFile(unboundFile,'utf8')).trim();
 const snapshot=async()=>Object.fromEntries(await Promise.all((await fs.readdir(secretDir)).filter(n=>n.endsWith('.json')).map(async n=>[n,await fs.readFile(path.join(secretDir,n),'utf8')])));
 const authBefore=await snapshot(),inventory=await accounts.list();
 const read=(key=token,query='')=>host.harness.behavior.fetchHttp('GET','/budget/zai'+query,{headers:{authorization:`Bearer ${key}`}});
 expect((await read('invalid')).status).toBe(401);expect((await read(unbound)).status).toBe(403);expect((await read(token,'?projectId=other-project')).status).toBe(403);
 const response=await read();expect(response.headers.get('cache-control')).toBe('no-store');const body=await response.json();
 expect(body).toMatchObject({schema:'bb-account-pool/zai-budget/1',projectId:'project-one',purpose:'autopilot',maxAgeMs:300000,
  route:{provider:'zai',path:'/zai/v1/chat/completions',ready:true,networkAllowed:true},accounts:[{accountId:first.id,eligible:true,budgetReady:true},{accountId:second.id,eligible:true,budgetReady:false}]});
 expect(body.accounts).toHaveLength(2);expect(JSON.stringify(body)).not.toMatch(/synthetic|email|label|provider-key/);expect(JSON.stringify(body)).not.toContain(token);expect(JSON.stringify(body)).not.toContain(foreign.id);
 clock+=60001;await read();expect(await snapshot()).toEqual(authBefore);expect(await accounts.list()).toEqual(inventory);clock=now;
 quotas.put({...quotas.get(first.id),heldUntil:now+30000});expect(await (await read()).json()).toMatchObject({accounts:[{eligible:true,budgetReady:false},{}]});quotas.put({...complete(),accountId:first.id});
 await accounts.setEnabled(first.id,false);expect(await (await read()).json()).toMatchObject({accounts:[{eligible:false},{}]});await accounts.setEnabled(first.id,true);
 await accounts.setCap(first.id,{early:0.1,late:0.1});expect(await (await read()).json()).toMatchObject({accounts:[{eligible:false},{}]});await accounts.setCap(first.id,null);
 await accounts.setPolicy(first.id,{enabled:true,fiveHourKeep:null,weeklyKeep:null,reserveDrainHours:null,schedule:{timeZone:'UTC',intervals:[]}});expect(await (await read()).json()).toMatchObject({accounts:[{eligible:false},{}]});await accounts.setPolicy(first.id,undefined);
 await accounts.setRole(first.id,'reserve');quotas.put({...quotas.get(first.id),sevenDayResetAt:now+7*86400000,sevenDayUtilization:0.95});expect(await (await read()).json()).toMatchObject({accounts:[{eligible:false},{}]});await accounts.setRole(first.id,'primary');quotas.put({...complete(),accountId:first.id});
 await accounts.setDrainOnce(first.id,true);await accounts.setAutopilotAllowed(first.id,false,true);expect(await (await read()).json()).toMatchObject({accounts:[{eligible:false},{}]});await accounts.setDrainOnce(first.id,false);await accounts.setAutopilotAllowed(first.id,true,false);
 await host.harness.behavior.callRpc('routing.set',{provider:'zai',enabled:false});expect(await (await read()).json()).toMatchObject({route:{ready:false},accounts:[{eligible:false},{}]});await host.harness.behavior.callRpc('routing.set',{provider:'zai',enabled:true});
 const network=vi.spyOn(AccountPoolHub.prototype,'assertNetworkAllowed').mockRejectedValueOnce(Error('synthetic-private-network'));
 expect(await (await read()).json()).toMatchObject({route:{ready:false,networkAllowed:false}});network.mockRestore();
 const failure=vi.spyOn(AccountStore.prototype,'list').mockRejectedValueOnce(Error('synthetic-private-failure'));
 const error=await read();expect(error.status).toBe(503);expect(await error.text()).not.toMatch(/synthetic|failure/);failure.mockRestore();
 const env=await host.harness.behavior.resolveProviderEnv('acp-opencode-zai',{hostId:'fixture-host',threadId:'fixture-thread',projectId:'project-one'});
 const threadToken=env.find(value=>value.name==='ZAI_API_KEY')!.value as string;
 await host.harness.behavior.callRpc('bypass.set',{threadId:'fixture-thread',bypassed:true});
 expect(await (await read(threadToken)).json()).toMatchObject({route:{ready:false,threadBypassed:true}});
 service.controller.abort();await service.done;expect(await (await read()).json()).toMatchObject({route:{accepting:false,ready:false}});
 expect(fetch).not.toHaveBeenCalled();
});
