import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {AccountStore,QuotaStore,QUOTA_MIGRATIONS} from './store.js';
import {providerEvidenceFromUsage as evidence,providerBudgetQuota as budget,ADDITIONAL_BUDGET_PROVIDERS,PROVIDER_BUDGET_MAX_AGE_MS} from './provider-budget.js';
import {quotaFromUsage} from './usage.js';
import {kimiQuotaFromUsages} from './kimi-usage.js';
import {opencodeGoQuotaFromUsages} from './openai-compatible-usage.js';
import {quotaFromHeaders} from './quota.js';
import {createAccountPoolPlugin} from './server.js';
import {createKimiAdapter} from './kimi-adapter.js';
import {createAgyAdapter} from './agy-adapter.js';
import type {PoolProvider,AccountQuota} from './contracts.js';
const now=1900000000000,id='11111111-1111-4111-8111-111111111111',reset=now+3600000;
const cleanup:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const f of cleanup.splice(0).reverse())await f();});
function store(){const db=new Database(':memory:');for(const sql of QUOTA_MIGRATIONS)db.exec(sql);cleanup.push(()=>db.close());return new QuotaStore(db);}
function payload(p:PoolProvider):any {
 if(p==='neuraldeep')return {key:{status:'ok'},decision:{can_request:true},chat:{cooldown_sec:0,session:{limit:100,remaining:75},week:{limit:1000,remaining:600}}};
 if(p==='agy')return {groups:[{displayName:'Gemini Models',buckets:[{displayName:'Weekly Limit Remaining',remainingFraction:0.7,resetTime:reset}]},{displayName:'Claude and GPT models',buckets:[{displayName:'Weekly Limit Remaining',remainingFraction:0.8,resetTime:reset}]}]};
 if(p==='claude')return {five_hour:{utilization:20,resets_at:reset},seven_day:{utilization:30,resets_at:reset}};
 if(p==='kimi')return {usage:{limit:100,used:30,remaining:70,resetTime:reset},limits:[{window:{duration:300,timeUnit:'TIME_UNIT_MINUTE'},detail:{limit:100,used:20,remaining:80,resetTime:reset}}]};
 if(p==='opencode-go')return {usage:{rolling:{percent:20,resetsAt:reset},weekly:{percent:30,resetsAt:reset},monthly:{percent:40,resetsAt:reset}}};
 return {billingCycleEnd:reset,planUsage:{totalPercentUsed:40}};
}
function complete(p:PoolProvider):AccountQuota{return {...store().get(id),providerBudgetEvidence:evidence(p,payload(p),now)};}
it.each(['claude','kimi','opencode-go','cursor'] as const)('%s exposes source windows, refuses legacy/future/stale/error/held proof, and preserves age under neutral headers',p=>{
 const q=complete(p);expect(budget(p,q,now)).toMatchObject({supported:true,budgetReady:true,usage:{source:'usage',complete:true,observedAt:now}});
 for(const [value,clock] of [[{...q,providerBudgetEvidence:undefined},now],[q,now+PROVIDER_BUDGET_MAX_AGE_MS+1],[q,now-1],[{...q,error:'synthetic'},now],[{...q,heldUntil:now+1},now]] as const)expect(budget(p,value,clock).budgetReady).toBe(false);
 expect(budget('devin',q,now).budgetReady).toBe(false);
 expect(quotaFromHeaders(id,new Headers(),q,'other',now+100).providerBudgetEvidence?.observedAt).toBe(now);
 expect(quotaFromHeaders(id,new Headers({'anthropic-ratelimit-unified-5h-utilization':'0.7'}),q,'other',now+100).providerBudgetEvidence).toBeUndefined();
});
it.each(['claude','kimi','opencode-go','cursor'] as const)('%s refuses malformed and partial raw evidence before normalization',p=>{
 for(const bad of ['',true,'0x10',-1,101,NaN,Infinity,null,undefined]){
  const v=payload(p);
  if(p==='claude')v.five_hour.utilization=bad;
  if(p==='kimi'){v.usage.used=bad;delete v.usage.remaining;}
  if(p==='opencode-go')v.usage.monthly.percent=bad;
  if(p==='cursor')v.planUsage.totalPercentUsed=bad;
  expect(evidence(p,v,now),String(bad)).toBeUndefined();
 }
 const v=payload(p);
 if(p==='claude')delete v.seven_day;
 if(p==='kimi')v.limits.push(v.limits[0]);
 if(p==='opencode-go')delete v.usage.monthly;
 if(p==='cursor')v.billingCycleEnd=now;
 expect(evidence(p,v,now)).toBeUndefined();
});
it('retains actual rolling and billing semantics, not fake 5h/week windows',()=>{
 const v=payload('kimi');v.limits[0].window.duration=120;
 expect(evidence('kimi',v,now)?.windows.map(w=>w.id)).toEqual(['weekly','rolling:120']);
 expect(evidence('cursor',payload('cursor'),now)?.windows).toEqual([{id:'billingCycle',remainingPercent:60,resetAt:reset,durationMinutes:null}]);
});
it('persists new collector proof; old normalized rows remain unknown',()=>{
 const q=store();expect(q.get(id).providerBudgetEvidence).toBeUndefined();
 for(const [p,parse] of [['claude',quotaFromUsage],['kimi',kimiQuotaFromUsages],['opencode-go',opencodeGoQuotaFromUsages]] as const){q.put(parse(id,payload(p),q.get(id),now)!);expect(budget(p,q.get(id),now).budgetReady).toBe(true);}
 q.put({...q.get(id),providerBudgetEvidence:undefined});expect(q.get(id).providerBudgetEvidence).toBeUndefined();
});
it('failed collection invalidates proof with one existing call and preserves old utilization',async()=>{
 const quotas=store();quotas.put({...complete('kimi'),fiveHourUtilization:0.2});const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(null,{status:503}));
 await createKimiAdapter({usagesUrl:'https://usage.example'}).refreshUsage({account:{id},freshSecret:async()=>({kind:'api-key',apiKey:'synthetic-private'}),quotas,fetch,now:()=>now+1} as any);
 expect(fetch).toHaveBeenCalledTimes(1);expect(quotas.get(id).fiveHourUtilization).toBe(0.2);expect(quotas.get(id).providerBudgetEvidence).toBeUndefined();
});
it.each(['devin'] as const)('%s cannot inherit another provider proof',p=>{
 expect(budget(p,{...complete('claude'),fiveHourUtilization:0,sevenDayUtilization:0},now)).toMatchObject({supported:false,budgetReady:false,reason:'unsupported-numeric-evidence',windows:[]});
});
it('all cached endpoints enforce project/purpose and keep unknown eligible accounts visible without upstream calls',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'provider-budget-'));cleanup.push(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>{throw Error('unexpected upstream');});
 const host=createFakePluginHost({pluginId:'account-pool-balanced',dataDir,sdk:{hosts:{list:async()=>[{id:'fixture-host',name:'Fixture'}]},system:{providerStates:async()=>({providers:[]})}}});cleanup.push(()=>host.harness.lifecycle.dispose());
 await host.bb.storage.kv.set('config',{vpnOnlyProviders:[],vpnPolicyVersion:2});await createAccountPoolPlugin({fetch,fetchIpv4:fetch,now:()=>now})(host.bb);
 const service=host.harness.behavior.runService('hub');cleanup.push(async()=>{service.controller.abort();await service.done;});await new Promise(r=>setImmediate(r));
 const accounts=new AccountStore(host.bb.storage.kv,path.join(dataDir,'plugins',host.bb.pluginId,'secrets','accounts')),quotas=new QuotaStore(host.bb.storage.database());
 for(const p of ADDITIONAL_BUDGET_PROVIDERS){
  const add=()=>accounts.add({provider:p,kind:'api-key',label:'Private synthetic label',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true,autopilotAllowed:true,priority:100},{kind:'api-key',apiKey:'synthetic-private'});
  const first=await add(),unknown=await add(),foreign=await add(),notOpted=await add();
  await accounts.setProjects(foreign.id,{onlySelected:true,rules:[{projectId:'foreign',role:'inherit'}]});await accounts.setAutopilotAllowed(notOpted.id,false,true);
  quotas.put({...quotas.get(first.id),providerBudgetEvidence:evidence(p,payload(p),now)});
  const out=path.join(dataDir,p+'.token');expect((await host.harness.behavior.runCli(['client','add',p,'--project','project-one','--purpose','autopilot','--output',out])).exitCode).toBe(0);const token=(await fs.readFile(out,'utf8')).trim();
  const read=(key=token,query='')=>host.harness.behavior.fetchHttp('GET','/budget/'+p+query,{headers:{authorization:'Bearer '+key}});
  expect((await read('invalid')).status).toBe(401);expect((await read(token,'?projectId=foreign')).status).toBe(403);
  const noSecret=vi.spyOn(AccountStore.prototype,'readSecret').mockRejectedValue(Error('unexpected credential read'));
  const response=await read(),body=await response.json();expect(response.headers.get('cache-control')).toBe('no-store');
  expect(body).toMatchObject({schema:'bb-account-pool/provider-budget/1',eligibilityScope:'shared-policy-superset',provider:p,projectId:'project-one',purpose:'autopilot',accounts:[{accountId:first.id,eligible:true},{accountId:unknown.id,eligible:true,budgetReady:false},{accountId:notOpted.id,eligible:false}]});
  expect(noSecret).not.toHaveBeenCalled();noSecret.mockRestore();
  expect(body.accounts[0].budgetReady).toBe(p!=='devin');
  expect(body.accounts).toHaveLength(3);expect(JSON.stringify(body)).not.toContain(foreign.id);expect(JSON.stringify(body)).not.toMatch(/synthetic|Private|apiKey/);expect(JSON.stringify(body)).not.toContain(token);
 }
 expect(fetch).not.toHaveBeenCalled();
});

