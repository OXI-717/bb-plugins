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
    {accountId:'subscription-one',projects:{onlySelected:true,rules:[{projectId:'project-one',role:'inherit'}]},projectsRevision:expect.any(String),mixedProjects:false,executors:[{id:'mac-official',enabled:true,autopilotAllowed:false},{id:'worker-official',enabled:true,autopilotAllowed:true}],active:1,queued:1,uncertain:0},
    {accountId:'subscription-two',projects:{onlySelected:true,rules:[{projectId:'project-one',role:'inherit'}]},projectsRevision:expect.any(String),mixedProjects:false,executors:[{id:'disabled-official',enabled:false,autopilotAllowed:false}],active:0,queued:0,uncertain:0},
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
  it('rejects changes during a lease, unknown subscriptions and unsupported project roles',async()=>{
    const {sessions}=await fixture();const account=(await sessions.accounts()).accounts[0];
    const lease=await sessions.request(caller,acquire());
    await expect(sessions.setProjects(executor.accountId,{onlySelected:false,rules:[]},account.projectsRevision)).rejects.toThrow('native-executor-busy');
    await sessions.request(caller,release(lease.leaseId!));
    await expect(sessions.setProjects('missing',{onlySelected:false,rules:[]},account.projectsRevision)).rejects.toThrow('native-account-not-found');
    await expect(sessions.setProjects(executor.accountId,{onlySelected:true,rules:[{projectId:'project-one',role:'primary'}]},account.projectsRevision)).rejects.toThrow();
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
