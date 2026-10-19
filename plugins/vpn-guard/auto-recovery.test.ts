import {expect,it,vi} from 'vitest';
import {automaticStopRecovery} from './auto-recovery.js';

async function setup(){
 let saved:unknown=[];let now=1000;let allowed=false;
 const resume=vi.fn(async(_threadId:string,_at:number)=>{}),claimed=vi.fn(()=>false);
 const recovery=await automaticStopRecovery({load:async()=>saved,save:async value=>{saved=structuredClone(value);},allowed:async()=>allowed,resume,claimed,now:()=>now,warn:vi.fn()});
 return {recovery,resume,claimed,setAllowed:(value:boolean)=>{allowed=value;},setNow:(value:number)=>{now=value;},getSaved:()=>saved,options:()=>({load:async()=>saved,save:async(value:unknown)=>{saved=structuredClone(value);},allowed:async()=>allowed,resume,claimed,now:()=>now,warn:vi.fn()})};
}
it('does not import historical stop IDs, and waits for verified recovery',async()=>{
 const t=await setup();await t.recovery.run();expect(t.resume).not.toHaveBeenCalled();await t.recovery.remember('thread-one',1000,'host-one');await t.recovery.run();expect(t.resume).not.toHaveBeenCalled();t.setAllowed(true);await t.recovery.run();await t.recovery.run();expect(t.resume).toHaveBeenCalledExactlyOnceWith('thread-one',1000);
});
it('recovers a new owned stop after plugin restart',async()=>{
 const t=await setup();await t.recovery.remember('thread-one',1000,'host-one');t.setAllowed(true);const reloaded=await automaticStopRecovery(t.options());await reloaded.run();expect(t.resume).toHaveBeenCalledTimes(1);
});
it('never repeats an uncertain or manual continuation claim',async()=>{
 const t=await setup();await t.recovery.remember('thread-one',1000,'host-one');t.setAllowed(true);t.claimed.mockReturnValue(true);await t.recovery.run();expect(t.resume).not.toHaveBeenCalled();
});
it('caps recoverable local scheduling failures at three attempts',async()=>{
 const t=await setup();t.setAllowed(true);t.resume.mockRejectedValue(Error('private'));await t.recovery.remember('thread-one',1000,'host-one');for(const n of [1000,32_000,153_000,454_000]){t.setNow(n);await t.recovery.run();}expect(t.resume).toHaveBeenCalledTimes(3);
});
it('keeps a later stop distinct and ignores duplicate observations',async()=>{
 const t=await setup();t.setAllowed(true);await t.recovery.remember('thread-one',1000,'host-one');await t.recovery.remember('thread-one',1000,'host-one');await t.recovery.run();await t.recovery.remember('thread-one',2000,'host-one');await t.recovery.run();expect(t.resume).toHaveBeenCalledTimes(2);
});
it('does not run duplicate continuations during a slow request',async()=>{
 const t=await setup();t.setAllowed(true);await t.recovery.remember('thread-one',1000,'host-one');let release!:()=>void;t.resume.mockImplementation(()=>new Promise<void>(r=>{release=r;}));const running=t.recovery.run();while(!release)await new Promise(r=>setTimeout(r,0));await t.recovery.run();expect(t.resume).toHaveBeenCalledTimes(1);release();await running;
});
it('one stalled continuation does not block recovery of other threads',async()=>{
 const t=await setup();t.setAllowed(true);let release!:()=>void;
 t.resume.mockImplementation(async(threadId:string)=>{if(threadId==='thread-one')await new Promise<void>(r=>{release=r;});});
 await t.recovery.remember('thread-one',1000,'host-one');await t.recovery.remember('thread-two',1000,'host-one');
 const running=t.recovery.run();await vi.waitFor(()=>expect(t.resume).toHaveBeenCalledTimes(2));
 await t.recovery.run();expect(t.resume).toHaveBeenCalledTimes(2);release();await running;
});
