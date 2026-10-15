import {expect,it} from 'vitest';
import {eventJournal} from './event-journal.js';
it('bounds persisted history, retains ordering and reloads it',async()=>{
 let saved:unknown=null;const j=eventJournal(null,async events=>{saved=events;},()=>{});
 await Promise.all(Array.from({length:105},(_,i)=>j.append({kind:'thread_stopped',threadId:`thread-${i}`})));
 expect(j.snapshot()).toHaveLength(100);expect(j.snapshot()[0]?.threadId).toBe('thread-5');
 expect(eventJournal(saved,async()=>{},()=>{}).snapshot()).toEqual(j.snapshot());
});
it('a failed event write cannot break protection and is retried on the next event',async()=>{
 let fail=true;let errors=0;let saved:unknown;
 const j=eventJournal(null,async events=>{if(fail){fail=false;throw Error('write failed');}saved=events;},()=>{errors++;});
 await j.append({kind:'manual_block_on'});await j.append({kind:'manual_block_off'});
 expect(errors).toBe(1);expect(saved).toEqual(j.snapshot());expect(j.snapshot()).toHaveLength(2);
});
it('uses only allowlisted event fields and JSON-safe optional values',async()=>{
 const j=eventJournal(null,async()=>{},()=>{});
 await j.append({kind:'vpn_connected',hostId:'host-a',reason:undefined});
 expect(j.snapshot()[0]).not.toHaveProperty('reason');
 expect(()=>j.append({kind:'automation_failed',payload:'not allowed'} as never)).toThrow();
 expect(eventJournal([{kind:'unknown'}],async()=>{},()=>{}).snapshot()).toEqual([]);
});

it('discards persisted dates outside the supported Date range',()=>{
 expect(eventJournal([{kind:'manual_block_on',at:Number.MAX_SAFE_INTEGER}],async()=>{},()=>{}).snapshot()).toEqual([]);
});
it('updates bounded memory immediately while coalescing a delayed writer',async()=>{
 let release!:()=>void;const pending=new Promise<void>(r=>{release=r;});const saves:unknown[]=[];
 const j=eventJournal(null,async events=>{saves.push(events);if(saves.length===1)await pending;},()=>{});
 const first=j.append({kind:'manual_block_on'});
 for(let i=0;i<105;i++)void j.append({kind:'thread_stopped',threadId:`thread-${i}`});
 expect(j.snapshot()).toHaveLength(100);expect(saves).toHaveLength(1);
 release();await first;expect(saves).toHaveLength(2);expect(saves[1]).toEqual(j.snapshot());
});
it('does not start queued writes after disposal',async()=>{
 let release!:()=>void;const pending=new Promise<void>(r=>{release=r;});let writes=0;
 const j=eventJournal(null,async()=>{writes++;await pending;},()=>{});
 const first=j.append({kind:'manual_block_on'});void j.append({kind:'manual_block_off'});j.close();release();await first;
 expect(writes).toBe(1);await j.append({kind:'manual_block_on'});expect(writes).toBe(1);
});
