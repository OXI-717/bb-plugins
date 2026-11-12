import {afterEach,expect,it,vi} from 'vitest';
import {createThreadStopMarks,isStoppedBoundary,type StopBoundary} from './thread-stop-marks';
const stopped=[{type:'system/thread/interrupted',data:{reason:'manual-stop'}}];
const started=[{type:'turn/started',data:{}}];
const thread=(id='thr_example',updatedAt=1,status='idle')=>({id,updatedAt,status,runtimeStatus:status});
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
afterEach(()=>vi.useRealTimers());
it('marks only an explicit stop boundary, including Guard stops represented by manual-stop',()=>{
 expect(isStoppedBoundary(stopped)).toBe(true);
 for(const events of [[],started,[{type:'system/thread/interrupted',data:{reason:'host-daemon-restarted'}}],[{type:'system/thread/interrupted',data:null}]])expect(isStoppedBoundary(events)).toBe(false);
});
it('restores a stop on first load, caches unchanged rows and clears immediately on restart',async()=>{
 const read=vi.fn(async()=>stopped);const changed=vi.fn();const tracker=createThreadStopMarks(read,changed);
 tracker.sync([thread()]);await tick();expect(changed.mock.lastCall?.[0]).toEqual(new Set(['thr_example']));
 tracker.sync([thread()]);await tick();expect(read).toHaveBeenCalledTimes(1);
 tracker.sync([thread('thr_example',2,'active')]);expect(changed.mock.lastCall?.[0]).toEqual(new Set());
 read.mockResolvedValue(started);tracker.sync([thread('thr_example',3)]);await tick();expect(changed.mock.lastCall?.[0]).toEqual(new Set());tracker.dispose();
});
it('ignores an old read after a restart, removal or disposal',async()=>{
 let finish!:(events:StopBoundary[])=>void;
 const changed=vi.fn();const tracker=createThreadStopMarks(()=>new Promise(resolve=>{finish=resolve;}),changed);
 tracker.sync([thread()]);await tick();tracker.sync([thread('thr_example',2,'active')]);finish(stopped);await tick();expect(changed.mock.lastCall?.[0]).toEqual(new Set());
 tracker.sync([thread('thr_example',3)]);await tick();tracker.sync([]);finish(stopped);await tick();expect(changed.mock.lastCall?.[0]).toEqual(new Set());
 tracker.sync([thread('thr_example',4)]);await tick();tracker.dispose();finish(stopped);await tick();expect(changed.mock.lastCall?.[0]).toEqual(new Set());
});
it('limits reads to four and retries failed metadata without inventing a stop',async()=>{
 const pending:(()=>void)[]=[];let running=0,max=0;
 const read=vi.fn(async()=>{running++;max=Math.max(max,running);await new Promise<void>(resolve=>pending.push(resolve));running--;return stopped;});
 const tracker=createThreadStopMarks(read,()=>{});tracker.sync(Array.from({length:9},(_,i)=>thread(`thr_${i}`)));await tick();expect(read).toHaveBeenCalledTimes(4);
 while(pending.length){pending.splice(0).forEach(resolve=>resolve());await tick();}
 expect(max).toBe(4);expect(read).toHaveBeenCalledTimes(9);tracker.dispose();
 const changed=vi.fn();const flaky=vi.fn().mockRejectedValueOnce(Error('unavailable')).mockResolvedValue(stopped);
 const retry=createThreadStopMarks(flaky,changed);retry.sync([thread()]);await tick();expect(changed.mock.lastCall?.[0]).toEqual(new Set());retry.retryUnknown();await tick();expect(changed.mock.lastCall?.[0]).toEqual(new Set(['thr_example']));retry.dispose();
});
it('does not read active, unavailable or hidden threads',async()=>{
 const read=vi.fn(async()=>stopped);const tracker=createThreadStopMarks(read,()=>{});
 tracker.sync([thread('thr_active',1,'active'),{...thread('thr_hidden'),isHidden:true},{...thread('thr_offline'),runtimeStatus:'waiting-for-host'}]);await tick();expect(read).not.toHaveBeenCalled();tracker.retryUnknown();await tick();expect(read).not.toHaveBeenCalled();tracker.dispose();
});
it('aborts timed out reads and retries without publishing their late result',async()=>{
 vi.useFakeTimers();let signal!:AbortSignal;let finish!:(events:StopBoundary[])=>void;
 const changed=vi.fn();const read=vi.fn((_id:string,s:AbortSignal)=>{signal=s;return new Promise<StopBoundary[]>(resolve=>{finish=resolve;});});
 const tracker=createThreadStopMarks(read,changed);tracker.sync([thread()]);await vi.advanceTimersByTimeAsync(8000);expect(signal.aborted).toBe(true);
 finish(stopped);await vi.advanceTimersByTimeAsync(0);expect(changed.mock.lastCall?.[0]).toEqual(new Set());
 tracker.retryUnknown();await vi.advanceTimersByTimeAsync(0);expect(read).toHaveBeenCalledTimes(2);tracker.dispose();finish(stopped);await vi.advanceTimersByTimeAsync(0);
});
