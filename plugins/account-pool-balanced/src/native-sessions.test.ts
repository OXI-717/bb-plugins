import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {NativeSessions,nativeHttp,NATIVE_LEASE_MS,NATIVE_REQUEST_BODY_TIMEOUT_MS,type NativeCaller,type NativeHttpRejection} from './native-sessions.js';
import {GuardRequiredError} from './network-errors.js';

const caller:NativeCaller={hostId:'mac',projectId:'project-one',threadId:'thread-one'};
const executor={id:'mac-official',accountId:'subscription-one',hostId:'mac',callerIds:['mac'],projectIds:['project-one'],enabled:true,autopilotAllowed:false};
function storage(){let data:unknown;return {get:async<T>()=>structuredClone(data) as T,set:async(_key:string,value:unknown)=>{data=structuredClone(value);}};}
async function fixture(){let now=1000;const kv=storage();const sessions=new NativeSessions(kv,()=>now);await sessions.initialize();await sessions.configure(executor);await sessions.setManaged(true);return {sessions,kv,clock:(value:number)=>now=value};}
const acquire=(executorId='mac-official',sessionId=randomUUID())=>({action:'acquire',executorId,sessionId});
const poll=(leaseId:string)=>({action:'poll',leaseId});
const release=(leaseId:string)=>({action:'release',leaseId,stopped:true});

it('selects an explicit second account without rebinding active processes, and persists the choice',async()=>{
  const {sessions,kv}=await fixture();
  const active=await sessions.request(caller,acquire());
  await sessions.configure({...executor,id:'second',accountId:'subscription-two',label:'Second Google',catalogCallerIds:['catalog-two']});
  expect(await sessions.executorFor(caller)).toBeNull();
  const first=await sessions.accounts();
  await sessions.prefer('second',first.selectionRevision);
  expect(await sessions.executorFor(caller)).toBe('second');
  expect(await sessions.executorFor({...caller,hostId:'foreign'})).toBeNull();
  expect(await sessions.executorFor({...caller,projectId:'foreign'})).toBeNull();
  expect((await sessions.request(caller,poll(active.leaseId!))).accountId).toBe('subscription-one');
  const second=await sessions.request(caller,acquire('second'));
  expect(second).toMatchObject({state:'active',accountId:'subscription-two'});
  expect((await sessions.accounts()).accounts[1]).toMatchObject({label:'Second Google',executors:[{id:'second',preferred:true}]});
  await expect(sessions.prefer(executor.id,first.selectionRevision)).rejects.toThrow('native-selection-changed');
  await expect(sessions.prefer('unknown',(await sessions.accounts()).selectionRevision)).rejects.toThrow('native-executor-not-found');
  const next=new NativeSessions(kv);await next.initialize();
  expect(await next.executorFor(caller)).toBe('second');
  expect((await next.snapshot()).leases.every(l=>l.state==='uncertain')).toBe(true);
});

it('keeps catalog authority and disabled accounts separate from account preference',async()=>{
  const {sessions}=await fixture();
  await sessions.configure({...executor,catalogCallerIds:['catalog-one']});
  await sessions.configure({...executor,id:'second',accountId:'subscription-two',catalogCallerIds:['catalog-two']});
  expect(await sessions.catalogExecutorFor('mac')).toBeNull();
  await sessions.prefer('second',(await sessions.accounts()).selectionRevision);
  expect(await sessions.catalogExecutorFor('mac')).toBe('second');
  await expect(sessions.request({hostId:'catalog-one',projectId:'project-one'},{...acquire('second'),kind:'catalog'})).rejects.toThrow('native-executor-denied');
  await sessions.configure({...executor,id:'disabled',enabled:false});
  await expect(sessions.prefer('disabled',(await sessions.accounts()).selectionRevision)).rejects.toThrow('native-executor-not-found');
});

it('allows shared project controls only when the explicit choice covers the overlap',async()=>{
  const {sessions}=await fixture();
  await sessions.configure({...executor,id:'second',accountId:'subscription-two'});
  const all={onlySelected:false,rules:[]};
  let account=(await sessions.accounts()).accounts[1];
  await expect(sessions.setProjects('subscription-two',all,account.projectsRevision)).rejects.toThrow('native-projects-ambiguous');
  await sessions.prefer('second',(await sessions.accounts()).selectionRevision);
  await sessions.setProjects('subscription-two',all,account.projectsRevision);
  expect(await sessions.executorFor(caller)).toBe('second');
  const current=await sessions.snapshot();
  await sessions.configure({...executor,id:'unrelated',accountId:'subscription-three',callerIds:['foreign']});
  await sessions.prefer('unrelated',(await sessions.accounts()).selectionRevision);
  account=(await sessions.accounts()).accounts[1];
  await expect(sessions.setProjects('subscription-two',all,account.projectsRevision)).rejects.toThrow('native-projects-ambiguous');
  expect((await sessions.snapshot()).leases).toEqual(current.leases);
});

