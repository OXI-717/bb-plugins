import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MAX_BYTES, MAX_ROWS, TTL_MS, RequestJournal, newTrace } from './request-journal.js';
import { observeCodexQuotaHeaders } from './codex-quota-observation.js';
import { codexQuotaFromUsage, createCodexAdapter } from './codex-adapter.js';
import { EMPTY_FAMILY_WEEKLY } from './contracts.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'request-metadata-'));
 let now=1900000000000;const file=path.join(dir,'metadata','recent.json'),journal=new RequestJournal(file,()=>now);
 await journal.initialize();cleanups.push(async()=>{await journal.close();await fs.rm(dir,{recursive:true,force:true});});
 const trace=newTrace('codex','external-client-synthetic','proj_abcdef1234','thr_abcdef1234','gpt-6-astra','other');
 const event=(fields:object={})=>({...trace,at:now,attempt:0,event:'request',accountId:null,status:null,durationMs:null,inFlight:0,accountInFlight:0,retryAfterMs:null,retryAfterSupplied:null,quotaEvidence:null,holdSource:null,heldUntil:null,outcome:null,failover:null,errorClass:null,...fields});
 return {dir,file,journal,event,setNow:(v:number)=>{now=v;},now};
}
it('removes unrecognized fields and refuses arbitrary model/identity strings',async()=>{
 const f=await fixture();f.journal.record(f.event({prompt:'private synthetic prompt',authorization:'secret synthetic header'}));
 f.journal.record(f.event({model:'private-synthetic-model'}));
 const rows=f.journal.snapshot().rows;
 expect(rows).toHaveLength(1);expect(JSON.stringify(rows)).not.toMatch(/private|secret|external-client/);
 const unknown=newTrace('codex','external-client-synthetic','private-project','private-thread','private-model','other');
 expect(unknown).toMatchObject({projectId:null,threadId:null,model:null});
 expect(unknown.clientHash).toBe(f.event().clientHash);
});
it('records only fixed typed quota fields and actual before/after evidence without retaining private text',async()=>{
 const f=await fixture(),id='11111111-1111-4111-8111-111111111111';
 const previous=codexQuotaFromUsage(id,{rate_limit:{allowed:true,limit_reached:false,
  primary_window:{used_percent:20,limit_window_seconds:604800,reset_at:(f.now+86400000)/1000},secondary_window:null}},
  {accountId:id,fiveHourUtilization:null,fiveHourResetAt:null,fiveHourStatus:null,sevenDayUtilization:null,sevenDayResetAt:null,sevenDayStatus:null,representativeClaim:null,familyWeekly:EMPTY_FAMILY_WEEKLY,limitWindows:[],observedAt:null,heldUntil:null,error:null},f.now)!;
 const adapter=createCodexAdapter({refreshUrl:'https://auth.example/token',usageUrl:'https://usage.example/usage'});
 const headers=new Headers({'authorization':'private synthetic authorization','set-cookie':'private synthetic cookie','x-unlisted':'private synthetic header',
  'x-codex-primary-used-percent':'21','x-codex-primary-window-minutes':'10080','x-codex-primary-reset-at':String((f.now+86400000)/1000),
  'x-codex-primary-reset-after-seconds':'private synthetic invalid','x-codex-primary-over-limit':'FALSE',
  'x-codex-secondary-used-percent':'','x-codex-secondary-window-minutes':'0','x-codex-secondary-over-limit':'private synthetic invalid'});
 const next=adapter.quotaFromHeaders(id,headers,previous,'other',f.now+1);
 const diagnostic=observeCodexQuotaHeaders(headers,previous,next,f.now+1)!;
 expect(diagnostic).toEqual({primary:[21,10080,(f.now+86400000)/1000,'invalid',false],secondary:['empty',0,'missing','missing','invalid'],
  priorUsage:{observedAt:f.now,ageMs:1,primary:'present',secondary:'absent',allowed:true,limitReached:false},priorDurations:[10080,null],evidencePreserved:false});
 f.journal.record(f.event({event:'upstream',accountId:id,codexQuota:{...diagnostic,authorization:'private synthetic extra'}}));
 expect(f.journal.snapshot().rows[0].codexQuota).toEqual(diagnostic);
 expect(JSON.stringify(f.journal.snapshot())).not.toMatch(/private|authorization|cookie|x-unlisted/);
 const neutral=new Headers({'x-codex-primary-used-percent':'21'});
 const retained=adapter.quotaFromHeaders(id,neutral,previous,'other',f.now+1);
 expect(observeCodexQuotaHeaders(neutral,previous,retained,f.now+1)?.evidencePreserved).toBe(true);
 expect(observeCodexQuotaHeaders(neutral,next,next,f.now+2)?.priorUsage).toBeNull();
 const get=vi.spyOn(headers,'get').mockImplementation(()=>{throw Error('private synthetic accessor');});
 expect(observeCodexQuotaHeaders(headers,previous,next,f.now+1)).toBeUndefined();get.mockRestore();
 // The largest fixed diagnostic still fits the unchanged byte cap at full row retention.
 const large={...diagnostic,primary:[-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,true],
  secondary:[-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,false],
  priorUsage:{...diagnostic.priorUsage!,observedAt:Number.MAX_SAFE_INTEGER,ageMs:-Number.MAX_SAFE_INTEGER},priorDurations:[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER]};
 const row=f.event({event:'upstream',accountId:id,codexQuota:large,projectId:'proj_'+ 'a'.repeat(32),threadId:'thr_'+ 'a'.repeat(32),model:'claude-sonnet-4-6'});
 for(let i=0;i<MAX_ROWS;i++)f.journal.record(row);
 await f.journal.flush();expect((await fs.stat(f.file)).size).toBeLessThan(MAX_BYTES);
 expect(f.journal.snapshot().storageFailuresSinceStart).toBe(0);
});
it('counts logical requests, attempts and three origins separately',async()=>{
 const f=await fixture();
 for(const fields of [{},{event:'attempt',attempt:1},{event:'upstream',attempt:1,status:429},{event:'attempt',attempt:2},{event:'upstream',attempt:2,status:200},{event:'local-held',status:429},{event:'hold',holdSource:'upstream403',status:403}]) f.journal.record(f.event(fields));
 expect(f.journal.snapshot().minutes).toEqual([{at:Math.floor(f.now/60000)*60000,logicalRequests:1,attempts:2,upstream429:1,localHeld429:1,upstream403Holds:1}]);
});
it('caps rows and ages out metadata, with honest retained-only coverage',async()=>{
 const f=await fixture();for(let i=0;i<MAX_ROWS+7;i++)f.journal.record(f.event());
 expect(f.journal.snapshot()).toMatchObject({coverage:'retained-events-only',truncated:true,evictedSinceStart:7});
 expect(f.journal.snapshot().rows).toHaveLength(MAX_ROWS);
 await f.journal.flush();expect((await fs.stat(f.file)).size).toBeLessThan(MAX_BYTES);
 f.setNow(f.now+TTL_MS+1);expect(f.journal.snapshot().rows).toEqual([]);await f.journal.flush();
 expect(JSON.parse(await fs.readFile(f.file,'utf8')).rows).toEqual([]);
});
it('persists private sanitized snapshots and restores a bounded valid snapshot',async()=>{
 const f=await fixture();f.journal.record(f.event());await f.journal.flush();
 expect((await fs.stat(f.file)).mode&0o777).toBe(0o600);expect((await fs.stat(path.dirname(f.file))).mode&0o777).toBe(0o700);
 const restored=new RequestJournal(f.file,()=>f.now);await restored.initialize();expect(restored.snapshot().rows).toHaveLength(1);await restored.close();
});
it('does no storage I/O in record and stays bounded while a write is blocked',async()=>{
 const f=await fixture();let unblock!:()=>void;
 const write=vi.spyOn(fs,'writeFile').mockImplementationOnce(()=>new Promise<void>(resolve=>{unblock=resolve;}));
 f.journal.record(f.event());expect(write).not.toHaveBeenCalled();
 const flush=f.journal.flush();
 try {
  // Recent events and long-term counters each own at most one independent snapshot.
  expect(write).toHaveBeenCalledTimes(2);
  for(let i=0;i<MAX_ROWS+1;i++)f.journal.record(f.event());
  expect(f.journal.snapshot().rows).toHaveLength(MAX_ROWS);expect(write).toHaveBeenCalledTimes(2);
 } finally { unblock();await flush;write.mockRestore(); }
});
it('isolates write failures and refuses corrupt or oversized persisted metadata',async()=>{
 const f=await fixture();f.journal.record(f.event());
 const spy=vi.spyOn(fs,'writeFile').mockRejectedValueOnce(new Error('private synthetic failure'));
 await expect(f.journal.flush()).resolves.toBeUndefined();
 expect(f.journal.snapshot().storageFailuresSinceStart).toBe(1);expect(JSON.stringify(f.journal.snapshot())).not.toContain('private synthetic');spy.mockRestore();
 await fs.writeFile(f.file,'x'.repeat(MAX_BYTES+1));const restored=new RequestJournal(f.file,()=>f.now);await restored.initialize();
 expect(restored.snapshot().rows).toEqual([]);expect(restored.snapshot().storageFailuresSinceStart).toBe(1);await restored.close();
});

