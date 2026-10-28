import {afterEach, expect, it, vi} from 'vitest';
import {AccountAdmission} from './account-admission.js';
afterEach(()=>vi.useRealTimers());
const signal=()=>new AbortController().signal;
it('bounds shared slots, FIFO, independent accounts, and idempotent release',async()=>{
 const gate=new AccountAdmission(()=>2);
 const first=await gate.acquire('a',signal(),()=>null),second=await gate.acquire('a',signal(),()=>null);
 const order:number[]=[];
 const third=gate.acquire('a',signal(),()=>null).then(r=>{order.push(3);return r;});
 const fourth=gate.acquire('a',signal(),()=>null).then(r=>{order.push(4);return r;});
 const other=await gate.acquire('b',signal(),()=>null);
 expect(gate.waiting('a')).toBe(2);expect(order).toEqual([]);
 first();first();const releaseThird=await third;expect(order).toEqual([3]);
 second();const releaseFourth=await fourth;expect(order).toEqual([3,4]);
 releaseThird();releaseFourth();other();expect(gate.reserved('a')).toBe(0);
});
it('abort removes a waiter without consuming a later slot; queue is bounded',async()=>{
 const gate=new AccountAdmission(()=>1,Date.now,1000,1,1);
 const release=await gate.acquire('a',signal(),()=>null),cancel=new AbortController();
 const queued=gate.acquire('a',cancel.signal,()=>null);const rejected=expect(queued).rejects.toThrow('cancel');
 await expect(gate.acquire('a',signal(),()=>null)).rejects.toMatchObject({code:'POOL_QUEUE_FULL'});
 cancel.abort(new Error('cancel'));await rejected;expect(gate.waiting('a')).toBe(0);
 release();(await gate.acquire('a',signal(),()=>null))();
});
it('waits for extended cooldown and never sends early after a concurrent response',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);
 const gate=new AccountAdmission(()=>1),abort=new AbortController();let held=6000,admitted=false;
 const result=gate.acquire('a',abort.signal,()=>held).then(r=>{admitted=true;return r;});
 await vi.advanceTimersByTimeAsync(4000);expect(admitted).toBe(false);
 held=9000;await vi.advanceTimersByTimeAsync(1000);expect(admitted).toBe(false);
 await vi.advanceTimersByTimeAsync(3000);expect(admitted).toBe(true);(await result)();
 expect(gate.reserved('a')).toBe(0);
});
it('deadline and stop cancel both capacity and cooldown waits without leaks',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);
 const gate=new AccountAdmission(()=>1,Date.now,500);
 const a=gate.acquire('a',signal(),()=>5000);const error=expect(a).rejects.toMatchObject({code:'POOL_QUEUE_TIMEOUT'});
 await vi.advanceTimersByTimeAsync(500);await error;expect(gate.reserved('a')).toBe(0);
 const release=await gate.acquire('a',signal(),()=>null),stop=new AbortController();
 const b=gate.acquire('a',stop.signal,()=>null);const aborted=expect(b).rejects.toThrow('stop');
 stop.abort(new Error('stop'));await aborted;release();expect(gate.waiting('a')).toBe(0);
 const cooling=new AbortController(),c=gate.acquire('a',cooling.signal,()=>5000);
 const canceled=expect(c).rejects.toThrow('stop');await Promise.resolve();cooling.abort(new Error('stop'));await canceled;
 expect(gate.reserved('a')).toBe(0);expect(vi.getTimerCount()).toBe(0);
});
it('rechecks cooldown after asynchronous guards and respects live limit reductions',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);let limit=2;
 const gate=new AccountAdmission(()=>limit),r1=await gate.acquire('a',signal(),()=>null),r2=await gate.acquire('a',signal(),()=>null);
 let sent=false;limit=1;const pending=gate.acquire('a',signal(),()=>null).then(r=>{sent=true;return r;});
 r1();await Promise.resolve();expect(sent).toBe(false);r2();const r3=await pending;
 let ready=false;const check=gate.waitCooldown(signal(),()=>5000).then(()=>{ready=true;});
 await vi.advanceTimersByTimeAsync(3999);expect(ready).toBe(false);await vi.advanceTimersByTimeAsync(1);await check;r3();
});

it('preserves a future hold through the exact ordinary Codex quota-header path',async()=>{
 const {createCodexAdapter}=await import('./codex-adapter.js');
 const {quotaSchema,EMPTY_FAMILY_WEEKLY}=await import('./contracts.js');
 const previous=quotaSchema.parse({fiveHourUtilization:null,fiveHourResetAt:null,fiveHourStatus:null,sevenDayUtilization:null,sevenDayResetAt:null,sevenDayStatus:null,representativeClaim:null,familyWeekly:EMPTY_FAMILY_WEEKLY,limitWindows:[],observedAt:null,error:null,accountId:'11111111-1111-4111-8111-111111111111',heldUntil:9000});
 const adapter=createCodexAdapter({refreshUrl:'https://auth.example/token',usageUrl:'https://usage.example/usage'});
 const headers=new Headers({'x-codex-primary-used-percent':'15','x-codex-primary-window-minutes':'10080'});
 expect(adapter.quotaFromHeaders(previous.accountId,headers,previous,'other',1000).heldUntil).toBe(9000);
});
