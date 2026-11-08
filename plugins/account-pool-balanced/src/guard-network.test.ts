import {expect,it,vi} from 'vitest';
import {createGuardNetworkCheck} from './guard-network.js';
import {createVpnPolicy} from './vpn-policy.js';
import {accountPoolConfigSchema} from './contracts.js';

it('waits for a fresh permission within the Guard host-check budget',async()=>{
  vi.useFakeTimers();
  try {
    const read=vi.fn(()=>new Promise(resolve=>setTimeout(()=>resolve({schema:'bb-vpn-guard/network-decision/1',allowed:true,reason:'connected'}),1200)));
    const result=createGuardNetworkCheck(read)('codex').then(()=>({allowed:true}),error=>({allowed:false,error}));
    await vi.advanceTimersByTimeAsync(1200);
    expect(await result).toEqual({allowed:true});
  } finally {vi.useRealTimers();}
});

it('bounds two stalled reads to eight seconds and ignores a late allow',async()=>{
  vi.useFakeTimers();
  try {
    let signal:AbortSignal|undefined;
    let finish:(value:unknown)=>void=()=>{};
    const read=vi.fn((_provider,abortSignal:AbortSignal)=>{
      signal=abortSignal;
      return new Promise(resolve=>{finish=resolve;});
    });
    const result=createGuardNetworkCheck(read)('codex').catch(error=>error);
    await vi.advanceTimersByTimeAsync(7999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({code:'VPN_GUARD_UNAVAILABLE',failureReason:'timeout'});
    finish({schema:'bb-vpn-guard/network-decision/1',allowed:true,reason:'connected'});
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  } finally {vi.useRealTimers();}
});

it('reports only safe failure categories instead of leaking RPC errors',async()=>{
  const error=await createGuardNetworkCheck(async()=>{throw Error('private RPC payload');})('codex').catch(error=>error);
  expect(error).toMatchObject({code:'VPN_GUARD_UNAVAILABLE',failureReason:'rpc_failed'});
  expect(error.message).not.toContain('private RPC payload');
  await expect(createGuardNetworkCheck(async()=>({allowed:true}))('codex')).rejects.toMatchObject({failureReason:'invalid_decision'});
});

it('denies protected calls on manual block and ignores Chinese calls',async()=>{
  const read=vi.fn(async()=>({schema:'bb-vpn-guard/network-decision/1',allowed:false,reason:'manual_block'}));
  const check=createGuardNetworkCheck(read);
  await expect(check('codex')).rejects.toThrow('VPN_GUARD_BLOCKED');
  await expect(check('cursor')).rejects.toThrow('VPN_GUARD_BLOCKED');
  await check('kimi');await check('zai');expect(read).toHaveBeenCalledTimes(2);
});
it('fails closed on missing Guard, invalid decision or timeout',async()=>{
  for(const read of [async()=>{throw Error('not installed');},async()=>({allowed:true}),async()=>({schema:'other',allowed:true,reason:'connected'})]) {
    await expect(createGuardNetworkCheck(read)('devin')).rejects.toThrow('VPN_GUARD_UNAVAILABLE');
  }
});
it('rechecks every call and returns after unblock without a stale allow cache',async()=>{
  let blocked=false;
  const read=vi.fn(async()=>({schema:'bb-vpn-guard/network-decision/1',allowed:!blocked,reason:blocked?'manual_block':'observe'}));
  const check=createGuardNetworkCheck(read);
  await check('claude');blocked=true;await expect(check('claude')).rejects.toThrow('VPN_GUARD_BLOCKED');blocked=false;await check('claude');
  expect(read).toHaveBeenCalledTimes(3);
});
it('requires a Guard client when enabled even if VPN-only is disabled',async()=>{
  const config=accountPoolConfigSchema.parse({vpnGuardEnabled:true,vpnOnlyProviders:[]});
  const policy=createVpnPolicy(()=>config,Date.now,async()=> 'connected');
  await expect(policy.assert('codex')).rejects.toThrow('VPN_GUARD_UNAVAILABLE');
  await policy.assert('kimi');
});

it('bounds a stalled Guard decision and rejects inconsistent permission',async()=>{
  await expect(createGuardNetworkCheck(()=>new Promise(()=>{}),10)('codex')).rejects.toThrow('VPN_GUARD_UNAVAILABLE');
  await expect(createGuardNetworkCheck(async()=>({schema:'bb-vpn-guard/network-decision/1',allowed:true,reason:'manual_block'}))('claude')).rejects.toThrow('VPN_GUARD_UNAVAILABLE');
});

it('gates OpenCode Go as well as Devin, leaving only Kimi and Z.ai exempt',async()=>{
 const read=vi.fn(async()=>({schema:'bb-vpn-guard/network-decision/1',allowed:false,reason:'manual_block'}));
 const check=createGuardNetworkCheck(read);
 for(const p of ['codex','claude','cursor','devin','opencode-go'] as const)await expect(check(p)).rejects.toThrow('VPN_GUARD_BLOCKED');
 await check('kimi');await check('zai');expect(read).toHaveBeenCalledTimes(5);
 const config=accountPoolConfigSchema.parse({vpnGuardEnabled:true,vpnOnlyProviders:[]});
 await expect(createVpnPolicy(()=>config,Date.now,undefined,check).assert('opencode-go')).rejects.toThrow('VPN_GUARD_BLOCKED');
});


it('recovers one timeout with fresh permission and a fresh abort signal',async()=>{
 vi.useFakeTimers();
 try {
  const signals:AbortSignal[]=[];
  const read=vi.fn((_provider,signal:AbortSignal)=>{
   signals.push(signal);
   if(signals.length===1)return new Promise(()=>{});
   return Promise.resolve({schema:'bb-vpn-guard/network-decision/2',hostId:'server',allowed:true,reason:'direct'});
  });
  const result=createGuardNetworkCheck(read)('cursor').catch(e=>e);
  await vi.advanceTimersByTimeAsync(4000);
  expect(await result).toBe('direct');
  expect(read).toHaveBeenCalledTimes(2);
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
 }finally{vi.useRealTimers();}
});

it('honors a new manual block after timeout without retrying the denial',async()=>{
 vi.useFakeTimers();
 try {
  const read=vi.fn().mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValue({schema:'bb-vpn-guard/network-decision/1',allowed:false,reason:'manual_block'});
  const result=createGuardNetworkCheck(read)('cursor').catch(e=>e);
  await vi.advanceTimersByTimeAsync(4000);
  expect(await result).toMatchObject({code:'VPN_GUARD_BLOCKED'});
  expect(read).toHaveBeenCalledTimes(2);
 }finally{vi.useRealTimers();}
});


it('ignores a late first permission while the fresh check denies traffic',async()=>{
 vi.useFakeTimers();
 try {
  let finish:(value:unknown)=>void=()=>{};
  const read=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockImplementationOnce(()=>new Promise(resolve=>setTimeout(()=>resolve({schema:'bb-vpn-guard/network-decision/1',allowed:false,reason:'manual_block'}),100)));
  const result=createGuardNetworkCheck(read)('cursor').catch(e=>e);
  await vi.advanceTimersByTimeAsync(4000);
  finish({schema:'bb-vpn-guard/network-decision/1',allowed:true,reason:'connected'});
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({code:'VPN_GUARD_BLOCKED'});
  expect(read).toHaveBeenCalledTimes(2);
 }finally{vi.useRealTimers();}
});


it('shares only a pending read per provider and reads fresh after settlement',async()=>{
 let finish:(value:unknown)=>void=()=>{};
 const read=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));
 const check=createGuardNetworkCheck(read);
 const batch=Array.from({length:12},()=>check('cursor'));
 await Promise.resolve();
 expect(read).toHaveBeenCalledTimes(1);
 finish({schema:'bb-vpn-guard/network-decision/1',allowed:true,reason:'observe'});
 await Promise.all(batch);
 const fresh=check('cursor');await Promise.resolve();
 expect(read).toHaveBeenCalledTimes(2);
 finish({schema:'bb-vpn-guard/network-decision/1',allowed:false,reason:'manual_block'});
 await expect(fresh).rejects.toMatchObject({code:'VPN_GUARD_BLOCKED'});
});

