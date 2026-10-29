import {afterEach,it,expect,vi} from 'vitest';
import {AccountStartPacing} from './account-start-pacing.js';
import {AccountAdmission,AdmissionUnavailable} from './account-admission.js';
import {accountPoolConfigSchema,accountPoolConfigSetInputSchema} from './contracts.js';
afterEach(()=>vi.useRealTimers());
it('paces starts per account, preserves distinct accounts and supports explicit zero',()=>{
 let now=1000,interval=1000;const pacing=new AccountStartPacing(()=>interval,()=>now);
 expect(pacing.readyAt('a')).toBeNull();pacing.dispatched('a');
 expect(pacing.readyAt('a')).toBe(2000);expect(pacing.readyAt('b')).toBeNull();
 now=1500;interval=2000;expect(pacing.readyAt('a')).toBe(3000);
 interval=0;expect(pacing.readyAt('a')).toBeLessThanOrEqual(now);
 pacing.clear();expect(pacing.readyAt('a')).toBeNull();
});
it('spaces two concurrent starts after one shared cooldown instead of releasing a burst',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);const p=new AccountStartPacing(()=>1000,Date.now),a=new AccountAdmission(()=>2,Date.now);
 const signal=new AbortController().signal;const starts:number[]=[];
 const run=async()=>{const release=await a.acquire('same',signal,()=>Math.max(3000,p.readyAt('same')??0));
  while(true){await a.waitCooldown(signal,()=>Math.max(3000,p.readyAt('same')??0));
   if((p.readyAt('same')??0)>Date.now())continue;
   p.dispatched('same');starts.push(Date.now());break;
  }release();};
 const both=Promise.all([run(),run()]);await vi.advanceTimersByTimeAsync(1999);expect(starts).toEqual([]);
 await vi.advanceTimersByTimeAsync(1);expect(starts).toEqual([3000]);
 await vi.advanceTimersByTimeAsync(1000);await both;expect(starts).toEqual([3000,4000]);
});
it('wakes a lowered live interval but cannot bypass an unchanged provider hold',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);let interval=60000,hold=0;const p=new AccountStartPacing(()=>interval,Date.now),a=new AccountAdmission(()=>2,Date.now);
 p.dispatched('a');let done=false;const signal=new AbortController().signal;
 const pending=a.waitCooldown(signal,()=>Math.max(hold,p.readyAt('a')??0)).then(()=>{done=true;});
 interval=0;hold=5000;a.limitsChanged();await vi.advanceTimersByTimeAsync(0);expect(done).toBe(false);
 await vi.advanceTimersByTimeAsync(4000);await pending;expect(done).toBe(true);
});
it('retains queue deadline and cancellation while waiting for spacing',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);const a=new AccountAdmission(()=>2,Date.now),c=new AbortController();
 const pending=a.waitCooldown(c.signal,()=>60000,1100).catch(e=>e);
 await vi.advanceTimersByTimeAsync(100);expect(await pending).toBeInstanceOf(AdmissionUnavailable);
 const c2=new AbortController();const cancel=a.waitCooldown(c2.signal,()=>60000).catch(e=>e);c2.abort(new Error('synthetic cancellation'));expect((await cancel).message).toBe('synthetic cancellation');
 a.limitsChanged();
});
it('migrates legacy config with pacing disabled and rejects malformed interval values',()=>{
 expect(accountPoolConfigSchema.parse({}).claudeRequestStartIntervalMs).toBe(0);
 for(const value of [-1,60001,1.5,true,'1000',null,NaN,Infinity])expect(accountPoolConfigSetInputSchema.safeParse({claudeRequestStartIntervalMs:value}).success).toBe(false);
 expect(accountPoolConfigSetInputSchema.parse({claudeRequestStartIntervalMs:1000}).claudeRequestStartIntervalMs).toBe(1000);
});
