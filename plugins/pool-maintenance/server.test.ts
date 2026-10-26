import { afterEach,describe,expect,it,vi } from 'vitest';
import { createFakePluginHost,makeMessageDispatchHookContext } from '@get-bb/plugin-sdk/testing';
import plugin from './server.js';
import { MaintenanceLease } from './lease.js';
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
afterEach(()=>vi.restoreAllMocks());
describe('bounded owner pause',()=>{
  it('serializes competing acquisition, forbids foreign release and never extends a repeated acquire',async()=>{
    const store=vi.fn(async()=>{});const lease=new MaintenanceLease(store,()=>1000);
    const results=await Promise.allSettled([lease.acquire(A),lease.acquire(B)]);
    expect(results.map(x=>x.status)).toEqual(['fulfilled','rejected']);
    await expect(lease.release(B)).rejects.toThrow('another operation');
    expect(await lease.acquire(A)).toEqual({owner:A,createdAt:1000,expiresAt:1801000});
    expect(store).toHaveBeenCalledTimes(1);
  });
  it('uses one clock observation for the persisted duration',async()=>{
    let now=1000;let saved:unknown;
    const lease=new MaintenanceLease(async value=>{saved=value;},()=>now++);
    await lease.acquire(A);
    const restarted=new MaintenanceLease(async()=>{},()=>1005);
    await restarted.initialize(saved);expect(restarted.status()?.owner).toBe(A);
  });
  it('failed persistence does not activate pause',async()=>{
    const lease=new MaintenanceLease(async()=>{throw Error('storage failure');});
    await expect(lease.acquire(A)).rejects.toThrow('storage failure');expect(lease.status()).toBeNull();
  });
  it('expires across restart and old owner cannot release a newer lease',async()=>{
    let now=1000;let stored:unknown;
    const save=async(x:unknown)=>{stored=x;};const lease=new MaintenanceLease(save,()=>now);
    await lease.acquire(A);const restart=new MaintenanceLease(save,()=>now);await restart.initialize(stored);
    expect(restart.status()?.owner).toBe(A);now=1801001;expect(restart.status()).toBeNull();
    await restart.acquire(B);await expect(restart.release(A)).rejects.toThrow('another operation');expect(restart.status()?.owner).toBe(B);
    now=3601002;const expired=new MaintenanceLease(save,()=>now);await expired.initialize(stored);expect(expired.status()).toBeNull();expect(stored).toBeNull();
  });
  it('rejects malformed and unbounded persisted state',async()=>{
    const lease=new MaintenanceLease(async()=>{});
    await expect(lease.initialize({owner:A,createdAt:0,expiresAt:1e15})).rejects.toThrow();
  });
});
describe('BB dispatch queue integration',()=>{
  it('holds every dispatch including joins/retries on every host, persists reload, releases with recheck',async()=>{
    let {bb,harness}=createFakePluginHost({pluginId:'pool-maintenance'});
    try{
      await plugin(bb);
      const call=(args:string[])=>harness.behavior.runCli(args);
      expect((await call(['acquire','--owner',A,'--json'])).exitCode).toBe(0);
      const hook=harness.registrations.hooks['message.dispatch'];expect(hook).not.toBeNull();
      for(const attempt of ['start-turn','join-turn'] as const){
        const decision=await hook!(makeMessageDispatchHookContext({attempt}));
        expect(decision).toMatchObject({action:'wait',sendAt:expect.any(Number)});
        expect(JSON.stringify(decision)).not.toContain('reject');
      }
      ({bb,harness}=await harness.lifecycle.reload(plugin));
      expect(await harness.registrations.hooks['message.dispatch']!(makeMessageDispatchHookContext())).toMatchObject({action:'wait'});
      expect((await call(['release','--owner',B,'--json'])).exitCode).not.toBe(0);
      const released=await call(['release','--owner',A,'--json']);expect(released.exitCode,JSON.stringify(released)).toBe(0);
      expect(await harness.registrations.hooks['message.dispatch']!(makeMessageDispatchHookContext())).toEqual({action:'proceed'});
      expect(harness.inspection.recheckCount).toBe(1);
      expect(harness.inspection.sdk.calls).toEqual([]);
    }finally{await harness.lifecycle.dispose();}
  });
  it('clock expiry clears dispatch decision without a watchdog or model call',async()=>{
    let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now);
    let {bb,harness}=createFakePluginHost({pluginId:'pool-maintenance'});
    try{
      await plugin(bb);await harness.behavior.runCli(['acquire','--owner',A,'--json']);
      now=1801001;
      expect(await harness.registrations.hooks['message.dispatch']!(makeMessageDispatchHookContext())).toEqual({action:'proceed'});
    }finally{await harness.lifecycle.dispose();}
  });
});
