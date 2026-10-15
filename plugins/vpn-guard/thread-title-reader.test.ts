import {expect,it} from 'vitest';
import {createThreadTitleReader} from './thread-title-reader.js';
it('retains four active slots across cancelled generations and removes queued reads',async()=>{
 let running=0;let peak=0;const calls:string[]=[];let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const reader=createThreadTitleReader(async id=>{calls.push(id);running++;peak=Math.max(peak,running);await gate;running--;return id;});
 const first=new AbortController();const pending=Promise.allSettled(Array.from({length:8},(_,i)=>reader.read(`old-${i}`,first.signal)));
 await Promise.resolve();expect(calls).toHaveLength(4);first.abort();await pending;
 const second=new AbortController();const latest=Promise.all(Array.from({length:6},(_,i)=>reader.read(`new-${i}`,second.signal)));
 await Promise.resolve();expect(calls).toHaveLength(4);release();await latest;
 expect(peak).toBe(4);expect(calls.filter(id=>id.startsWith('old-'))).toEqual(['old-0','old-1','old-2','old-3']);
});
