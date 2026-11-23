import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {NativeSessions,nativeHttp,type NativeCaller} from './native-sessions.js';
const caller:NativeCaller={hostId:'example-client',projectId:'example-project'};
const executor={id:'example-executor',accountId:'example-account',hostId:'example-host',callerIds:[caller.hostId],
 catalogCallerIds:['example-catalog'],projectIds:[caller.projectId!],enabled:true,autopilotAllowed:false,
 execution:{runtimeId:'example-runtime',gatewayId:'example-gateway',runtimeSha256:'a'.repeat(64),profile:{id:'example-exit',version:2}},
 unlock:{profile:'example-unlock',operation:'prepared-native-keyring-unlock' as const}};
async function fixture(){
 let data:unknown,now=Date.now(),fail=false,admitted=true,prepared=true;
 const kv={get:async<T>()=>structuredClone(data) as T,set:async(_k:string,v:unknown)=>{if(fail)throw Error('storage');data=structuredClone(v);}};
 const calls:{id:string;signal:AbortSignal}[]=[];let finish!:()=>void;
 const sessions=new NativeSessions(kv,()=>now,async()=>{if(!admitted)throw Error('policy');},()=>{if(!prepared)throw Error('preparation');},
  async(id,signal)=>{calls.push({id,signal});await new Promise<void>(resolve=>finish=resolve);});
 await sessions.initialize();await sessions.configure(executor);await sessions.setManaged(true);
 const active=await sessions.request(caller,{action:'acquire',executorId:executor.id,sessionId:randomUUID()});
 return {sessions,active,calls,kv,finish:()=>finish(),fail:()=>fail=true,deny:()=>admitted=false,unprepare:()=>prepared=false,
  advance:(ms:number)=>now+=ms,stored:()=>structuredClone(data) as any};
}
async function issued(f:Awaited<ReturnType<typeof fixture>>){return f.sessions.request(caller,{action:'unlock-start',leaseId:f.active.leaseId!});}