describe('prepared native execution binding',()=>{
  const execution={runtimeId:'runtime-one',gatewayId:'gateway-one',runtimeSha256:'a'.repeat(64),profile:{id:'fixture-exit',version:1}};
  it('requires explicit server preparation and returns an immutable account/host/runtime/profile/lease authority',async()=>{
    const unsupported=new NativeSessions(storage());await unsupported.initialize();
    await expect(unsupported.configure({...executor,execution})).rejects.toThrow('native-execution-unprepared');
    let allowed=true;
    const sessions=new NativeSessions(storage(),()=>1000,async()=>{},e=>{if(!allowed||e.execution?.profile.version!==1)throw Error('unprepared');});
    await sessions.initialize();await sessions.configure({...executor,execution});await sessions.setManaged(true);
    const input=acquire(),first=await sessions.request(caller,input);
    expect(first.binding).toEqual({schema:'bb-account-pool/native-execution/1',leaseId:first.leaseId,sessionId:input.sessionId,
      executorId:executor.id,accountId:executor.accountId,hostId:executor.hostId,kind:'task',caller,...execution});
    first.binding!.profile.version=99;
    expect((await sessions.request(caller,poll(first.leaseId!))).binding!.profile.version).toBe(1);
    await expect(sessions.configure({...executor,execution:{...execution,profile:{...execution.profile,version:2}}})).rejects.toThrow();
    allowed=false;await expect(sessions.request(caller,poll(first.leaseId!))).rejects.toThrow('unprepared');
    expect((await sessions.snapshot()).leases).toHaveLength(1);
    await sessions.request(caller,release(first.leaseId!));
  });
  it('keeps catalog authority separate and quarantines a prepared active lease after expiry/restart',async()=>{
    const kv=storage();let now=1000;
    const sessions=new NativeSessions(kv,()=>now,async()=>{},()=>{});await sessions.initialize();
    await sessions.configure({...executor,execution,catalogCallerIds:['catalog-one']});await sessions.setManaged(true);
    const catalog={hostId:'catalog-one',projectId:'project-one'};
    const first=await sessions.request(catalog,{...acquire(),kind:'catalog'});
    expect(first.binding!.kind).toBe('catalog');
    await expect(sessions.request(catalog,acquire())).rejects.toThrow('native-executor-denied');
    await expect(sessions.request(caller,{...acquire(),execution})).rejects.toThrow();
    now+=NATIVE_LEASE_MS+1;
    await expect(sessions.request(catalog,poll(first.leaseId!))).rejects.toThrow('native-stop-unconfirmed');
    const restarted=new NativeSessions(kv,()=>now,async()=>{},()=>{});await restarted.initialize();
    expect((await restarted.snapshot()).leases[0].state).toBe('uncertain');
    await expect(restarted.request(catalog,{action:'release',leaseId:first.leaseId!,completed:true})).rejects.toThrow('native-stop-unconfirmed');
    await restarted.request(catalog,release(first.leaseId!));
  });
});