it('shares the two-attempt deadline without extending it for later waiters',async()=>{
 vi.useFakeTimers();
 try {
  const read=vi.fn(()=>new Promise(()=>{}));const check=createGuardNetworkCheck(read);
  const first=check('cursor').catch(e=>e);
  await vi.advanceTimersByTimeAsync(7000);
  const later=Array.from({length:12},()=>check('cursor').catch(e=>e));
  await vi.advanceTimersByTimeAsync(1000);
  for(const error of await Promise.all([first,...later]))expect(error).toMatchObject({failureReason:'timeout'});
  expect(read).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
  const fresh=check('cursor').catch(e=>e);await vi.advanceTimersByTimeAsync(8000);await fresh;
  expect(read).toHaveBeenCalledTimes(4);
 }finally{vi.useRealTimers();}
});

it('isolates pending permissions by provider and checker instance',async()=>{
 let finish:(value:unknown)=>void=()=>{};
 const read=vi.fn((provider:string)=>provider==='cursor'?new Promise(resolve=>{finish=resolve;}):Promise.resolve({schema:'bb-vpn-guard/network-decision/1',allowed:false,reason:'manual_block'}));
 const check=createGuardNetworkCheck(read);const cursor=check('cursor');await Promise.resolve();
 await expect(check('claude')).rejects.toMatchObject({code:'VPN_GUARD_BLOCKED'});
 await expect(createGuardNetworkCheck(async()=>({schema:'bb-vpn-guard/network-decision/1',allowed:false,reason:'manual_block'}))('cursor')).rejects.toMatchObject({code:'VPN_GUARD_BLOCKED'});
 await check('kimi');await check('zai');expect(read).toHaveBeenCalledTimes(2);
 finish({schema:'bb-vpn-guard/network-decision/1',allowed:true,reason:'observe'});await cursor;
});

