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
it('lets a burst no larger than the configured size start together, then keeps the sustained rate',()=>{
 let now=10_000;const pacing=new AccountStartPacing(()=>250,()=>now,()=>4);
 for(let i=0;i<4;i++){expect(pacing.readyAt('a')??0).toBeLessThanOrEqual(now);pacing.dispatched('a');}
 expect(pacing.readyAt('a')).toBe(10_250);
 now=10_250;pacing.dispatched('a');expect(pacing.readyAt('a')).toBe(10_500);
 // Half a second of idle time earns two starts, not a full burst.
 now=10_750;pacing.dispatched('a');pacing.dispatched('a');expect(pacing.readyAt('a')).toBe(11_000);
 // A long idle period restores the whole burst, never more.
 now=60_000;for(let i=0;i<4;i++){expect(pacing.readyAt('a')??0).toBeLessThanOrEqual(now);pacing.dispatched('a');}
 expect(pacing.readyAt('a')).toBe(60_250);
 // Other accounts keep their own credit.
 expect(pacing.readyAt('b')).toBeNull();
});
it('releases requests one by one, at least a second apart, during and for a minute after a provider hold',()=>{
 let now=10_000;const pacing=new AccountStartPacing(()=>250,()=>now,()=>4);
 pacing.dispatched('a');expect(pacing.readyAt('a')??0).toBeLessThanOrEqual(now);
 // Saved burst credit is forfeited as soon as the provider holds the account.
 const heldUntil=12_000;expect(pacing.readyAt('a',heldUntil)).toBe(11_000);
 now=12_000;pacing.dispatched('a',heldUntil);expect(pacing.readyAt('a',heldUntil)).toBe(13_000);
 now=13_000;pacing.dispatched('a',heldUntil);expect(pacing.readyAt('a',heldUntil)).toBe(14_000);
 // Still recovering 59 seconds after the hold: idle time does not rebuild a burst.
 now=71_000;pacing.dispatched('a',heldUntil);expect(pacing.readyAt('a',heldUntil)).toBe(72_000);
 // After the recovery minute normal pacing and its burst return.
 now=72_000;pacing.dispatched('a',heldUntil);
 now=80_000;for(let i=0;i<4;i++){expect(pacing.readyAt('a',heldUntil)??0).toBeLessThanOrEqual(now);pacing.dispatched('a',heldUntil);}
 expect(pacing.readyAt('a',heldUntil)).toBe(80_250);
});
it('spaces the very first start seen during a hold and keeps a disabled interval disabled',()=>{
 let now=5_000;const paced=new AccountStartPacing(()=>250,()=>now,()=>4);
 paced.dispatched('a',5_000);expect(paced.readyAt('a',5_000)).toBe(6_000);
 const disabled=new AccountStartPacing(()=>0,()=>now,()=>4);
 disabled.dispatched('a',5_000);expect(disabled.readyAt('a',5_000)??0).toBeLessThanOrEqual(now);
});