describe('official native session admission',()=>{
  it('starts disabled with unknown budgets, no implicit executor or identity discovery',async()=>{
    const sessions=new NativeSessions(storage());await sessions.initialize();
    expect(await sessions.snapshot()).toMatchObject({managed:false,executors:[],leases:[],budget:'unknown'});
    expect(await sessions.executorFor(caller)).toBeNull();
  });
  it('denies foreign host, project, unbound project and unapproved autopilot before acquiring',async()=>{
    const {sessions}=await fixture();
    await sessions.configure({...executor,id:'second',accountId:'subscription-two'});
    await sessions.prefer('second',(await sessions.accounts()).selectionRevision);
    for(const denied of [{...caller,hostId:'foreign'},{...caller,projectId:'foreign'},{...caller,projectId:null},{...caller,purpose:'autopilot' as const}])
    {
      await expect(sessions.request(denied,acquire())).rejects.toThrow('native-executor-denied');
      expect(await sessions.executorFor(denied)).toBeNull();
    }
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
  it('admits distinct threads concurrently up to a persisted account limit shared by machines, then uses FIFO',async()=>{
    const {sessions,kv}=await fixture();
    await sessions.configure({...executor,id:'lw-official',hostId:'lw',callerIds:['lw']});
    const expectedRevision=(await sessions.accounts()).selectionRevision;
    await sessions.updateAccount({accountId:executor.accountId,expectedRevision,maxConcurrentSessions:2});
    await expect(sessions.updateAccount({accountId:executor.accountId,expectedRevision,maxConcurrentSessions:3})).rejects.toThrow('native-selection-changed');
    const restored=new NativeSessions(kv,()=>1000);await restored.initialize();
    expect(await restored.executorFor(caller)).toBe(executor.id);
    expect((await restored.accounts()).accounts[0]).toMatchObject({maxConcurrentSessions:2});
    const secondCaller={...caller,hostId:'lw',threadId:'thread-two'};
    const thirdCaller={...caller,threadId:'thread-three'};
    const fourthCaller={...caller,threadId:'thread-four'};
    const first=await restored.request(caller,acquire());
    const second=await restored.request(secondCaller,acquire('lw-official'));
    const third=await restored.request(thirdCaller,acquire());
    const fourth=await restored.request(fourthCaller,acquire());
    expect([first.state,second.state,third.state,fourth.state]).toEqual(['active','active','queued','queued']);
    const revision=(await restored.accounts()).selectionRevision;
    await restored.updateAccount({accountId:executor.accountId,expectedRevision:revision,maxConcurrentSessions:3});
    expect((await restored.request(fourthCaller,poll(fourth.leaseId!))).state).toBe('queued');
    expect((await restored.request(thirdCaller,poll(third.leaseId!))).state).toBe('active');
    expect((await restored.request(secondCaller,poll(second.leaseId!))).state).toBe('active');
    const revisionAfterRaise=(await restored.accounts()).selectionRevision;
    await expect(restored.updateAccount({accountId:executor.accountId,expectedRevision:revisionAfterRaise,maxConcurrentSessions:1})).rejects.toThrow('native-executor-busy');
    expect((await restored.request(caller,poll(first.leaseId!))).state).toBe('active');
    await restored.request(caller,release(first.leaseId!));
    expect((await restored.request(fourthCaller,poll(fourth.leaseId!))).state).toBe('active');
    await restored.request(secondCaller,release(second.leaseId!));
    await restored.request(thirdCaller,release(third.leaseId!));
    await restored.request(fourthCaller,release(fourth.leaseId!));
    await restored.updateAccount({accountId:executor.accountId,expectedRevision:revisionAfterRaise,maxConcurrentSessions:1});
    expect(await restored.snapshot()).not.toHaveProperty('accountConcurrency');
    expect((await restored.request(caller,acquire())).state).toBe('active');
    expect((await restored.request(secondCaller,acquire('lw-official'))).state).toBe('queued');
  });
  it('leaves a pre-existing same-thread waiter queued when raising account capacity',async()=>{
    const {sessions}=await fixture();
    const first=await sessions.request(caller,acquire());
    const duplicate=await sessions.request(caller,acquire());
    const other={...caller,threadId:'thread-two'};
    const next=await sessions.request(other,acquire());
    expect([first.state,duplicate.state,next.state]).toEqual(['active','queued','queued']);
    const expectedRevision=(await sessions.accounts()).selectionRevision;
    await sessions.updateAccount({accountId:executor.accountId,expectedRevision,maxConcurrentSessions:2});
    expect((await sessions.request(caller,poll(duplicate.leaseId!))).state).toBe('queued');
    expect((await sessions.request(other,poll(next.leaseId!))).state).toBe('active');
    expect((await sessions.request(caller,poll(first.leaseId!))).state).toBe('active');
    await sessions.request(caller,release(first.leaseId!));
    expect((await sessions.request(caller,poll(duplicate.leaseId!))).state).toBe('active');
  });
  it('won’t start a duplicate thread or refill capacity while a stop is unconfirmed',async()=>{
    const {sessions,clock}=await fixture();
    await sessions.updateAccount({accountId:executor.accountId,expectedRevision:(await sessions.accounts()).selectionRevision,maxConcurrentSessions:2});
    const first=await sessions.request(caller,acquire());
    await expect(sessions.request(caller,acquire())).rejects.toThrow('native-thread-already-bound');
    clock(1001+NATIVE_LEASE_MS);
    const other={...caller,threadId:'thread-two'};
    const second=await sessions.request(other,acquire());
    expect(second.state).toBe('queued');
    await sessions.updateAccount({accountId:executor.accountId,expectedRevision:(await sessions.accounts()).selectionRevision,maxConcurrentSessions:3});
    expect((await sessions.request(other,poll(second.leaseId!))).state).toBe('queued');
    await sessions.request(caller,release(first.leaseId!));
    expect((await sessions.request(other,poll(second.leaseId!))).state).toBe('active');
  });
  it('catalog caller authority never grants tasks or changes an existing lease kind',async()=>{
    const {sessions}=await fixture();
    await sessions.configure({...executor,catalogCallerIds:['catalog-one']});
    const catalog={hostId:'catalog-one',projectId:'project-one'};
    expect(await sessions.catalogExecutorFor('mac')).toBe(executor.id);
    expect(await sessions.catalogExecutorFor('foreign')).toBeNull();
    await expect(sessions.request(catalog,acquire())).rejects.toThrow('native-executor-denied');
    await expect(sessions.request(caller,{...acquire(),kind:'catalog'})).rejects.toThrow('native-executor-denied');
    await expect(sessions.request({...catalog,projectId:'foreign'},{...acquire(),kind:'catalog'})).rejects.toThrow('native-executor-denied');
    const input={...acquire(),kind:'catalog'};
    const lease=await sessions.request(catalog,input);expect(lease.state).toBe('active');
    await expect(sessions.request(caller,poll(lease.leaseId!))).rejects.toThrow('native-lease-denied');
    expect((await sessions.request(catalog,poll(lease.leaseId!))).state).toBe('active');
    await sessions.request(catalog,release(lease.leaseId!));
    await sessions.configure({...executor,catalogCallerIds:['mac']});
    await sessions.request(caller,{...input,sessionId:input.sessionId});
    await expect(sessions.request(caller,{...input,kind:'task'})).rejects.toThrow('native-session-bound');
  });
  it('keeps an expired catalog lease visible without blocking task admission on either host',async()=>{
    const {sessions,clock}=await fixture();
    await sessions.configure({...executor,catalogCallerIds:['catalog-one']});
    await sessions.configure({...executor,id:'worker-official',hostId:'worker',callerIds:['worker'],catalogCallerIds:['catalog-two']});
    const catalog={hostId:'catalog-one',projectId:'project-one'};
    const discover={hostId:'catalog-two',projectId:'project-one'};
    const worker={hostId:'worker',projectId:'project-one',threadId:'thread-two'};
    const first=await sessions.request(catalog,{...acquire(),kind:'catalog'});
    clock(1001+NATIVE_LEASE_MS);
    const blocked=await sessions.request(discover,{...acquire('worker-official'),kind:'catalog'});
    expect(blocked.state).toBe('queued');
    expect((await sessions.request(worker,acquire('worker-official'))).state).toBe('active');
    expect((await sessions.request(caller,acquire())).state).toBe('queued');
    expect(await sessions.uncertainLeases()).toEqual([expect.objectContaining({leaseId:first.leaseId,kind:'catalog'})]);
    await expect(sessions.request(catalog,{action:'release',leaseId:first.leaseId!,completed:true})).rejects.toThrow('native-stop-unconfirmed');
    await sessions.request(catalog,release(first.leaseId!));
    expect((await sessions.request(discover,poll(blocked.leaseId!))).state).toBe('active');
  });
  it('limits discovery to one catalog process without consuming the task limit',async()=>{
    const {sessions}=await fixture();
    await sessions.configure({...executor,catalogCallerIds:['catalog-one']});
    const catalog={hostId:'catalog-one',projectId:'project-one'};
    const task=await sessions.request(caller,acquire());
    const first=await sessions.request(catalog,{...acquire(),kind:'catalog'});
    expect(task.state).toBe('active');
    expect(first.state).toBe('active');
    const second=await sessions.request(catalog,{...acquire(),kind:'catalog'});
    expect(second.state).toBe('queued');
    await sessions.request(catalog,release(first.leaseId!));
    expect((await sessions.request(catalog,poll(second.leaseId!))).state).toBe('active');
  });
  it('releases only the uncertain catalog bound to a stopped host process group',async()=>{
    const {sessions,clock}=await fixture();
    await sessions.configure({...executor,catalogCallerIds:['catalog-one']});
    const catalog={hostId:'catalog-one',projectId:'project-one'};
    const process={groupId:4321,bootId:'00000000-0000-0000-0000-000000000001'};
    const input={...acquire(),kind:'catalog',catalogProcess:process};
    await expect(sessions.request(caller,{...input,kind:'task'})).rejects.toThrow();
    const tracked=await sessions.request(catalog,input);
    await expect(sessions.request(catalog,{...input,catalogProcess:{...process,groupId:5678}})).rejects.toThrow('native-session-bound');
    clock(1001+NATIVE_LEASE_MS);
    const checked:unknown[]=[];
    await sessions.reconcileNativeProcesses(async(hostId,binding)=>{
      checked.push({hostId,binding});return false;
    });
    expect(checked).toEqual([{hostId:executor.hostId,binding:process}]);
    expect((await sessions.uncertainLeases())[0].leaseId).toBe(tracked.leaseId);
    await sessions.reconcileNativeProcesses(async()=>{throw new Error('offline')});
    expect(await sessions.uncertainLeases()).toHaveLength(1);
    const other=await sessions.request(catalog,{...acquire(),kind:'catalog',catalogProcess:{...process,groupId:5678}});
    const verified=vi.fn(async()=>true);
    expect(await sessions.checkStopped(other.leaseId!,verified)).toEqual({state:'kept'});
    expect(verified).not.toHaveBeenCalled();
    expect(await sessions.checkStopped(tracked.leaseId!,async()=>false)).toEqual({state:'kept'});
    expect(await sessions.checkStopped(tracked.leaseId!,verified)).toEqual({state:'released'});
    expect(verified).toHaveBeenCalledExactlyOnceWith(executor.hostId,process);
    expect(await sessions.checkStopped(tracked.leaseId!,verified)).toEqual({state:'absent'});
    expect(verified).toHaveBeenCalledOnce();
    expect(await sessions.uncertainLeases()).toEqual([]);
    expect((await sessions.snapshot()).events.at(-1)?.event).toBe('released');
  });
  it('keeps legacy catalog and task holds out of automatic recovery',async()=>{
    const {sessions,clock}=await fixture();
    await sessions.configure({...executor,catalogCallerIds:['catalog-one']});
    await sessions.request({hostId:'catalog-one',projectId:'project-one'},{...acquire(),kind:'catalog'});
    await sessions.request(caller,acquire());
    clock(1001+NATIVE_LEASE_MS);
    let called=false;
    await sessions.reconcileNativeProcesses(async()=>{called=true;return true});
    expect(called).toBe(false);
    expect(await sessions.uncertainLeases()).toHaveLength(2);
  });
  it('retains the account-wide hold for an expired task even when discovery has a free slot',async()=>{
    const {sessions,clock}=await fixture();
    await sessions.configure({...executor,catalogCallerIds:['catalog-one']});
    const catalog={hostId:'catalog-one',projectId:'project-one'};
    const task=await sessions.request(caller,acquire());
    clock(1001+NATIVE_LEASE_MS);
    const lookup=await sessions.request(catalog,{...acquire(),kind:'catalog'});
    expect(lookup.state).toBe('queued');
    await sessions.request(caller,release(task.leaseId!));
    expect((await sessions.request(catalog,poll(lookup.leaseId!))).state).toBe('active');
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

it('projects registered subscriptions without exposing execution authority, and counts shared leases',async()=>{
  const {sessions,clock}=await fixture();
  await sessions.configure({...executor,id:'worker-official',hostId:'worker',callerIds:['worker'],autopilotAllowed:true});
  await sessions.configure({...executor,id:'disabled-official',accountId:'subscription-two',enabled:false});
  await sessions.request(caller,acquire());
  await sessions.request({...caller,hostId:'worker'},acquire('worker-official'));
  expect(await sessions.accounts()).toEqual({managed:true,selectionRevision:expect.any(String),accounts:[
    {accountId:'subscription-one',projects:{onlySelected:true,rules:[{projectId:'project-one',role:'inherit'}]},projectsRevision:expect.any(String),mixedProjects:false,executors:[{id:'mac-official',hostId:'mac',enabled:true,autopilotAllowed:false},{id:'worker-official',hostId:'worker',enabled:true,autopilotAllowed:true}],active:1,queued:1,uncertain:0},
    {accountId:'subscription-two',projects:{onlySelected:true,rules:[{projectId:'project-one',role:'inherit'}]},projectsRevision:expect.any(String),mixedProjects:false,executors:[{id:'disabled-official',hostId:'mac',enabled:false,autopilotAllowed:false}],active:0,queued:0,uncertain:0},
  ]});
  clock(1000+NATIVE_LEASE_MS+1);
  expect((await sessions.accounts()).accounts[0]).toMatchObject({active:0,queued:0,uncertain:1});
});


describe('native subscription project settings',()=>{
  it('allows future projects across registered executors but keeps host, purpose and catalog boundaries',async()=>{
    const {sessions,kv}=await fixture();
    await sessions.configure({...executor,id:'other-host',hostId:'worker',callerIds:['worker']});
    const initial=(await sessions.accounts()).accounts[0];
    expect(await sessions.executorFor({...caller,projectId:'future-project'})).toBeNull();
    await sessions.setProjects(executor.accountId,{onlySelected:false,rules:[]},initial.projectsRevision);
    for(const hostId of ['mac','worker'])expect(await sessions.executorFor({...caller,hostId,projectId:'future-project'})).not.toBeNull();
    for(const denied of [{...caller,hostId:'foreign'},{...caller,projectId:null}])
      await expect(sessions.request(denied,acquire())).rejects.toThrow('native-executor-denied');
    await expect(sessions.request({...caller,hostId:'catalog-only'},{...acquire(),kind:'catalog'})).rejects.toThrow();
    expect((await sessions.snapshot()).executors.every(e=>e.autopilotAllowed===false)).toBe(true);
    const restarted=new NativeSessions(kv);await restarted.initialize();
    expect(await restarted.executorFor({...caller,projectId:'another-future-project'})).toBe(executor.id);
    const revision=(await sessions.accounts()).accounts[0].projectsRevision;
    await sessions.setProjects(executor.accountId,{onlySelected:true,rules:[{projectId:'future-project',role:'inherit'}]},revision);
    expect(await sessions.executorFor(caller)).toBeNull();
    expect(await sessions.executorFor({...caller,projectId:'future-project'})).toBe(executor.id);
    await expect(sessions.setProjects(executor.accountId,{onlySelected:false,rules:[]},revision)).rejects.toThrow('native-projects-changed');
  });
  it('rejects changes during a lease, unknown subscriptions and redirects project role edits to account settings',async()=>{
    const {sessions}=await fixture();const account=(await sessions.accounts()).accounts[0];
    const lease=await sessions.request(caller,acquire());
    await expect(sessions.setProjects(executor.accountId,{onlySelected:false,rules:[]},account.projectsRevision)).rejects.toThrow('native-executor-busy');
    await sessions.request(caller,release(lease.leaseId!));
    await expect(sessions.setProjects('missing',{onlySelected:false,rules:[]},account.projectsRevision)).rejects.toThrow('native-account-not-found');
    await expect(sessions.setProjects(executor.accountId,{onlySelected:true,rules:[{projectId:'project-one',role:'primary'}]},account.projectsRevision)).rejects.toThrow('native-use-account-settings');
  });
});


it.each(['subscription-one','subscription-two'])('refuses overlapping executor project selection for %s without changing policy',async(accountId)=>{
  const {sessions}=await fixture();
  await sessions.configure({...executor,id:'second-executor',accountId,projectIds:['project-two']});
  const initial=(await sessions.accounts()).accounts.find(a=>a.accountId===executor.accountId)!;
  for(const projects of [{onlySelected:false,rules:[]},{onlySelected:true,rules:[{projectId:'project-two',role:'inherit' as const}]}])
    await expect(sessions.setProjects(executor.accountId,projects,initial.projectsRevision)).rejects.toThrow('native-projects-ambiguous');
  expect(await sessions.executorFor(caller)).toBe(executor.id);
  expect(await sessions.executorFor({...caller,projectId:'project-two'})).toBe('second-executor');
  expect((await sessions.accounts()).accounts.find(a=>a.accountId===executor.accountId)!.projectsRevision).toBe(initial.projectsRevision);
});
it('bounds native project metadata and prevents callers from mutating the stored projects through summaries',async()=>{
  const {sessions}=await fixture();let account=(await sessions.accounts()).accounts[0];
  await expect(sessions.setProjects(executor.accountId,{onlySelected:true,rules:Array.from({length:33},(_,i)=>({projectId:'project-'+i,role:'inherit' as const}))},account.projectsRevision)).rejects.toThrow();
  await sessions.setProjects(executor.accountId,{onlySelected:false,rules:[]},account.projectsRevision);
  account=(await sessions.accounts()).accounts[0];account.projects.onlySelected=true;account.projects.rules.push({projectId:'foreign',role:'inherit'});
  expect(await sessions.executorFor(caller)).toBe(executor.id);
});


describe('native account routing settings',()=>{
  const all={onlySelected:false,rules:[]};
  async function second(sessions:NativeSessions){await sessions.configure({...executor,id:'second',accountId:'subscription-two',projects:all,catalogCallerIds:['catalog-two']});}
  async function update(sessions:NativeSessions,input:Omit<Parameters<NativeSessions['updateAccount']>[0],'expectedRevision'>){return sessions.updateAccount({...input,expectedRevision:(await sessions.accounts()).selectionRevision!});}
  it('uses the shared project roles before account priority and persists routing after restart',async()=>{
    const {sessions,kv}=await fixture();await second(sessions);
    await update(sessions,{accountId:executor.accountId,role:'primary',priority:0,projects:all});
    await update(sessions,{accountId:'subscription-two',role:'reserve',priority:100,projects:{onlySelected:false,rules:[{projectId:'project-one',role:'primary'}]}});
    expect(await sessions.executorFor(caller)).toBe('second');
    expect(await sessions.executorFor({...caller,projectId:'other'})).toBe(executor.id);
    await update(sessions,{accountId:'subscription-two',projects:{onlySelected:true,rules:[{projectId:'project-one',role:'reserve'}]}});
    expect(await sessions.executorFor(caller)).toBe('second');
    expect(await sessions.executorFor({...caller,projectId:'other'})).toBe(executor.id);
    const restarted=new NativeSessions(kv);await restarted.initialize();
    expect(await restarted.executorFor(caller)).toBe('second');
  });
  it('changes priority during an active session without rebinding it and refuses stale writes',async()=>{
    const {sessions}=await fixture();await second(sessions);
    await update(sessions,{accountId:executor.accountId,role:'primary',priority:1,projects:all});
    await update(sessions,{accountId:'subscription-two',role:'primary',priority:2});
    const lease=await sessions.request(caller,acquire());const rev=(await sessions.accounts()).selectionRevision!;
    await sessions.updateAccount({accountId:executor.accountId,expectedRevision:rev,priority:3});
    expect(await sessions.executorFor(caller)).toBe('second');
    expect((await sessions.request(caller,poll(lease.leaseId!))).accountId).toBe(executor.accountId);
    await expect(sessions.updateAccount({accountId:executor.accountId,expectedRevision:rev,priority:0})).rejects.toThrow('native-selection-changed');
    await expect(update(sessions,{accountId:executor.accountId,executor:{id:executor.id,enabled:false}})).rejects.toThrow('native-executor-busy');
  });
  it('preserves authenticated host, purpose and catalog restrictions across settings and rejects cross-account executor edits',async()=>{
    const {sessions}=await fixture();await second(sessions);
    await update(sessions,{accountId:'subscription-two',priority:-5,projects:all});
    expect(await sessions.executorFor({...caller,hostId:'foreign'})).toBeNull();
    expect(await sessions.executorFor({...caller,purpose:'autopilot'})).toBeNull();
    await expect(update(sessions,{accountId:'subscription-two',executor:{id:executor.id,enabled:false}})).rejects.toThrow('native-executor-denied');
    await update(sessions,{accountId:'subscription-two',executor:{id:'second',autopilotAllowed:true}});
    expect(await sessions.executorFor({...caller,purpose:'autopilot'})).toBe('second');
    await expect(sessions.request({hostId:'catalog-two',projectId:'project-one'},{...acquire(executor.id),kind:'catalog'})).rejects.toThrow('native-executor-denied');
    await update(sessions,{accountId:'subscription-two',executor:{id:'second',enabled:false}});
    expect(await sessions.executorFor({...caller,purpose:'autopilot'})).toBeNull();
  });
});

it('renames a native account without changing executor identity or breaking its active lease',async()=>{
  const {sessions}=await fixture();const lease=await sessions.request(caller,acquire());
  await sessions.updateAccount({accountId:executor.accountId,expectedRevision:(await sessions.accounts()).selectionRevision!,label:'Example Google',priority:1});
  expect((await sessions.accounts()).accounts[0].label).toBe('Example Google');
  expect((await sessions.request(caller,poll(lease.leaseId!))).accountId).toBe(executor.accountId);
  expect((await sessions.snapshot()).executors[0]).not.toHaveProperty('label');
  await sessions.updateAccount({accountId:executor.accountId,expectedRevision:(await sessions.accounts()).selectionRevision!,role:'reserve'});
  expect((await sessions.accounts()).accounts[0].label).toBe('Example Google');
});


it('treats account identifiers as opaque keys even when they match object properties',async()=>{
  const {sessions,kv}=await fixture();
  await sessions.configure({...executor,id:'other-executor',accountId:'toString',enabled:true});
  await sessions.updateAccount({accountId:'toString',expectedRevision:(await sessions.accounts()).selectionRevision!,role:'primary',priority:-1});
  expect(await sessions.executorFor(caller)).toBe('other-executor');
  const restarted=new NativeSessions(kv);await restarted.initialize();
  expect(await restarted.executorFor(caller)).toBe('other-executor');
});

it('maps Guard block and unavailability distinctly and reports safe structured HTTP rejections',async()=>{
  let mode:'ok'|'blocked'|'unavailable'='ok';
  const sessions=new NativeSessions(storage(),()=>1000,async()=>{
    if(mode==='blocked')throw new GuardRequiredError('agy',false);
    if(mode==='unavailable')throw new GuardRequiredError('agy',true,'timeout');
  });
  await sessions.initialize();await sessions.configure(executor);await sessions.setManaged(true);
  const req=(body:string,token='valid')=>new Request('https://pool.example/native/agy',{method:'POST',body,headers:{authorization:`Bearer ${token}`}});
  const auth=async(token:string|null)=>token==='valid'?caller:null;
  const observed:NativeHttpRejection[]=[];
  const acquired=await nativeHttp(req(JSON.stringify(acquire())),sessions,auth,e=>observed.push(e));
  expect(acquired.status).toBe(200);
  const {leaseId}=await acquired.json();
  expect(observed).toEqual([]);

  mode='blocked';
  const blocked=await nativeHttp(req(JSON.stringify(poll(leaseId))),sessions,auth,e=>observed.push(e));
  expect(blocked.status).toBe(403);
  expect(await blocked.json()).toEqual({error:'native-guard-blocked'});

  mode='unavailable';
  const unavailable=await nativeHttp(req(JSON.stringify(poll(leaseId))),sessions,auth,e=>observed.push(e));
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({error:'native-guard-unavailable'});

  const badAction=await nativeHttp(req(JSON.stringify({action:'synthetic-secret-action'})),sessions,auth,e=>observed.push(e));
  expect(badAction.status).toBe(400);
  expect(observed).toEqual([
    {status:403,code:'native-guard-blocked',action:'poll',hostId:'mac'},
    {status:503,code:'native-guard-unavailable',action:'poll',hostId:'mac'},
    {status:400,code:'native-invalid-request',action:null,hostId:'mac'},
  ]);
  expect(NATIVE_REQUEST_BODY_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  // Failing observer never alters HTTP admission outcomes.
  mode='blocked';
  const resilient=await nativeHttp(req(JSON.stringify(poll(leaseId))),sessions,auth,()=>{throw Error('log-failed');});
  expect(resilient.status).toBe(403);
});

describe('task process reconciliation',()=>{
  const binding={groupId:23456,bootId:'1858e38e-2aa0-4f82-a565-1e154b3adcf9'};
  const processHeader=`${binding.bootId}/${binding.groupId}`;
  const requestId='fbcbd81a-9cf1-4e68-86c2-540cf3bf47af';
  function post(sessions:NativeSessions,input:unknown,identity:NativeCaller|null=caller,process:string|null=processHeader,correlation=requestId,observe?:(event:NativeHttpRejection)=>void){
    const headers=new Headers({authorization:'Bearer fixture-credential','x-request-id':correlation});
    if(process!==null)headers.set('x-bb-native-task-process',process);
    return nativeHttp(new Request('https://pool.example/native/agy',{method:'POST',headers,body:JSON.stringify(input)}),sessions,
      async token=>token==='fixture-credential'?identity:null,observe);
  }

  it('stores the exact binding and lets the same thread acquire only after verified expiry',async()=>{
    const {sessions,kv,clock}=await fixture();
    await sessions.updateAccount({accountId:executor.accountId,expectedRevision:(await sessions.accounts()).selectionRevision,maxConcurrentSessions:2});
    const input=acquire();
    const admitted=await post(sessions,input);
    expect(admitted.headers.get('x-request-id')).toBe(requestId);
    const active=await admitted.json();
    expect(active).toMatchObject({state:'active'});
    expect(active).not.toHaveProperty('taskProcess');
    expect((await post(sessions,input)).status).toBe(200);
    for(const changed of [null,`${binding.bootId}/23457`,`${requestId}/23456`]){
      expect(await (await post(sessions,input,caller,changed)).json()).toEqual({error:'native-session-bound'});
    }
    expect((await sessions.snapshot()).leases[0]).not.toHaveProperty('taskProcess');

    let now=1001;
    const restarted=new NativeSessions(kv,()=>now);
    await restarted.initialize();
    const checked:unknown[]=[];
    const stopped=async(hostId:string,process:typeof binding)=>{
      checked.push({hostId,process});
      expect(await restarted.uncertainLeases()).toHaveLength(1);
      return true;
    };
    expect(await restarted.reconcileNativeProcesses(stopped)).toBe(0);
    expect(checked).toEqual([]);
    now=clock(1000+NATIVE_LEASE_MS+1);
    expect(await (await post(restarted,acquire())).json()).toEqual({error:'native-thread-already-bound'});
    expect(await restarted.reconcileNativeProcesses(async()=>false)).toBe(0);
    expect(await restarted.reconcileNativeProcesses(async()=>{throw Error('offline');})).toBe(0);
    expect(await restarted.reconcileNativeProcesses(stopped)).toBe(1);
    expect(checked).toEqual([{hostId:executor.hostId,process:binding}]);
    const reacquired=await (await post(restarted,acquire(),caller,`${binding.bootId}/23457`)).json();
    expect(reacquired).toMatchObject({state:'active'});
    expect(reacquired.leaseId).not.toBe(active.leaseId);
  });

  it('rejects task evidence outside the authenticated local task scope and validates the header',async()=>{
    const {sessions}=await fixture();
    await sessions.configure({...executor,callerIds:['mac','remote'],catalogCallerIds:['mac']});
    for(const identity of [{hostId:'mac',projectId:'project-one'},{...caller,hostId:'remote'}]){
      expect((await post(sessions,acquire(),identity)).status).toBe(403);
    }
    for(const kind of ['catalog','diagnostic']){
      expect((await post(sessions,{...acquire(),kind})).status).toBe(403);
    }
    for(const invalid of [binding.bootId.toUpperCase()+'/23456',binding.bootId+'/0',binding.bootId+'/1',binding.bootId+'/023456',
      binding.bootId+'/2147483648',processHeader+', '+processHeader]){
      expect((await post(sessions,acquire(),caller,invalid)).status).toBe(400);
    }
    expect((await sessions.snapshot()).leases).toEqual([]);
  });

  it('correlates auth and shape rejections without reflecting invalid input',async()=>{
    const {sessions}=await fixture();
    const observed:NativeHttpRejection[]=[];
    const observe=(event:NativeHttpRejection)=>observed.push(event);
    const unauthorized=await post(sessions,{action:'private-body'},null,processHeader,requestId,observe);
    const invalid=await post(sessions,{action:'private-body'},caller,processHeader,requestId,observe);
    const unsafe=await post(sessions,{action:'private-body'},caller,processHeader,'private-correlation',observe);
    expect(unauthorized.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(unauthorized.headers.get('x-request-id')).toBe(requestId);
    expect(invalid.headers.get('x-request-id')).toBe(requestId);
    expect(unsafe.headers.has('x-request-id')).toBe(false);
    expect(observed).toEqual([
      {status:401,code:'native-unauthorized',action:null,hostId:null,requestId},
      {status:400,code:'native-invalid-request',action:null,hostId:'mac',requestId},
      {status:400,code:'native-invalid-request',action:null,hostId:'mac'},
    ]);
  });

  it('does not apply delayed proof to a replacement lease or block concurrent native writes',async()=>{
    const {sessions,clock}=await fixture();
    const input=acquire();
    const old=await (await post(sessions,input)).json();
    clock(1001+NATIVE_LEASE_MS);
    let finish!:(value:boolean)=>void;
    let entered!:()=>void;
    const checking=new Promise<void>(resolve=>{entered=resolve;});
    const reconciled=sessions.reconcileNativeProcesses(async()=>{
      entered();
      return new Promise<boolean>(resolve=>{finish=resolve;});
    });
    // On base there is no check. Fail immediately if reconciliation returns first.
    expect(await Promise.race([checking.then(()=>true),reconciled.then(()=>false)])).toBe(true);
    expect(await sessions.withUpgradeSeal(async()=>sessions.upgradeBlockers())).toBe(1);
    await sessions.attestStopped(old.leaseId);
    const next=await (await post(sessions,acquire(),caller,`${binding.bootId}/23457`)).json();
    clock(1002+2*NATIVE_LEASE_MS);
    finish(true);
    expect(await reconciled).toBe(0);
    expect(await sessions.uncertainLeases()).toEqual([expect.objectContaining({leaseId:next.leaseId})]);
  });

  it('never checks a legacy task after restart or retrofits its binding',async()=>{
    const {sessions,kv}=await fixture();
    const input=acquire();
    const lease=await sessions.request(caller,input);
    const restarted=new NativeSessions(kv,()=>1001+NATIVE_LEASE_MS);
    await restarted.initialize();
    expect(await (await post(restarted,input)).json()).toEqual({error:'native-session-bound'});
    const checked:string[]=[];
    expect(await restarted.reconcileNativeProcesses(async hostId=>{checked.push(hostId);return true;})).toBe(0);
    expect(checked).toEqual([]);
    expect(await restarted.uncertainLeases()).toEqual([expect.objectContaining({leaseId:lease.leaseId})]);
  });
});
