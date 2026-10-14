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
    const opener=vi.fn(()=>new Promise<ReturnType<typeof handle>>(()=>{}));
    const first=readVpnState('/synthetic/stalled',()=>now,opener as unknown as typeof open);
    const second=readVpnState('/synthetic/stalled',()=>now,opener as unknown as typeof open);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await Promise.all([first,second])).toEqual(['unknown','unknown']);
    expect(opener).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
