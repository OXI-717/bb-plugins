import {vpnProof} from './vpn-test-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import type { open } from 'node:fs/promises';
import { trustedRead, readVpnState } from './trusted-read.js';
const now = 1_800_000_000_000;
const body = Buffer.from(JSON.stringify(vpnProof(now)));
const handle = (options: { uid?: number; mode?: number; size?: number; regular?: boolean; bytes?: Buffer } = {}) => ({
  stat: async () => ({uid:options.uid ?? 0, mode:options.mode ?? 0o100644, size:options.size ?? body.length, isFile:()=>options.regular ?? true}),
  read: async (buffer: Buffer) => { const bytes = options.bytes ?? body; bytes.copy(buffer); return {bytesRead:bytes.length}; },
  close: vi.fn(async()=>{}),
});
describe('trusted state read', () => {
  it('accepts root-owned regular bounded content', async()=>expect(await trustedRead('/synthetic/state', (async()=>handle()) as unknown as typeof open)).toEqual(JSON.parse(body.toString())));
  it.each([{uid:501},{mode:0o100666},{size:4097},{regular:false}])('rejects untrusted inode', async opts=>expect(await trustedRead('/synthetic/state', (async()=>handle(opts)) as unknown as typeof open)).toBeNull());
  it('coalesces stalled reads and fails closed at timeout', async()=>{
    vi.useFakeTimers();
    let release!:(value:ReturnType<typeof handle>)=>void;
    const opener=vi.fn(()=>new Promise<ReturnType<typeof handle>>(resolve=>{release=resolve;}));
    const first=readVpnState('/synthetic/stalled',()=>now,opener as unknown as typeof open);
    const second=readVpnState('/synthetic/stalled',()=>now,opener as unknown as typeof open);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await Promise.all([first,second])).toEqual(['unknown','unknown']);
    expect(opener).toHaveBeenCalledTimes(1);
    release(handle());await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });
});

it('retries a healthy read after a timed-out read that still has not settled',async()=>{
 vi.useFakeTimers();
 let finish!:(value:ReturnType<typeof handle>)=>void;
 const opener=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockImplementation(async()=>handle());
 try{
  const first=readVpnState('/synthetic/recovered',()=>now,opener as unknown as typeof open);
  await vi.advanceTimersByTimeAsync(1001);expect(await first).toBe('unknown');
  expect(await readVpnState('/synthetic/recovered',()=>now,opener as unknown as typeof open)).toBe('connected');
  expect(opener).toHaveBeenCalledTimes(2);
 }finally{finish(handle());await vi.advanceTimersByTimeAsync(0);vi.useRealTimers();}
});

it('bounds timed-out underlying reads and releases capacity only on real completion',async()=>{
 vi.useFakeTimers();const releases:((value:ReturnType<typeof handle>)=>void)[]=[];
 const opener=vi.fn(()=>new Promise<ReturnType<typeof handle>>(resolve=>releases.push(resolve)));
 try{
  for(let i=0;i<16;i++){
   const read=readVpnState('/synthetic/capacity',()=>now,opener as unknown as typeof open);
   await vi.advanceTimersByTimeAsync(1001);expect(await read).toBe('unknown');
  }
  expect(await readVpnState('/synthetic/capacity',()=>now,opener as unknown as typeof open)).toBe('unknown');
  expect(opener).toHaveBeenCalledTimes(16);
  releases.shift()!(handle());await vi.advanceTimersByTimeAsync(0);
  expect(await readVpnState('/synthetic/capacity',()=>now,(async()=>handle()) as unknown as typeof open)).toBe('connected');
 }finally{for(const release of releases)release(handle());await vi.advanceTimersByTimeAsync(0);vi.useRealTimers();}
});
