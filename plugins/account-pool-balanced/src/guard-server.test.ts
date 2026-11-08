import {expect,it,vi} from 'vitest';
import {createGuardNetworkCheck,type GuardDiagnostic} from './guard-network.js';
import {serverGuardRead,runGuardProbe,guardProbeSchema,type GuardServerAccess} from './guard-server.js';

const host='host_poolserver';
const direct={schema:'bb-vpn-guard/network-decision/2',hostId:host,allowed:true,reason:'direct'};
function access():GuardServerAccess{return {serverHost:vi.fn(async()=>host),decision:vi.fn(async()=>direct)};}

for(const stage of ['server-host','guard-rpc','server-host-recheck'] as const){
 it(`rehearses a timeout at ${stage}, then obtains fresh permission`,async()=>{
  const a=access();const result=await runGuardProbe(a,{provider:'cursor',delayStage:stage,delayMs:30,delayAttempts:'first'},10);
  expect(result.allowed).toBe(true);
  expect(result.events).toMatchObject([{attempt:1,stage,outcome:'timeout'},{attempt:2,outcome:'direct'}]);
  expect(result.events[0].checkId).toBe(result.events[1].checkId);
 });
 it(`fails closed after persistent delays at ${stage}`,async()=>{
  const result=await runGuardProbe(access(),{provider:'cursor',delayStage:stage,delayMs:30,delayAttempts:'all'},10);
  expect(result).toMatchObject({allowed:false,code:'VPN_GUARD_UNAVAILABLE',reason:'timeout'});
  expect(result.events).toMatchObject([{attempt:1,stage,outcome:'timeout'},{attempt:2,stage,outcome:'timeout'}]);
 });
}
it('does not advance a late aborted host lookup into a Guard RPC',async()=>{
 vi.useFakeTimers();
 try{
  let finish:(s:string)=>void=()=>{};
  const a=access();vi.mocked(a.serverHost).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const events:GuardDiagnostic[]=[];
  const check=createGuardNetworkCheck(serverGuardRead(a),10,e=>events.push(e));
  const result=check('cursor');await vi.advanceTimersByTimeAsync(10);
  expect(await result).toBe('direct');expect(a.decision).toHaveBeenCalledTimes(1);
  const recorded=JSON.stringify(events);
  finish(host);await vi.advanceTimersByTimeAsync(1);
  expect(a.decision).toHaveBeenCalledTimes(1);expect(JSON.stringify(events)).toBe(recorded);
 }finally{vi.useRealTimers();}
});
it('denies migration during the RPC and never logs arbitrary error data',async()=>{
 const a=access();vi.mocked(a.serverHost).mockResolvedValueOnce(host).mockResolvedValueOnce('host_different');
 const events:GuardDiagnostic[]=[];
 await expect(createGuardNetworkCheck(serverGuardRead(a),10,e=>events.push(e))('cursor')).rejects.toMatchObject({failureReason:'rpc_failed'});
 expect(events).toMatchObject([{stage:'validate-host',outcome:'rpc_failed'}]);
 const b=access();vi.mocked(b.decision).mockRejectedValue(Error('PRIVATE_CREDENTIAL_SENTINEL'));
 await expect(createGuardNetworkCheck(serverGuardRead(b),10,e=>events.push(e))('cursor')).rejects.toMatchObject({failureReason:'rpc_failed'});
 expect(JSON.stringify(events)).not.toContain('PRIVATE_CREDENTIAL_SENTINEL');
 expect(b.decision).toHaveBeenCalledTimes(1);
});
it('diagnostic failures cannot grant or deny permission',async()=>{
 await expect(createGuardNetworkCheck(serverGuardRead(access()),10,()=>{throw Error('log failed');})('cursor')).resolves.toBe('direct');
 const a=access();vi.mocked(a.decision).mockResolvedValue({...direct,allowed:false,reason:'manual_block'});
 await expect(createGuardNetworkCheck(serverGuardRead(a),10,()=>{throw Error('log failed');})('cursor')).rejects.toMatchObject({code:'VPN_GUARD_BLOCKED'});
 expect(a.decision).toHaveBeenCalledTimes(1);
});
it('shares parallel timeouts while retaining fresh host binding and one diagnostic per read',async()=>{
 vi.useFakeTimers();
 try{
  const a=access(),calls=new Map<AbortSignal,number>();
  const read=serverGuardRead(a),events:GuardDiagnostic[]=[];
  const check=createGuardNetworkCheck(async(p,s,t)=>{
   calls.set(s,1);
   if(t.attempt===1){t.stage('server-host');return new Promise(()=>{});}
   return read(p,s,t);
  },10,e=>events.push(e));
  const results=Array.from({length:32},()=>check('cursor'));
  await vi.advanceTimersByTimeAsync(10);
  expect(await Promise.all(results)).toEqual(Array(32).fill('direct'));
  expect(calls.size).toBe(2);expect(events).toHaveLength(2);
  expect(new Set(events.map(e=>e.checkId)).size).toBe(1);
  expect(a.decision).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
 }finally{vi.useRealTimers();}
});
it('bounds probe inputs and does not change policy or access a provider',async()=>{
 expect(()=>guardProbeSchema.parse({provider:'cursor',delayMs:4501})).toThrow();
 expect(()=>guardProbeSchema.parse({provider:'cursor',delayStage:'untrusted'})).toThrow();
 const a=access();vi.mocked(a.decision).mockResolvedValue({...direct,allowed:false,reason:'manual_block'});
 const result=await runGuardProbe(a,guardProbeSchema.parse({provider:'cursor'}));
 expect(result).toMatchObject({allowed:false,code:'VPN_GUARD_BLOCKED'});
 expect(a.decision).toHaveBeenCalledTimes(1);
});