it('AGY preserves all quota groups and refuses partial, duplicate, disabled or absolute-only buckets',()=>{
 const good=payload('agy');const proof=evidence('agy',good,now)!;
 expect(proof.windows.map(w=>Math.round(w.remainingPercent))).toEqual([70,80]);expect(proof.windows.every(w=>w.id.startsWith('group:')&&w.durationMinutes===null)).toBe(true);
 for(const change of ['empty','duplicate','missing-reset','expired','disabled','missing-fraction','absolute-only','negative','above-one','boolean','empty-percent']){
  const v=payload('agy'),b=v.groups[0].buckets[0];
  if(change==='empty')v.groups=[];
  if(change==='duplicate')v.groups.push(v.groups[0]);
  if(change==='missing-reset')delete b.resetTime;
  if(change==='expired')b.resetTime=now;
  if(change==='disabled')b.disabled=true;
  if(change==='missing-fraction')delete b.remainingFraction;
  if(change==='absolute-only'){delete b.remainingFraction;b.remainingAmount=100;}
  if(change==='negative')b.remainingFraction=-1;
  if(change==='above-one')b.remainingFraction=1.01;
  if(change==='boolean')b.remainingFraction=true;
  if(change==='empty-percent')b.remainingFraction='';
  expect(evidence('agy',v,now),change).toBeUndefined();
 }
});
it('AGY existing scheduler collector uses only server-bound subscription and guarded transport, once; failures revoke proof',async()=>{
 const quotas=store(),adapter=createAgyAdapter();
 const secret={kind:'oauth',accessToken:'synthetic-google-access',refreshToken:'synthetic-google-refresh',expiresAt:now+3600000,agy:{clientId:'synthetic-app',clientSecret:'synthetic-app-secret',projectId:'synthetic-subscription',endpoint:'https://daily-cloudcode-pa.googleapis.com'}};
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json(payload('agy')));
 const context={account:{id},freshSecret:async()=>secret,quotas,fetch,now:()=>now} as any;
 await adapter.refreshUsage(context);expect(fetch).toHaveBeenCalledTimes(1);
 expect(fetch.mock.calls[0]?.[0]).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
 expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({project:'synthetic-subscription'});
 expect(budget('agy',quotas.get(id),now)).toMatchObject({supported:true,budgetReady:true,coverage:'all-reported-quota-groups'});
 fetch.mockImplementationOnce(async()=>new Response(null,{status:503}));await adapter.refreshUsage(context);
 expect(fetch).toHaveBeenCalledTimes(2);expect(budget('agy',quotas.get(id),now).budgetReady).toBe(false);
});