it('removes an abandoned temporary snapshot on startup without natural traffic',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'request-orphan-'));
 const file=path.join(dir,'recent.json');
 await fs.writeFile(file+'.tmp',JSON.stringify({rows:[{at:1,privateSynthetic:'old metadata'}]}),{mode:0o600});
 const journal=new RequestJournal(file,()=>1900000000000);await journal.initialize();
 try {
  expect(journal.snapshot().rows).toEqual([]);await journal.flush();
  await expect(fs.stat(file+'.tmp')).rejects.toMatchObject({code:'ENOENT'});
 } finally {await journal.close();await fs.rm(dir,{recursive:true,force:true});}
});
it('removes a temporary snapshot after rename failure and isolates cleanup failure',async()=>{
 const f=await fixture();f.journal.record(f.event());
 const originalRename=fs.rename;
 const rename=vi.spyOn(fs,'rename').mockImplementation((from,to)=>String(from)===f.file+'.tmp'?Promise.reject(new Error('synthetic rename failure')):originalRename(from,to));
 await f.journal.flush();await expect(fs.stat(f.file+'.tmp')).rejects.toMatchObject({code:'ENOENT'});
 expect(f.journal.snapshot().storageFailuresSinceStart).toBe(1);rename.mockRestore();
 const originalRemove=fs.rm;
 const remove=vi.spyOn(fs,'rm').mockImplementation((file,options)=>String(file)===f.file+'.tmp'?Promise.reject(new Error('synthetic cleanup failure')):originalRemove(file,options));
 const restored=new RequestJournal(f.file,()=>f.now);await expect(restored.initialize()).resolves.toBeUndefined();
 expect(restored.snapshot().storageFailuresSinceStart).toBe(1);await restored.close();remove.mockRestore();
});

