import {describe,it,expect,vi} from 'vitest';
import {startLoopDelay,type LoopDelaySources} from './loop-delay.js';

function fixture() {
  let tick = () => {};
  let gc = (_duration: number) => {};
  let time = 0;
  const histogram = {max: 0, percentile: vi.fn(()=>200e6), reset: vi.fn(), enable: vi.fn(), disable: vi.fn()};
  const disconnect = vi.fn(), cancel = vi.fn(), warn = vi.fn();
  const s: LoopDelaySources = {
    now: ()=>time, histogram, utilization: ()=>({active:time/2,idle:time/2}),
    memory: ()=>({heapUsed:1024**2,rss:2*1024**2}),
    observeGc: cb=>{gc=cb;return disconnect;}, schedule: cb=>{tick=cb;return cancel;},
  };
  const stop = startLoopDelay(warn,()=>3,s);
  return {s,histogram,warn,stop,disconnect,cancel,gc:(n:number)=>gc(n),tick:()=>{time+=10000;tick();}};
}
describe('loop delay diagnostics',()=>{
  it('is silent below threshold and emits one numeric warning at threshold',()=>{
    const f=fixture();f.histogram.max=999e6;f.tick();expect(f.warn).not.toHaveBeenCalled();
    f.histogram.max=1000e6;f.gc(12);f.tick();
    expect(f.warn).toHaveBeenCalledTimes(1);
    const fields=JSON.parse(f.warn.mock.calls[0]![0].split('delay ')[1]);
    expect(fields).toEqual({maxDelayMs:1000,p99DelayMs:200,windowMs:10000,utilization:0.5,maxGcPauseMs:12,heapUsedMb:1,rssMb:2,inFlight:3});
    expect(Object.values(fields).every(x=>typeof x==='number')).toBe(true);
    f.tick();expect(JSON.parse(f.warn.mock.calls[1]![0].split('delay ')[1]).maxGcPauseMs).toBe(0);
    expect(f.histogram.reset).toHaveBeenCalledTimes(3);
    f.stop();
  });
  it('stops timer histogram and observer on dispose, idempotently',()=>{
    const f=fixture();f.stop();f.stop();f.histogram.max=2000e6;f.tick();
    expect(f.warn).not.toHaveBeenCalled();expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.disconnect).toHaveBeenCalledTimes(1);expect(f.histogram.disable).toHaveBeenCalledTimes(1);
  });
  it('contains source failures and releases diagnostics',()=>{
    const f=fixture();f.s.now=()=>{throw Error('synthetic');};
    expect(f.tick).not.toThrow();expect(f.cancel).toHaveBeenCalledOnce();expect(f.warn).not.toHaveBeenCalled();
  });
});