it('NeuralDeep retains native session/week ratios and provider decision without fabricating reset timestamps',()=>{
 const v=payload('neuraldeep'),proof=evidence('neuraldeep',v,now)!;
 expect(proof.windows).toEqual([{id:'session',remainingPercent:75,resetAt:null,durationMinutes:null},{id:'weekly',remainingPercent:60,resetAt:null,durationMinutes:10080}]);
 expect(budget('neuraldeep',{...store().get(id),providerBudgetEvidence:proof},now)).toMatchObject({budgetReady:true,providerAllowed:true});
 for(const kind of ['missing','denied','cooldown','key','boolean','over-limit','negative','missing-week']){
  const q=payload('neuraldeep');
  if(kind==='missing')delete q.decision.can_request;
  if(kind==='denied')q.decision.can_request=false;
  if(kind==='cooldown')q.chat.cooldown_sec=10;
  if(kind==='key')q.key.status='disabled';
  if(kind==='boolean')q.chat.session.remaining=true;
  if(kind==='over-limit')q.chat.session.remaining=101;
  if(kind==='negative')q.chat.session.remaining=-1;
  if(kind==='missing-week')delete q.chat.week;
  expect(budget('neuraldeep',{...store().get(id),providerBudgetEvidence:evidence('neuraldeep',q,now)},now).budgetReady,kind).toBe(false);
 }
});
it('actual existing NeuralDeep collector stores numeric evidence and cached reads do not repeat it',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'neuraldeep-budget-'));cleanup.push(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json(payload('neuraldeep')));
 const host=createFakePluginHost({pluginId:'account-pool-balanced',dataDir,sdk:{hosts:{list:async()=>[{id:'fixture-host',name:'Fixture'}]},system:{providerStates:async()=>({providers:[]})}}});cleanup.push(()=>host.harness.lifecycle.dispose());
 await host.bb.storage.kv.set('config',{vpnOnlyProviders:[],vpnPolicyVersion:2});await createAccountPoolPlugin({fetch,fetchIpv4:fetch,now:()=>now})(host.bb);
 const service=host.harness.behavior.runService('hub');cleanup.push(async()=>{service.controller.abort();await service.done;});await new Promise(r=>setImmediate(r));
 const accounts=new AccountStore(host.bb.storage.kv,path.join(dataDir,'plugins',host.bb.pluginId,'secrets','accounts'));
 const account=await accounts.add({provider:'neuraldeep',kind:'api-key',label:'Synthetic',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true,priority:100},{kind:'api-key',apiKey:'synthetic-private'});
 expect((await host.harness.behavior.runCli(['account','refresh',account.id])).exitCode).toBe(0);
 expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]?.[0]).toBe('https://api.neuraldeep.ru/v1/limits');
 const quotas=new QuotaStore(host.bb.storage.database());expect(budget('neuraldeep',quotas.get(account.id),now).budgetReady).toBe(true);
 expect(quotas.get(account.id).fiveHourUtilization).toBeNull();expect(quotas.get(account.id).sevenDayUtilization).toBeNull();
});