it('bounds returned pages while aggregating every retained provider/account without double counting',async()=>{
 const f=await fixture(),id='11111111-1111-4111-8111-111111111111';
 for(let i=0;i<500;i++)f.journal.record(f.event({event:'upstream',accountId:id,status:i<3?429:200,accountInFlight:2}));
 f.journal.record(f.event({provider:'claude',event:'upstream',status:429}));
 f.journal.record(f.event({event:'hold',accountId:id,status:429,holdSource:'upstream429'}));
 const page=f.journal.snapshot(100);expect(page.rows).toHaveLength(100);
 expect(page).toMatchObject({totalRetainedRows:502,rowsTruncated:true,coverage:'retained-events-only'});
 expect(page.providers).toEqual(expect.arrayContaining([
  expect.objectContaining({provider:'codex',upstream429:3,accounts:[expect.objectContaining({accountId:id,upstream429:3,peakInFlight:2})]}),
  expect.objectContaining({provider:'claude',upstream429:1})]));
 expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(200_000);
});
it('summarizes Guard separately from upstream errors across all retained rows',async()=>{
 const f=await fixture();f.journal.record(f.event({event:'guard-check',guardOutcome:'timeout',guardPhase:'before-dispatch',durationMs:4000,rawError:'private token'}));
 f.journal.record(f.event({event:'upstream',status:503}));
 const result=f.journal.snapshot(1);expect(result.guardChecks.find(r=>r.provider==='codex')).toMatchObject({checks:1,timeouts:1,durationMs:4000,lastTimeoutAt:f.now});
 expect(result.rows).toHaveLength(1);expect(JSON.stringify(result)).not.toContain('private token');
});
