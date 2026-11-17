import {it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {NativeSessions,NATIVE_LEASE_MS} from './native-sessions.js';
import type {NativeProbeResult} from './native-probe-wire.js';
const input={accountId:'account-two',executorId:'executor-two',hostId:'host-one',projectId:'project-one',model:'model-one'};
const caller={hostId:input.hostId,projectId:input.projectId};
async function fixture(){
 let stored:unknown;
 const admit=vi.fn(async()=>{});
 const sessions=new NativeSessions({get:async<T>()=>stored as T,set:async(_key,value)=>{stored=structuredClone(value);}},Date.now,admit);
 await sessions.initialize();await sessions.setManaged(true);
 await sessions.configure({id:input.executorId,accountId:input.accountId,hostId:input.hostId,callerIds:[input.hostId],projectIds:[input.projectId],enabled:false});
 return {sessions,admit};
}
it('consumes one diagnostic reservation while normal sessions remain disabled',async()=>{
 const {sessions,admit}=await fixture();
 expect(await sessions.executorFor(caller)).toBeNull();
 const result=await sessions.probe(input,async()=>true,async request=>{
  const sessionId=randomUUID();
  const acquire={action:'acquire',kind:'diagnostic',executorId:input.executorId,sessionId};
  await expect(sessions.request(caller,acquire)).rejects.toThrow('native-diagnostic-denied');
  const lease=await sessions.request(caller,acquire,request.token);
  expect(lease.diagnostic).toEqual({...input,reservationId:request.reservationId,sessionId});
  await expect(sessions.request(caller,acquire,request.token)).rejects.toThrow('native-diagnostic-consumed');
  await expect(sessions.request(caller,{action:'acquire',executorId:input.executorId,sessionId:randomUUID()},request.token)).rejects.toThrow('native-diagnostic-only');
  await expect(sessions.request(caller,{action:'unlock-start',leaseId:lease.leaseId},request.token)).rejects.toThrow('native-diagnostic-only');
  await sessions.request(caller,{action:'poll',leaseId:lease.leaseId},request.token);
  await sessions.request(caller,{action:'release',leaseId:lease.leaseId,stopped:true},request.token);
  return {...input,status:'model-responded',verified:true,observedAt:Date.now(),catalog:['model-one']};
 });
 expect(result.status).toBe('model-responded');expect(admit).toHaveBeenCalled();
 expect(await sessions.executorFor(caller)).toBeNull();expect((await sessions.snapshot()).leases).toEqual([]);
});
it('does not declare success if a diagnostic still owns a lease',async()=>{
 const {sessions}=await fixture();
 const result=await sessions.probe(input,async()=>true,async request=>{
  await sessions.request(caller,{action:'acquire',kind:'diagnostic',executorId:input.executorId,sessionId:randomUUID()},request.token);
  return {...input,status:'model-responded',verified:true,observedAt:Date.now(),catalog:['model-one']};
 });
 expect(result).toMatchObject({status:'stop-unconfirmed',verified:false});
 await expect(sessions.probe(input,async()=>true,async()=>{throw Error();})).rejects.toThrow('native-diagnostic-busy');
});
it('enforces maintenance, caller, project and capability checks without a lease',async()=>{
 const {sessions}=await fixture();const launch=vi.fn<()=>Promise<NativeProbeResult>>();
 expect((await sessions.probe(input,async()=>false,launch)).status).toBe('runtime-unavailable');
 await expect(sessions.probe({...input,projectId:'foreign'},async()=>true,launch)).rejects.toThrow('native-diagnostic-denied');
 sessions.admissionCheck=()=>{throw Error('POOL_MAINTENANCE');};
 await expect(sessions.probe(input,async()=>true,launch)).rejects.toThrow('POOL_MAINTENANCE');
 expect(launch).not.toHaveBeenCalled();expect((await sessions.snapshot()).leases).toEqual([]);
});

it('preflight is blocked on unsupported host without a reservation or provider call',async()=>{
 const {sessions}=await fixture();
 const before=await sessions.snapshot();
 const result=await sessions.preflight(input,async()=>({protocol:0}));
 expect(result).toMatchObject({status:'blocked',providerInference:false,checks:{protocol:false}});
 expect(await sessions.snapshot()).toEqual(before);
 expect((await sessions.preflight(input,async()=>({protocol:1}))).status).toBe('ready');
});

it.each([false,true])('preflight refuses prepared execution (unlock=%s) just like probe',async unlock=>{
 const execution={runtimeId:'runtime-one',gatewayId:'gateway-one',runtimeSha256:'a'.repeat(64),profile:{id:'profile-one',version:1}};
 const sessions=new NativeSessions({get:async()=>null,set:async()=>{}},Date.now,async()=>{},()=>{});
 await sessions.initialize();await sessions.setManaged(true);
 await sessions.configure({id:input.executorId,accountId:input.accountId,hostId:input.hostId,callerIds:[input.hostId],projectIds:[input.projectId],enabled:false,
  execution,...(unlock?{unlock:{profile:'profile-one',operation:'prepared-native-keyring-unlock'}}:{})});
 expect(await sessions.preflight(input,async()=>({protocol:1}))).toMatchObject({status:'blocked',checks:{runtime:false}});
 const launch=vi.fn<()=>Promise<NativeProbeResult>>();
 expect(await sessions.probe(input,async()=>true,launch)).toMatchObject({status:'runtime-unavailable',verified:false});
 expect(launch).not.toHaveBeenCalled();
});

it('preflight applies the same execution validator without launching',async()=>{
 let valid=true;
 const sessions=new NativeSessions({get:async()=>null,set:async()=>{}},Date.now,async()=>{},()=>{if(!valid)throw Error('invalid profile');});
 await sessions.initialize();await sessions.setManaged(true);
 await sessions.configure({id:input.executorId,accountId:input.accountId,hostId:input.hostId,callerIds:[input.hostId],projectIds:[input.projectId]});
 valid=false;
 expect(await sessions.preflight(input,async()=>({protocol:1}))).toMatchObject({status:'blocked',checks:{runtime:false}});
});

it('preflight does not write, sweep expired active or queued leases, or change events',async()=>{
 let now=1000,stored:unknown,writes=0;
 const sessions=new NativeSessions({get:async<T>()=>structuredClone(stored) as T,set:async(_key,value)=>{writes++;stored=structuredClone(value);}},()=>now);
 await sessions.initialize();await sessions.setManaged(true);
 await sessions.configure({id:input.executorId,accountId:input.accountId,hostId:input.hostId,callerIds:[input.hostId],projectIds:[input.projectId],enabled:true});
 await sessions.request(caller,{action:'acquire',executorId:input.executorId,sessionId:randomUUID()});
 await sessions.request(caller,{action:'acquire',executorId:input.executorId,sessionId:randomUUID()});
 const before=structuredClone(stored),beforeWrites=writes;
 now+=NATIVE_LEASE_MS+1;
 const first=await sessions.preflight(input,async()=>({protocol:1}));
 expect(first).toMatchObject({status:'blocked',checks:{idle:false},leases:[{state:'active',expired:true},{state:'queued',expired:true}]});
 expect(await sessions.preflight(input,async()=>({protocol:1}))).toEqual(first);
 expect(writes).toBe(beforeWrites);expect(stored).toEqual(before);
 // A normal transaction still performs expiry recovery after the read-only audit.
 const recovered=await sessions.snapshot();
 expect(recovered.leases).toMatchObject([{state:'uncertain'}]);
 expect(recovered.events.length).toBe((before as {events:unknown[]}).events.length+1);
});
