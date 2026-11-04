import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {NativeSessions,nativeHttp,NATIVE_LEASE_MS,type NativeCaller} from './native-sessions.js';

const caller:NativeCaller={hostId:'mac',projectId:'project-one',threadId:'thread-one'};
const executor={id:'mac-official',accountId:'subscription-one',hostId:'mac',callerIds:['mac'],projectIds:['project-one'],enabled:true,autopilotAllowed:false};
function storage(){let data:unknown;return {get:async<T>()=>structuredClone(data) as T,set:async(_key:string,value:unknown)=>{data=structuredClone(value);}};}
async function fixture(){let now=1000;const kv=storage();const sessions=new NativeSessions(kv,()=>now);await sessions.initialize();await sessions.configure(executor);await sessions.setManaged(true);return {sessions,kv,clock:(value:number)=>now=value};}
const acquire=(executorId='mac-official',sessionId=randomUUID())=>({action:'acquire',executorId,sessionId});
const poll=(leaseId:string)=>({action:'poll',leaseId});
const release=(leaseId:string)=>({action:'release',leaseId,stopped:true});

describe('official native session admission',()=>{
  it('starts disabled with unknown budgets, no implicit executor or identity discovery',async()=>{
    const sessions=new NativeSessions(storage());await sessions.initialize();
    expect(await sessions.snapshot()).toMatchObject({managed:false,executors:[],leases:[],budget:'unknown'});
    expect(await sessions.executorFor(caller)).toBeNull();
  });
  it('denies foreign host, project, unbound project and unapproved autopilot before acquiring',async()=>{
    const {sessions}=await fixture();
    for(const denied of [{...caller,hostId:'foreign'},{...caller,projectId:'foreign'},{...caller,projectId:null},{...caller,purpose:'autopilot' as const}])
      await expect(sessions.request(denied,acquire())).rejects.toThrow('native-executor-denied');
    expect((await sessions.snapshot()).leases).toHaveLength(0);
  });
  it('serializes two hosts sharing a subscription, FIFO, no active preemption',async()=>{
    const {sessions}=await fixture();
    await sessions.configure({...executor,id:'lw-official',hostId:'lw',callerIds:['lw']});
    const one=await sessions.request(caller,acquire());
    const lw={...caller,hostId:'lw'};
    const [two,three]=await Promise.all([sessions.request(lw,acquire('lw-official')),sessions.request(caller,acquire())]);
    expect([one.state,two.state,three.state]).toEqual(['active','queued','queued']);
    await sessions.request(caller,release(one.leaseId!));
    expect((await sessions.request(caller,poll(three.leaseId!))).state).toBe('queued');
    expect((await sessions.request(lw,poll(two.leaseId!))).state).toBe('active');
    await sessions.request(lw,release(two.leaseId!));
    expect((await sessions.request(caller,poll(three.leaseId!))).state).toBe('active');
  });
  it('idempotent acquisition never duplicates or rebinds a process',async()=>{
    const {sessions}=await fixture();const input=acquire();
    expect(await sessions.request(caller,input)).toEqual(await sessions.request(caller,input));
    await sessions.configure({...executor,id:'other'});
    await expect(sessions.request(caller,{...input,executorId:'other'})).rejects.toThrow('native-session-bound');
    expect((await sessions.snapshot()).leases).toHaveLength(1);
  });
  it('expiry quarantines active capacity instead of starting a competing process',async()=>{
    const {sessions,clock}=await fixture();const first=await sessions.request(caller,acquire());
    clock(1001+NATIVE_LEASE_MS);
    const second=await sessions.request(caller,acquire());expect(second.state).toBe('queued');
    await expect(sessions.request(caller,poll(first.leaseId!))).rejects.toThrow('native-stop-unconfirmed');
    expect((await sessions.snapshot()).leases[0].state).toBe('uncertain');
    await expect(sessions.request(caller,{action:'release',leaseId:first.leaseId!,completed:true})).rejects.toThrow('native-stop-unconfirmed');
    await sessions.request(caller,release(first.leaseId!));
    expect((await sessions.request(caller,poll(second.leaseId!))).state).toBe('active');
  });
  it('restart conservatively quarantines live leases; operator attestation requires uncertain',async()=>{
    const {sessions,kv}=await fixture();const first=await sessions.request(caller,acquire());
    await expect(sessions.attestStopped(first.leaseId!)).rejects.toThrow('native-not-uncertain');
    const restored=new NativeSessions(kv,()=>1002);await restored.initialize();
    expect((await restored.snapshot()).leases[0].state).toBe('uncertain');
    await restored.attestStopped(first.leaseId!);
    expect((await restored.request(caller,acquire())).state).toBe('active');
  });
  it('denies foreign thread lease use, forged host fields, false termination and unknown fields',async()=>{
    const {sessions}=await fixture();const first=await sessions.request(caller,acquire());
    await expect(sessions.request({...caller,threadId:'foreign'},release(first.leaseId!))).rejects.toThrow('native-lease-denied');
    await expect(sessions.request(caller,{...acquire(),hostId:'mac'})).rejects.toThrow();
    await expect(sessions.request(caller,{...release(first.leaseId!),stopped:false})).rejects.toThrow();
    await expect(sessions.configure({...executor,token:'never-accepted'})).rejects.toThrow();
  });
  it('mode off stops admission but always allows termination acknowledgement',async()=>{
    const {sessions}=await fixture();const first=await sessions.request(caller,acquire());
    await sessions.setManaged(false);
    await expect(sessions.request(caller,poll(first.leaseId!))).rejects.toThrow('native-not-managed');
    await sessions.request(caller,release(first.leaseId!));
    expect((await sessions.snapshot()).leases).toHaveLength(0);
  });
  it('holds configuration while any process or waiter is bound, rejects ambiguous host selection',async()=>{
    const {sessions}=await fixture();await sessions.configure({...executor,id:'second'});
    expect(await sessions.executorFor(caller)).toBeNull();
    const one=await sessions.request(caller,acquire());
    await expect(sessions.configure({...executor,accountId:'changed'})).rejects.toThrow('native-executor-busy');
    await sessions.request(caller,release(one.leaseId!));
  });
  it('storage failure prevents further grants, including when the failed commit mutated memory',async()=>{
    let fail=false;const kv=storage();const sessions=new NativeSessions({...kv,set:async(...args:Parameters<typeof kv.set>)=>{if(fail)throw Error('disk');await kv.set(...args);}});
    await sessions.initialize();await sessions.configure(executor);await sessions.setManaged(true);fail=true;
    await expect(sessions.request(caller,acquire())).rejects.toThrow('native-storage-unavailable');
    await expect(sessions.request(caller,acquire())).rejects.toThrow('native-storage-unavailable');
  });
  it('rechecks admission every heartbeat, allows stop on Guard failure and prevents I/O policy drift',async()=>{
    let denied=false;let checked='';const sessions=new NativeSessions(storage(),Date.now,async host=>{checked=host;if(denied)throw Error('guard');});
    await sessions.initialize();await sessions.configure(executor);await sessions.setManaged(true);
    const first=await sessions.request(caller,acquire());expect(checked).toBe('mac');denied=true;
    await expect(sessions.request(caller,poll(first.leaseId!))).rejects.toThrow('guard');
    await sessions.request(caller,release(first.leaseId!));
  });
  it('expires abandoned queued work; bounds queue and metadata without prompts or credentials',async()=>{
    const {sessions,clock}=await fixture();await sessions.request(caller,acquire());
    for(let n=0;n<127;n++)await sessions.request(caller,acquire());
    await expect(sessions.request(caller,acquire())).rejects.toThrow('native-queue-full');
    clock(1001+NATIVE_LEASE_MS);
    expect((await sessions.snapshot()).leases).toHaveLength(1);
    const snapshot=await sessions.snapshot();expect(snapshot.events.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(snapshot)).not.toMatch(/prompt|token|code_verifier|refreshToken/);
  });
  it('HTTP uses authenticated project/purpose, bounds chunked bodies, and omits raw errors',async()=>{
    const {sessions}=await fixture();
    const req=(body:string,token='valid')=>new Request('https://pool.example/native/agy',{method:'POST',body,headers:{authorization:`Bearer ${token}`}});
    const auth=async(token:string|null)=>token==='valid'?caller:null;
    expect((await nativeHttp(req(JSON.stringify(acquire()),'invalid'),sessions,auth)).status).toBe(401);
    const valid=await nativeHttp(req(JSON.stringify(acquire())),sessions,auth);expect(valid.status).toBe(200);
    expect((await valid.json()).state).toBe('active');
    const tooLarge=await nativeHttp(req(' '.repeat(4097)),sessions,auth);expect(tooLarge.status).toBe(413);
    const bad=await nativeHttp(req('{"secret":"synthetic-private"}'),sessions,auth);
    expect(await bad.text()).not.toContain('synthetic-private');
  });
  it('full permitted registry, leases and events remain below the CLI output cap',async()=>{
    const {sessions}=await fixture();
    const long=(prefix:string,n:number)=>(prefix+String(n)).padEnd(80,'x');
    for(let n=0;n<31;n++)await sessions.configure({...executor,id:long('executor',n),hostId:long('host',n),accountId:long('subscription',n),
      projectIds:['project-one',...Array.from({length:31},(_,i)=>long('project',i))],callerIds:['mac',...Array.from({length:15},(_,i)=>long('caller',i))]});
    for(let n=0;n<128;n++)await sessions.request(caller,acquire(n%2?'mac-official':long('executor',n%31)));
    const bytes=Buffer.byteLength(JSON.stringify(await sessions.snapshot()));
    expect(bytes).toBeLessThan(512*1024);
  });
});
