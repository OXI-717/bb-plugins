import { describe, expect, it, vi } from 'vitest';
import { abortableDelay } from './delay.js';

class CountingSignal extends EventTarget {
  readonly controller = new AbortController();
  active = 0;
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    this.active += 1;
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    this.active -= 1;
    super.removeEventListener(...args);
  }
  get aborted() { return this.controller.signal.aborted; }
  abort() { this.controller.abort();this.dispatchEvent(new Event('abort')); }
}

describe('abortableDelay',()=>{
  it('removes every abort listener after repeated timer expiry',async()=>{
    vi.useFakeTimers();
    const signal=new CountingSignal();
    for(let i=0;i<20;i++) {
      const waiting=abortableDelay(signal as unknown as AbortSignal,5000);
      expect(signal.active).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      await waiting;
      expect(signal.active).toBe(0);
    }
    vi.useRealTimers();
  });
  it('clears timer and listener on abort',async()=>{
    vi.useFakeTimers();
    const signal=new CountingSignal();
    const waiting=abortableDelay(signal as unknown as AbortSignal,5000);
    signal.abort();
    await waiting;
    expect(signal.active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
