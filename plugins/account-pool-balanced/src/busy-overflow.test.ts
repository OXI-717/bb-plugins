import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {createHub} from './hub.js';
import {accountPoolConfigSchema,type AccountPoolConfig} from './contracts.js';
import {AccountStore,QuotaStore,PoolAffinityStore,QUOTA_MIGRATIONS} from './store.js';

// Synthetic accounts only. Every upstream response is a stream the test keeps open,
// so a request holds its account slot until the test closes it.
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});

const session=(id:string)=>JSON.stringify({metadata:{user_id:`user_fixture_account_00000000-0000-4000-8000-000000000000_session_${id}`}});
const SESSION_A='11111111-1111-4111-8111-111111111111';
const SESSION_B='22222222-2222-4222-8222-222222222222';

async function fixture(config:Partial<AccountPoolConfig>,options:{routeCompatible?:(accountId:string,sessionKey:string|null)=>boolean}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'busy-overflow-'));
 const host=createFakePluginHost({pluginId:'fixture-pool',dataDir:dir});
 const accounts=new AccountStore(host.bb.storage.kv,path.join(dir,'secrets'));
 const db=host.bb.storage.database();for(const sql of QUOTA_MIGRATIONS)db.exec(sql);
 const quotas=new QuotaStore(db,Date.now);
 const settings=accountPoolConfigSchema.parse({vpnOnlyProviders:[],routingStrategy:'balanced',maxConcurrentRequestsPerAccount:1,...config});
 const used:string[]=[];const streams:ReadableStreamDefaultController<Uint8Array>[]=[];
 const hub=createHub({route:'/pool',accounts,quotas,affinity:new PoolAffinityStore(db),getSettings:()=>settings,
  hubTokens:{authenticate:async()=>'host',list:async()=>[]},now:Date.now,routeCompatible:options.routeCompatible,
  fetch:async(_input,init)=>{
   used.push(new Headers(init?.headers).get('x-api-key')??'');
   return new Response(new ReadableStream<Uint8Array>({start(controller){streams.push(controller);}}));
  }});
 cleanups.push(async()=>{for(const stream of streams){try{stream.close();}catch{/* already closed */}}
  await hub.stop();await host.harness.lifecycle.dispose();await fs.rm(dir,{recursive:true,force:true});});
 const add=async(key:string,role:'primary'|'reserve'='primary')=>{
  const account=await accounts.add({provider:'claude',kind:'api-key',label:key,email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true,priority:100+used.length},{kind:'api-key',apiKey:key});
  if(role==='reserve')await accounts.setRole(account.id,'reserve');
  return account;
 };
 const internal=hub as unknown as {forward:Function;options:{adapters:Map<string,unknown>}};
 const send=(body='{}')=>internal.forward(new Request('http://localhost/v1/messages',{method:'POST',body}),
  new TextEncoder().encode(body),internal.options.adapters.get('claude'),'host','project') as Promise<Response>;
 // Resolves once `count` upstream requests have started, or fails after a bounded wait.
 const started=async(count:number)=>{for(let i=0;i<200&&used.length<count;i++)await new Promise(resolve=>setTimeout(resolve,5));
  expect(used).toHaveLength(count);};
 const settle=()=>new Promise(resolve=>setTimeout(resolve,60));
 const finish=async(index:number,response:Promise<Response>)=>{streams[index]!.close();await (await response).text();};
 const closed=new Set<number>();
 const closeAll=()=>{for(const [index,stream] of streams.entries())if(!closed.has(index)){closed.add(index);stream.close();}};
 return {add,send,started,settle,finish,closeAll,used,quotas,hub,accounts};
}

it('starts a request on a free peer account instead of queueing behind a full one',async()=>{
 const f=await fixture({});await f.add('key-one');await f.add('key-two');
 const first=f.send();await f.started(1);
 const second=f.send();await f.started(2);
 expect(new Set(f.used).size).toBe(2);
 await f.finish(0,first);await f.finish(1,second);
});

it('detours a warm conversation while its account is full and returns it home afterwards',async()=>{
 const f=await fixture({});await f.add('key-one');await f.add('key-two');
 const warm=f.send(session(SESSION_A));await f.started(1);const home=f.used[0]!;
 await f.finish(0,warm);
 // Another conversation now fills the home account.
 const other=f.send(session(SESSION_B));await f.started(2);
 if(f.used[1]!==home){
  // Placement put the newcomer elsewhere: fill the home account explicitly.
  await f.finish(1,other);const again=f.send(session(SESSION_A));await f.started(3);expect(f.used[2]).toBe(home);await f.finish(2,again);return;
 }
 const detoured=f.send(session(SESSION_A));await f.started(3);
 expect(f.used[2]).not.toBe(home);
 await f.finish(1,other);await f.finish(2,detoured);
 const back=f.send(session(SESSION_A));await f.started(4);
 expect(f.used[3]).toBe(home);
 await f.finish(3,back);
});