it('persists issued then consumed before returning immutable task authority; completion precedes release',async()=>{
 const f=await fixture();const ticket=await issued(f);expect(f.stored().leases[0].unlock.state).toBe('issued');
 expect(f.calls).toHaveLength(1);const assignment=await f.sessions.claimUnlock(ticket.requestId!);
 expect(f.stored().leases[0].unlock.state).toBe('consumed');
 expect(assignment).toMatchObject({requestId:ticket.requestId,profile:executor.unlock.profile,binding:{...f.active.binding,kind:'task'}});
 await expect(f.sessions.claimUnlock(ticket.requestId!)).rejects.toThrow('native-unlock-consumed');
 await expect(issued(f)).rejects.toThrow('already-issued');
 await expect(f.sessions.request(caller,{action:'release',leaseId:f.active.leaseId,stopped:true})).rejects.toThrow('stop-unconfirmed');
 f.finish();await setImmediate();
 expect((await f.sessions.request(caller,{action:'poll',leaseId:f.active.leaseId})).unlock?.state).toBe('completed');
 await f.sessions.request(caller,{action:'release',leaseId:f.active.leaseId,stopped:true});await f.sessions.close();
});
it('restart preserves consume and quarantines instead of replaying or freeing the account',async()=>{
 const f=await fixture(),ticket=await issued(f);await f.sessions.claimUnlock(ticket.requestId!);
 const restarted=new NativeSessions(f.kv,Date.now,async()=>{},()=>{});await restarted.initialize();
 await expect(restarted.claimUnlock(ticket.requestId!)).rejects.toThrow();
 await expect(restarted.request(caller,{action:'release',leaseId:f.active.leaseId,stopped:true})).rejects.toThrow('unlock-stop-unconfirmed');
 expect((await restarted.snapshot()).leases[0].state).toBe('uncertain');
 await f.sessions.close();
});
it('lookup never receives assignment if durable consume fails',async()=>{
 const f=await fixture(),ticket=await issued(f);f.fail();
 await expect(f.sessions.claimUnlock(ticket.requestId!)).rejects.toThrow('storage-unavailable');
 expect(f.stored().leases[0].unlock.state).toBe('issued');await f.sessions.close();
});
it.each(['policy','preparation','expiry','managed'] as const)('revalidates %s before consume',async boundary=>{
 const f=await fixture(),ticket=await issued(f);
 if(boundary==='policy')f.deny();if(boundary==='preparation')f.unprepare();if(boundary==='expiry')f.advance(25_001);
 if(boundary==='managed')await f.sessions.setManaged(false);
 await expect(f.sessions.claimUnlock(ticket.requestId!)).rejects.toThrow();await f.sessions.close();
});
it('rejects catalog, foreign caller and caller supplied route/assignment; ordinary default remains unchanged',async()=>{
 const f=await fixture();
 await expect(f.sessions.request({...caller,hostId:'foreign'},{action:'unlock-start',leaseId:f.active.leaseId})).rejects.toThrow();
 await expect(f.sessions.request(caller,{action:'unlock-start',leaseId:f.active.leaseId,profile:'foreign'})).rejects.toThrow();
 await f.sessions.request(caller,{action:'release',leaseId:f.active.leaseId,stopped:true});
 const catalog={...caller,hostId:'example-catalog'},active=await f.sessions.request(catalog,{action:'acquire',executorId:executor.id,sessionId:randomUUID(),kind:'catalog'});
 await expect(f.sessions.request(catalog,{action:'unlock-start',leaseId:active.leaseId})).rejects.toThrow();expect(f.calls).toHaveLength(0);
 await f.sessions.request(catalog,{action:'release',leaseId:active.leaseId,stopped:true});
 const {unlock,...ordinary}=executor;await f.sessions.configure(ordinary);
 const next=await f.sessions.request(caller,{action:'acquire',executorId:executor.id,sessionId:randomUUID()});expect(next.unlock).toBeUndefined();
 await expect(f.sessions.request(caller,{action:'unlock-start',leaseId:next.leaseId})).rejects.toThrow();await f.sessions.close();
});
it('cancel and aborted RPC keep an uncertain lease even when the caller says stopped',async()=>{
 const f=await fixture();const ticket=await issued(f);await f.sessions.claimUnlock(ticket.requestId!);
 expect(await f.sessions.request(caller,{action:'unlock-cancel',leaseId:f.active.leaseId})).toEqual({stopped:false});
 expect(f.calls[0].signal.aborted).toBe(true);expect((await f.sessions.snapshot()).leases[0].state).toBe('uncertain');
 await expect(f.sessions.request(caller,{action:'release',leaseId:f.active.leaseId,stopped:true})).rejects.toThrow();await f.sessions.close();
});
it('existing bearer HTTP handler does not accept a caller task token or unauthenticated start',async()=>{
 const f=await fixture();
 const request=(token:string)=>new Request('https://example.invalid/native/agy',{method:'POST',headers:{authorization:'Bearer '+token},
 body:JSON.stringify({action:'unlock-start',leaseId:f.active.leaseId})});
 const auth=async(token:string|null)=>token==='example-bearer'?caller:null;
 expect((await nativeHttp(request('caller-label'),f.sessions,auth)).status).toBe(401);
 const result=await nativeHttp(request('example-bearer'),f.sessions,auth);expect(result.status).toBe(200);
 const value=await result.json();expect(value).toHaveProperty('requestId');expect(value).not.toHaveProperty('binding');
 await f.sessions.close();
});
it('finite operation deadline aborts the RPC and cannot become a completed lease',async()=>{
 const {vi}=await import('vitest');vi.useFakeTimers();
 try{
  const f=await fixture(),ticket=await issued(f);await f.sessions.claimUnlock(ticket.requestId!);
  await vi.advanceTimersByTimeAsync(25_001);
  expect(f.calls[0].signal.aborted).toBe(true);expect((await f.sessions.snapshot()).leases[0].state).toBe('uncertain');
  f.finish();await vi.advanceTimersByTimeAsync(0);
  await expect(f.sessions.request(caller,{action:'release',leaseId:f.active.leaseId,stopped:true})).rejects.toThrow();await f.sessions.close();
 }finally{vi.useRealTimers();}
});