it('Claude rejection status cannot become positive numeric headroom, including scoped limits',()=>{
 for(const shape of ['five_hour','seven_day_sonnet','limits']){
  const make=(status:unknown)=>{const v=payload('claude');
   if(shape==='limits')v.limits=[{kind:'weekly_scoped',scope:{model:{display_name:'Claude Sonnet'}},percent:20,resets_at:reset,status}];
   else v[shape]={utilization:20,resets_at:reset,status};
   return v;
  };
  for(const status of ['rejected','rate-limited','unknown',true]){
   const proof=evidence('claude',make(status),now);
   expect(proof,shape+':'+String(status)).toBeUndefined();
   expect(budget('claude',{...store().get(id),providerBudgetEvidence:proof},now).budgetReady).toBe(false);
  }
  for(const status of ['allowed','ok',undefined])expect(evidence('claude',make(status),now),shape+':'+String(status)).toBeDefined();
 }
});

it.each(['rolling','weekly','monthly'] as const)('Go %s blocking or unknown status refuses strict proof through the existing collector',key=>{
 const previous=store().get(id);
 for(const status of ['rate-limited','rejected','allowed','unknown',true]){
  const v=payload('opencode-go');v.usage[key].status=status;
  const quota=opencodeGoQuotaFromUsages(id,v,previous,now)??previous;
  expect(quota.providerBudgetEvidence,String(status)).toBeUndefined();
  expect(budget('opencode-go',quota,now).budgetReady,String(status)).toBe(false);
 }
 for(const status of ['ok',null,undefined]){
  const v=payload('opencode-go');v.usage[key].status=status;
  const quota=opencodeGoQuotaFromUsages(id,v,previous,now)!;
  expect(budget('opencode-go',quota,now).budgetReady,String(status)).toBe(true);
 }
});