it('uses a less preferred allowed account only while every preferred one is busy',async()=>{
 const f=await fixture({});await f.add('primary-key');await f.add('reserve-key','reserve');
 const first=f.send();await f.started(1);expect(f.used[0]).toBe('primary-key');
 const overflow=f.send();await f.started(2);expect(f.used[1]).toBe('reserve-key');
 await f.finish(0,first);await f.finish(1,overflow);
 // With the preferred account free again the reserve is left alone.
 const third=f.send();await f.started(3);expect(f.used[2]).toBe('primary-key');
 await f.finish(2,third);
});

it('queues on the preferred account when the switch is off',async()=>{
 const f=await fixture({busyOverflow:false});await f.add('primary-key');await f.add('reserve-key','reserve');
 const first=f.send();await f.started(1);
 const queued=f.send();await f.settle();
 expect(f.used).toEqual(['primary-key']);
 await f.finish(0,first);await f.started(2);expect(f.used[1]).toBe('primary-key');
 await f.finish(1,queued);
});

it('leaves the sequential strategy untouched',async()=>{
 const f=await fixture({routingStrategy:'sequential'});await f.add('key-one');await f.add('key-two');
 const first=f.send();await f.started(1);
 const queued=f.send();await f.settle();
 expect(f.used).toHaveLength(1);
 await f.finish(0,first);await f.started(2);expect(f.used[1]).toBe(f.used[0]);
 await f.finish(1,queued);
});

it('never moves a conversation onto an account that would leave its recorded route',async()=>{
 const blocked=new Set<string>();
 const f=await fixture({},{routeCompatible:accountId=>!blocked.has(accountId)});
 const one=await f.add('key-one');const two=await f.add('key-two');
 const warm=f.send(session(SESSION_A));await f.started(1);
 const homeKey=f.used[0]!;const other=homeKey==='key-one'?two:one;
 blocked.add(other.id);
 // The home account is full; the only free account is not route-compatible: wait, do not move.
 const waiting=f.send(session(SESSION_A));await f.settle();
 expect(f.used).toHaveLength(1);
 await f.finish(0,warm);await f.started(2);expect(f.used[1]).toBe(homeKey);
 await f.finish(1,waiting);
});

it('queues on the shortest line when nothing can start now',async()=>{
 const f=await fixture({});await f.add('key-one');await f.add('key-two');
 const a=f.send();await f.started(1);const b=f.send();await f.started(2);
 const third=f.send();const fourth=f.send();await f.settle();
 expect(f.used).toHaveLength(2);
 // One waiter per account: closing either stream releases exactly one of them.
 await f.finish(0,a);await f.started(3);await f.finish(1,b);await f.started(4);
 expect(f.used.slice(2).sort()).toEqual([...new Set(f.used.slice(0,2))].sort());
 await f.finish(2,third);await f.finish(3,fourth);
});

it('keeps the former pressure of two requests for a minute after a provider hold',async()=>{
 const f=await fixture({maxConcurrentRequestsPerAccount:4});const account=await f.add('key-one');
 f.quotas.put({...f.quotas.get(account.id),heldUntil:Date.now()-1_000});
 const running=[f.send(),f.send()];await f.started(2);
 const third=f.send();await f.settle();
 expect(f.used).toHaveLength(2);
 await f.finish(0,running[0]!);await f.started(3);
 await f.finish(1,running[1]!);await f.finish(2,third);
});

it('uses the configured limit once the recovery minute has passed',async()=>{
 const f=await fixture({maxConcurrentRequestsPerAccount:4});const account=await f.add('key-one');
 f.quotas.put({...f.quotas.get(account.id),heldUntil:Date.now()-61_000});
 const running=[f.send(),f.send(),f.send(),f.send()];await f.started(4);
 for(const [index,response] of running.entries())await f.finish(index,response);
});

it('spreads a simultaneous burst over the free slots of every allowed account',async()=>{
 const f=await fixture({maxConcurrentRequestsPerAccount:2});await f.add('key-one');await f.add('key-two');await f.add('key-three');
 const burst=Array.from({length:6},()=>f.send());await f.started(6);
 const perAccount=new Map<string,number>();for(const key of f.used)perAccount.set(key,(perAccount.get(key)??0)+1);
 expect([...perAccount.values()].sort()).toEqual([2,2,2]);
 // A seventh request has nowhere to start and waits instead of exceeding a limit.
 const extra=f.send();await f.settle();expect(f.used).toHaveLength(6);
 // Simultaneous requests reach the upstream in no particular order: close every stream
 // (the waiter starts as soon as one slot frees), then collect all bodies.
 f.closeAll();await f.started(7);f.closeAll();
 await Promise.all([...burst,extra].map(async response=>(await response).text()));
});
