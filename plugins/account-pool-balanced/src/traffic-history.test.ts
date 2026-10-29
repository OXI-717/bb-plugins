import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RequestJournal, newTrace, type Observation, MAX_ROWS } from './request-journal.js';
import { TrafficHistory, HOUR_MS, HISTORY_MAX_ROWS, HISTORY_MAX_BYTES, HISTORY_TTL_MS } from './traffic-history.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const c of cleanups.splice(0).reverse()) await c(); });
async function fixture() {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(),'traffic-history-'));
 let now = 1900000000000;
 const file = path.join(dir,'history.json'), history = new TrafficHistory(file,()=>now);
 await history.initialize(); cleanups.push(()=>fs.rm(dir,{recursive:true,force:true}));
 const trace = newTrace('codex','host_synthetic123','proj_abcdef1234','thr_abcdef1234','gpt-6-sol','other');
 const event = (f: Partial<Observation> = {}): Observation => ({...trace,at:now,event:'request',attempt:0,accountId:null,status:null,durationMs:null,
  inFlight:0,accountInFlight:0,retryAfterMs:null,retryAfterSupplied:null,quotaEvidence:null,holdSource:null,heldUntil:null,outcome:null,failover:null,errorClass:null,...f});
 return {dir,file,history,event,now,setNow:(v:number)=>{now=v;},clock:()=>now};
}
const account = '11111111-1111-4111-8111-111111111111';
it('retains logical starts and selected-account dispatch metrics independently of event-ring eviction', async()=>{
 const f=await fixture(),j=new RequestJournal(path.join(f.dir,'recent.json'),f.clock);await j.initialize();cleanups.push(()=>j.close());
 for(let i=0;i<MAX_ROWS+17;i++) {
  j.record(f.event());j.record(f.event({event:'attempt',attempt:1,accountId:account,accountInFlight:1}));
  j.record(f.event({event:'upstream',attempt:1,accountId:account,status:i<3?429:200,accountInFlight:2}));
  j.record(f.event({event:'stream-end',attempt:1,accountId:account,status:200,outcome:'complete',durationMs:2000}));
 }
 const out=j.snapshot();expect(out.rows).toHaveLength(MAX_ROWS);expect(out.truncated).toBe(true);
 expect(out.history.rows).toHaveLength(2);
 expect(out.history.rows.find(r=>r.accountId===null)).toMatchObject({requests:MAX_ROWS+17,attempts:0});
 expect(out.history.rows.find(r=>r.accountId===account)).toMatchObject({requests:0,attempts:MAX_ROWS+17,upstream429:3,peakAccountInFlight:2,streamMs:(MAX_ROWS+17)*2000});
 await j.flush();const restored=new RequestJournal(path.join(f.dir,'recent.json'),f.clock);await restored.initialize();cleanups.push(()=>restored.close());
 expect(restored.snapshot().history.rows).toEqual(out.history.rows);
});
it('separates provider/account/client/project buckets, retries, auth errors, queue failures and canceled streams',async()=>{
 const f=await fixture();
 for(const fields of [{},{event:'attempt',accountId:account},{event:'upstream',accountId:account,status:429},
  {event:'attempt',accountId:account},{event:'upstream',accountId:account,status:403},{event:'upstream',accountId:account,status:502},
  {event:'local-held',accountId:account,status:429},{event:'hold',accountId:account,status:429},
  {event:'queue-wait',accountId:account,status:503,durationMs:900},
  {event:'stream-end',accountId:account,outcome:'canceled',durationMs:1000},
  {event:'result',accountId:account,status:403}]) f.history.record(f.event(fields as Partial<Observation>));
 f.history.record(f.event({provider:'claude',accountId:account}));
 f.history.record(f.event({accountId:account,clientHash:'a'.repeat(24)}));
 f.history.record(f.event({accountId:account,projectId:'proj_other123'}));
 const rows=f.history.snapshot().rows;expect(rows).toHaveLength(5);
 expect(rows.find(r=>r.provider==='codex'&&r.accountId===account&&r.clientHash===f.event().clientHash&&r.projectId===f.event().projectId)).toMatchObject({requests:0,attempts:2,upstreamResponses:3,upstream429:1,upstreamAuthErrors:1,upstream5xx:1,localHeld429:1,queueWaits:1,queueFailures:1,queueWaitMs:900,streamEnds:1,streamCanceled:1,streamMs:1000});
});
it('expires full hour buckets without traffic and rejects future/backfilled events',async()=>{
 const f=await fixture();f.history.record(f.event());await f.history.flush();
 f.setNow(f.now+HISTORY_TTL_MS);expect(f.history.snapshot().rows).toEqual([]);
 f.history.record(f.event({at:f.now}));f.history.record(f.event({at:f.now+HISTORY_TTL_MS+1}));expect(f.history.snapshot().rows).toEqual([]);
 await f.history.flush();expect(JSON.parse(await fs.readFile(f.file,'utf8')).rows).toEqual([]);
});
it('bounds high-cardinality data, discloses omissions and keeps already admitted buckets accurate',async()=>{
 const f=await fixture();
 for(let i=0;i<HISTORY_MAX_ROWS+9;i++)f.history.record(f.event({clientHash:i.toString(16).padStart(24,'0')}));
 f.history.record(f.event({clientHash:'0'.repeat(24)}));
 expect(f.history.snapshot()).toMatchObject({truncated:true,capacityDroppedEvents:9});
 expect(f.history.snapshot().rows).toHaveLength(HISTORY_MAX_ROWS);
 expect(f.history.snapshot().rows[0].requests).toBe(2);
 await f.history.flush();expect((await fs.stat(f.file)).size).toBeLessThan(HISTORY_MAX_BYTES);
 f.setNow(f.now+HOUR_MS);f.history.record(f.event());
 expect(f.history.snapshot()).toMatchObject({capacityEvictedBuckets:HISTORY_MAX_ROWS});
 expect(f.history.snapshot().rows).toHaveLength(1);
 f.setNow(f.now+HISTORY_TTL_MS+HOUR_MS);f.history.record(f.event());expect(f.history.snapshot().rows).toHaveLength(1);
});
it('stores no arbitrary text, model, thread, request ID, quota headers or provider error body in long-term data',async()=>{
 const f=await fixture(),j=new RequestJournal(path.join(f.dir,'recent.json'),f.clock);await j.initialize();cleanups.push(()=>j.close());
 j.record({...f.event(),prompt:'synthetic private prompt',authorization:'synthetic secret'});
 j.record({...f.event(),clientHash:'synthetic secret',event:'request'});
 await j.flush();const text=await fs.readFile(f.file,'utf8');
 expect(text).not.toMatch(/synthetic|authorization|prompt|requestId|threadId|model|codexQuota/);
 expect((await fs.stat(f.file)).mode&0o777).toBe(0o600);
 expect((await fs.stat(f.dir)).mode&0o777).toBe(0o700);
 expect(j.snapshot().history.rows[0].requests).toBe(1);
});
it('isolates slow/failing writes, coalesces them and retries persistence without losing in-memory counts',async()=>{
 const f=await fixture();let release!:()=>void;
 const write=vi.spyOn(fs,'writeFile').mockImplementationOnce(()=>new Promise<void>(r=>{release=r;}));
 f.history.record(f.event());expect(write).not.toHaveBeenCalled();
 const flush=f.history.flush();f.history.record(f.event());const same=f.history.flush();expect(write).toHaveBeenCalledTimes(1);
 release();await Promise.all([flush,same]);write.mockRestore();
 expect(f.history.snapshot().storageFailuresSinceStart).toBe(1); // chmod fails on the synthetic unwritten file.
 await f.history.flush();const restored=new TrafficHistory(f.file,f.clock);await restored.initialize();expect(restored.snapshot().rows[0].requests).toBe(2);
});
it('rejects corrupt, oversized and duplicate persisted rows, removes orphan temporary snapshots, and never logs raw failures',async()=>{
 const f=await fixture();f.history.record(f.event());await f.history.flush();const valid=JSON.parse(await fs.readFile(f.file,'utf8'));
 for(const text of ['synthetic secret', 'x'.repeat(HISTORY_MAX_BYTES+1),JSON.stringify({...valid,rows:[...valid.rows,...valid.rows]})]) {
  await fs.writeFile(f.file,text);await fs.writeFile(f.file+'.tmp','synthetic secret');const other=new TrafficHistory(f.file,f.clock);await other.initialize();
  expect(other.snapshot()).toMatchObject({rows:[],storageFailuresSinceStart:1});await expect(fs.stat(f.file+'.tmp')).rejects.toMatchObject({code:'ENOENT'});
 }
});
it('restores without deriving longer history from the truncated legacy ring',async()=>{
 const f=await fixture();await fs.writeFile(path.join(f.dir,'recent.json'),JSON.stringify({rows:[f.event()]}));
 const j=new RequestJournal(path.join(f.dir,'recent.json'),f.clock);await j.initialize();cleanups.push(()=>j.close());
 expect(j.snapshot().rows).toHaveLength(1);expect(j.snapshot().history.rows).toEqual([]);
});
it('drains newer dirty history after a held older write on graceful journal close',async()=>{
 const f=await fixture(),recent=path.join(f.dir,'recent.json');
 const j=new RequestJournal(recent,f.clock);await j.initialize();
 let release!:()=>void,blocked=false;
 const gate=new Promise<void>(resolve=>{release=resolve;}),original=fs.writeFile;
 const write=vi.spyOn(fs,'writeFile').mockImplementation(async(file,data,options)=>{
  if(String(file)===f.file+'.tmp'&&!blocked){blocked=true;await gate;}
  return original(file,data,options);
 });
 j.record(f.event());const older=j.flush();expect(blocked).toBe(true);
 j.record(f.event());const closing=j.close();
 release();await Promise.all([older,closing]);write.mockRestore();
 const restored=new RequestJournal(recent,f.clock);await restored.initialize();cleanups.push(()=>restored.close());
 expect(restored.snapshot().history.rows[0].requests).toBe(2);
});