it('budget includes a Claude account selected by Sonnet despite a blocked other-family window',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'family-budget-'));cleanup.push(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json({id:'synthetic-message',type:'message',role:'assistant',content:[],usage:{input_tokens:1,output_tokens:1},stop_reason:'end_turn'}));
 const host=createFakePluginHost({pluginId:'account-pool-balanced',dataDir,sdk:{hosts:{list:async()=>[{id:'fixture-host',name:'Fixture'}]},system:{providerStates:async()=>({providers:[]})}}});cleanup.push(()=>host.harness.lifecycle.dispose());
 await host.bb.storage.kv.set('config',{vpnOnlyProviders:[],vpnPolicyVersion:2});await createAccountPoolPlugin({fetch,fetchIpv4:fetch,now:()=>now})(host.bb);
 const service=host.harness.behavior.runService('hub');cleanup.push(async()=>{service.controller.abort();await service.done;});await new Promise(r=>setImmediate(r));
 const accounts=new AccountStore(host.bb.storage.kv,path.join(dataDir,'plugins',host.bb.pluginId,'secrets','accounts')),quotas=new QuotaStore(host.bb.storage.database());
 const account=await accounts.add({provider:'claude',kind:'api-key',label:'Synthetic',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true,priority:100},{kind:'api-key',apiKey:'synthetic-private'});
 const previous=quotas.get(account.id);previous.familyWeekly.other={utilization:1,status:'rejected',resetAt:reset,source:'usage',observedAt:now};
 quotas.put(quotaFromUsage(account.id,payload('claude'),previous,now)!);
 const file=path.join(dataDir,'client.token');expect((await host.harness.behavior.runCli(['client','add','fixture','--project','project-one','--output',file])).exitCode).toBe(0);
 const headers={authorization:'Bearer '+(await fs.readFile(file,'utf8')).trim(),'content-type':'application/json'};
 const generation=await host.harness.behavior.fetchHttp('POST','/v1/messages',{headers,body:JSON.stringify({model:'claude-sonnet-4-5',max_tokens:1,messages:[{role:'user',content:'synthetic'}]})});
 expect(generation.status).toBe(200);await generation.text();expect(fetch).toHaveBeenCalledTimes(1);
 const snapshot=await (await host.harness.behavior.fetchHttp('GET','/budget/claude',{headers})).json();
 expect(snapshot.eligibilityScope).toBe('shared-policy-superset');
 expect(snapshot.accounts).toEqual([expect.objectContaining({accountId:account.id,eligible:true,budgetReady:true})]);
});
