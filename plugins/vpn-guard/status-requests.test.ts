import {expect,it} from 'vitest';
import {createStatusRequests} from './status-requests.js';
import {readableError} from './copy.js';

it('rejects a delayed older read after the newest external block snapshot',()=>{
  const requests=createStatusRequests();
  const old=requests.start();const newest=requests.start();
  expect(requests.isCurrent(newest)).toBe(true);
  expect(requests.isCurrent(old)).toBe(false);
  requests.invalidate();expect(requests.isCurrent(newest)).toBe(false);
  expect(requests.isCurrent(requests.start())).toBe(true);
});
it('shows a Russian explanation for unknown technical errors',()=>{
  expect(readableError('Error: threads.listRunning: service unavailable','ru')).toBe('Не удалось выполнить действие. Проверьте подробности ошибки.');
  expect(readableError('Error: threads.listRunning: service unavailable','en')).toBe('Action failed. Check the error details.');
});

it('coalesces polling so a slower-than-cadence successful response is usable',async()=>{
 const {createStatusReads}=await import('./status-requests.js');
 let finish!:(value:string)=>void;let calls=0;
 const reads=createStatusReads();
 const pending=reads.read(()=>{calls++;return new Promise<string>(resolve=>{finish=resolve;});});
 expect(await reads.read(async()=>{calls++;return 'new';})).toBeNull();
 finish('healthy');expect(await pending).toBe('healthy');expect(calls).toBe(1);
});

it('manual refresh waits for a shared read then performs its own fresh read',async()=>{
 const {createStatusReads}=await import('./status-requests.js');
 const reads=createStatusReads();let finish!:(value:string)=>void;let freshCalls=0;
 const older=reads.read(()=>new Promise<string>(resolve=>{finish=resolve;}));
 const manual=reads.readFresh(async()=>{freshCalls++;return 'new snapshot';});
 expect(freshCalls).toBe(0);
 finish('old snapshot');expect(await older).toBe('old snapshot');
 expect(await manual).toBe('new snapshot');expect(freshCalls).toBe(1);
});

it('manual refresh can recover after the preceding shared request times out',async()=>{
 const {vi}=await import('vitest');const {createStatusReads}=await import('./status-requests.js');
 vi.useFakeTimers();const reads=createStatusReads();let finish!:(value:string)=>void;
 try{
  const older=reads.read(()=>new Promise<string>(resolve=>{finish=resolve;}),10).catch(error=>error);
  const manual=reads.readFresh(async()=> 'fresh',10);
  await vi.advanceTimersByTimeAsync(11);
  expect(await older).toBeInstanceOf(Error);expect(await manual).toBe('fresh');
  finish('late old data');await vi.advanceTimersByTimeAsync(0);
 }finally{vi.useRealTimers();}
});

it('disposes queued consumers without starting their reads or taking active slots',async()=>{
 const {createStatusReads}=await import('./status-requests.js');const reads=createStatusReads();
 let finish!:(value:string)=>void;let staleCalls=0;
 const active=reads.read(()=>new Promise<string>(resolve=>{finish=resolve;}));
 const cancelled=[];
 for(let i=0;i<3;i++){
  const controller=new AbortController();
  const pending=reads.readFresh(async()=>{staleCalls++;return 'stale';},10000,controller.signal).catch(error=>error);
  controller.abort();cancelled.push(pending);
 }
 const current=reads.readFresh(async()=> 'current');
 expect((await Promise.all(cancelled)).every(error=>error instanceof Error)).toBe(true);
 finish('old');expect(await active).toBe('old');expect(await current).toBe('current');expect(staleCalls).toBe(0);
});

it('retains the slot for an already started call even after its consumer aborts',async()=>{
 const {vi}=await import('vitest');const {createStatusReads}=await import('./status-requests.js');
 vi.useFakeTimers();const reads=createStatusReads();const finishes:((value:string)=>void)[]=[];
 try{
  for(let i=0;i<4;i++){
   const controller=new AbortController();
   const pending=reads.readFresh(()=>new Promise<string>(resolve=>finishes.push(resolve)),10,controller.signal).catch(error=>error);
   controller.abort();await vi.advanceTimersByTimeAsync(11);expect(await pending).toBeInstanceOf(Error);
  }
  await expect(reads.readFresh(async()=> 'extra',10)).rejects.toThrow('unavailable');
  finishes.shift()!('late');await vi.advanceTimersByTimeAsync(0);
  expect(await reads.readFresh(async()=> 'current',10)).toBe('current');
 }finally{for(const finish of finishes)finish('late');await vi.advanceTimersByTimeAsync(0);vi.useRealTimers();}
});

it('retries after a status timeout and bounds underlying stalled requests',async()=>{
 const {vi}=await import('vitest');const {createStatusReads}=await import('./status-requests.js');
 vi.useFakeTimers();const reads=createStatusReads();const finishes:((value:string)=>void)[]=[];
 try{
  for(let i=0;i<4;i++){
   const pending=reads.read(()=>new Promise<string>(resolve=>finishes.push(resolve)),10).catch(error=>error);
   await vi.advanceTimersByTimeAsync(11);expect(await pending).toBeInstanceOf(Error);
  }
  await expect(reads.read(async()=> 'healthy',10)).rejects.toThrow('unavailable');
  finishes.shift()!('late');await vi.advanceTimersByTimeAsync(0);
  expect(await reads.read(async()=> 'healthy',10)).toBe('healthy');
 }finally{for(const finish of finishes)finish('late');await vi.advanceTimersByTimeAsync(0);vi.useRealTimers();}
});
