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

it('cancels a stalled RPC at the shared deadline and ignores a late allow',async()=>{
  vi.useFakeTimers();
  try {
    let signal:AbortSignal|undefined;
    let finish:(value:unknown)=>void=()=>{};
    const read=vi.fn((_provider,abortSignal:AbortSignal)=>{
      signal=abortSignal;
      return new Promise(resolve=>{finish=resolve;});
    });
    const result=createGuardNetworkCheck(read)('codex').catch(error=>error);
    await vi.advanceTimersByTimeAsync(3999);
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