it.each([
 [{schema:'bb-vpn-guard/network-decision/1',allowed:false,reason:'manual_block'},'VPN_GUARD_BLOCKED'],
 [{allowed:true},'VPN_GUARD_UNAVAILABLE'],
])('shares a denial without retry or a retained result',async(value,code)=>{
 const read=vi.fn(async()=>value);const check=createGuardNetworkCheck(read);
 const batch=Array.from({length:12},()=>check('cursor').catch(e=>e));
 for(const error of await Promise.all(batch))expect(error.code).toBe(code);
 expect(read).toHaveBeenCalledTimes(1);
 await expect(check('cursor')).rejects.toMatchObject({code});expect(read).toHaveBeenCalledTimes(2);
});

it('keeps concurrent host/RPC/host reads within a serialized SDK budget',async()=>{
 vi.useFakeTimers();
 try {
  let tail=Promise.resolve();
  const rpc=(signal:AbortSignal)=>{
   const result=tail.then(async()=>{signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,20));signal.throwIfAborted();});
   tail=result.catch(()=>{});return result;
  };
  const read=vi.fn(async(_provider,signal:AbortSignal)=>{
   await rpc(signal);await rpc(signal);await rpc(signal);
   return {schema:'bb-vpn-guard/network-decision/1',allowed:true,reason:'observe'};
  });
  const check=createGuardNetworkCheck(read,100);
  const results=Promise.all(Array.from({length:12},()=>check('cursor').then(()=>true,()=>false)));
  await vi.advanceTimersByTimeAsync(1000);
  expect(await results).toEqual(Array(12).fill(true));expect(read).toHaveBeenCalledTimes(1);
 }finally{vi.useRealTimers();}
});
