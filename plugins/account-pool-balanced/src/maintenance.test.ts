import {describe,it,expect,vi} from 'vitest';
import {PoolMaintenance} from './maintenance.js';

const owner='11111111-1111-4111-8111-111111111111';
const foreign='22222222-2222-4222-8222-222222222222';
describe('persisted pool admission pause',()=>{
  it('survives reload, cancels the old admission generation and preserves ownership',async()=>{
    let stored:unknown;
    let now=100;
    const save=async(value:unknown)=>{stored=structuredClone(value);};
    const first=new PoolMaintenance(save,()=>now);
    const old=first.signal;
    const acquired=await first.acquire(owner);
    expect(old.aborted).toBe(true);
    expect(()=>first.assertAllowed()).toThrow('maintenance');
    expect(await first.acquire(owner)).toEqual(acquired);
    await expect(first.acquire(foreign)).rejects.toThrow('Another operation');
    const reloaded=new PoolMaintenance(save,()=>now);
    await reloaded.initialize(stored);
    expect(reloaded.status()).toEqual(acquired);
    await expect(reloaded.release(foreign)).rejects.toThrow('another operation');
    await reloaded.release(owner);
    expect(reloaded.signal.aborted).toBe(false);
    expect(old.aborted).toBe(true);
    expect(stored).toBeNull();
    await first.acquire(owner);
    now=1_800_101;
    expect(first.status().lease).toBeNull();
    expect(first.signal.aborted).toBe(false);
  });
  it('never acknowledges an unpersisted pause or an unpersisted release',async()=>{
    let fail=true;
    const gate=new PoolMaintenance(async()=>{if(fail)throw Error('storage failed');});
    await expect(gate.acquire(owner)).rejects.toThrow('storage failed');
    expect(gate.signal.aborted).toBe(false);
    fail=false;await gate.acquire(owner);
    fail=true;await expect(gate.release(owner)).rejects.toThrow('storage failed');
    expect(gate.status().lease?.owner).toBe(owner);
    expect(gate.signal.aborted).toBe(true);
  });
  it('fails closed on malformed persisted state instead of silently opening the pool',async()=>{
    await expect(new PoolMaintenance(async()=>{}).initialize({owner,expiresAt:1})).rejects.toThrow();
  });
});

describe('graceful pool admission',()=>{
  it('blocks new admission while preserving active transport signals through acquire and release',async()=>{
    let activity=1;
    const gate=new PoolMaintenance(async()=>{},Date.now,()=>activity);
    const signal=gate.signal;
    await gate.acquireGraceful(owner);
    expect(signal.aborted).toBe(false);
    expect(()=>gate.assertAllowed()).toThrow('maintenance');
    expect(gate.status().transportInFlight).toBe(1);
    await expect(gate.acquireGraceful(foreign)).rejects.toThrow();
    activity=0;
    await gate.release(owner);
    expect(signal.aborted).toBe(false);
    expect(()=>gate.assertAllowed()).not.toThrow();
  });
  it('does not acknowledge or block admission when graceful persistence fails',async()=>{
    const gate=new PoolMaintenance(async()=>{throw Error('storage failed');});
    await expect(gate.acquireGraceful(owner)).rejects.toThrow('storage failed');
    expect(gate.signal.aborted).toBe(false);
    expect(()=>gate.assertAllowed()).not.toThrow();
  });
});


it('seals drained upgrade admission, persists it and wakes parked requests only on release', async()=>{
  let stored:unknown;
  const save=async(value:unknown)=>{stored=structuredClone(value);};
  const gate=new PoolMaintenance(save);
  await gate.acquireUpgrade(owner);
  const resumed=vi.fn();
  const held=gate.waitForUpgrade(new AbortController().signal)!.then(resumed);
  const canceled=new AbortController();
  const pendingCancellation=expect(gate.waitForUpgrade(canceled.signal)).rejects.toThrow('client canceled');
  canceled.abort(new Error('client canceled'));
  await pendingCancellation;
  await expect(gate.sealUpgrade(foreign)).rejects.toThrow('not owned');
  expect((await gate.sealUpgrade(owner)).lease?.upgrade).toBe('sealed');
  expect(resumed).not.toHaveBeenCalled();
  const reloaded=new PoolMaintenance(save);
  await reloaded.initialize(stored);
  expect(()=>reloaded.assertAllowed()).toThrow('maintenance');
  await gate.release(owner);
  await held;
  expect(resumed).toHaveBeenCalledTimes(1);
  expect(gate.waitForUpgrade(new AbortController().signal)).toBeUndefined();
});


it('keeps one live admission generation across an upgrade refusal for a later hard pause', async()=>{
  let now=100;
  const gate=new PoolMaintenance(async()=>{},()=>now);
  const original=gate.signal;
  await gate.acquire(owner);
  expect(original.aborted).toBe(true);
  now+=1_800_001;
  await gate.acquireUpgrade(owner);
  const duringUpgrade=gate.signal;
  expect(duringUpgrade.aborted).toBe(false);
  await gate.release(owner);
  expect(gate.signal).toBe(duringUpgrade);
  await gate.acquire(foreign);
  expect(duringUpgrade.aborted).toBe(true);
});
