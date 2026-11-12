import {describe,it,expect} from 'vitest';
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
