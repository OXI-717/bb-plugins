import {expect,it,vi} from 'vitest';
import {NetworkFlights} from './network-flights.js';

it('does not invoke upstream when policy denies and permits Chinese requests',async()=>{
  const fetcher=vi.fn(async()=>new Response('OK'));
  const stop=new AbortController();
  const flights=new NetworkFlights(fetcher,()=>stop.signal,async p=>{if(p==='codex')throw Error('blocked');});
  await expect(flights.fetch('codex','https://example.test')).rejects.toThrow('blocked');
  expect(fetcher).not.toHaveBeenCalled();
  expect(await(await flights.fetch('zai','https://example.test')).text()).toBe('OK');
  expect(flights.size).toBe(0);
});
it('aborts open protected streams after block without cancelling Chinese streams',async()=>{
  let blocked=false;
  const stop=new AbortController();
  const flights=new NetworkFlights(async()=>new Response(new ReadableStream()),()=>stop.signal,async p=>{if(blocked&&p==='cursor')throw Error('blocked');});
  const protectedResponse=await flights.fetch('cursor','https://example.test');
  const chinese=await flights.fetch('kimi','https://example.test');
  const pending=protectedResponse.text();const error=expect(pending).rejects.toThrow('blocked');
  blocked=true;await flights.enforce();await error;
  expect(flights.size).toBe(1);await chinese.body!.cancel();expect(flights.size).toBe(0);
});
it('rechecks permission after response headers and cancels denied bodies',async()=>{
  let allowed=true;const cancelled=vi.fn();const stop=new AbortController();
  const flights=new NetworkFlights(async()=>{allowed=false;return new Response(new ReadableStream({cancel:cancelled}));},()=>stop.signal,async()=>{if(!allowed)throw Error('blocked');});
  await expect(flights.fetch('devin','https://example.test')).rejects.toThrow('blocked');
  expect(cancelled).toHaveBeenCalled();expect(flights.size).toBe(0);
});
it('cancels all retained responses on shutdown and releases exhausted bodies',async()=>{
  const stop=new AbortController();const flights=new NetworkFlights(async()=>new Response(new ReadableStream()),()=>stop.signal,async()=>{});
  const response=await flights.fetch('codex','https://example.test');const reading=response.text();const error=expect(reading).rejects.toThrow('shutdown');
  stop.abort(Error('shutdown'));await error;expect(flights.size).toBe(0);
});

it('preserves drainable model streams during shutdown grace until their caller aborts',async()=>{
 const stop=new AbortController(),caller=new AbortController();
 const flights=new NetworkFlights(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('first'));}})),()=>stop.signal,async()=>{});
 const response=await flights.fetch('claude','https://example.test',{signal:caller.signal},true);
 const reader=response.body!.getReader();await reader.read();stop.abort(Error('shutdown'));
 expect(flights.size).toBe(1);
 const pending=reader.read();const error=expect(pending).rejects.toThrow('drain timeout');caller.abort(Error('drain timeout'));await error;expect(flights.size).toBe(0);
});
it('uses the request-bound check before dispatch and after headers without replay',async()=>{
 const stop=new AbortController();const checks:string[]=[];let sent=0;
 const flights=new NetworkFlights(async()=>{sent++;return new Response('ok');},()=>stop.signal,async()=>{throw Error('unbound check');});
 const response=await flights.fetch('cursor','https://synthetic.example',undefined,false,undefined,async()=>{checks.push(sent===0?'before':'after');});
 expect(await response.text()).toBe('ok');expect(checks).toEqual(['before','after']);expect(sent).toBe(1);
});


it('identifies a policy abort mid-frame once with byte count, leaving other providers open',async()=>{
 const error=Error('synthetic guard timeout');let blocked=false;
 const report=vi.fn();const stop=new AbortController();
 const flights=new NetworkFlights(async()=>new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([0,0,0]));}})),()=>stop.signal,async p=>{if(blocked&&p==='cursor')throw error;});
 const response=await flights.fetch('cursor','https://synthetic.example',undefined,false,undefined,undefined,undefined,report);
 const other=await flights.fetch('kimi','https://synthetic.example');
 const reader=response.body!.getReader();await reader.read();
 const pending=expect(reader.read()).rejects.toBe(error);blocked=true;await flights.enforce();await pending;
 expect(report).toHaveBeenCalledExactlyOnceWith(error,3);expect(flights.size).toBe(1);
 await other.body!.cancel();await flights.enforce();expect(report).toHaveBeenCalledTimes(1);
});

it('reports body read errors while a throwing diagnostic cannot replace them',async()=>{
 const failure=Error('upstream body failed');let source!:ReadableStreamDefaultController<Uint8Array>;
 const report=vi.fn(()=>{throw Error('logger failed');});const stop=new AbortController();
 const flights=new NetworkFlights(async()=>new Response(new ReadableStream<Uint8Array>({start(c){source=c;}})),()=>stop.signal,async()=>{});
 const response=await flights.fetch('cursor','https://synthetic.example',undefined,false,undefined,undefined,undefined,report);
 const reading=expect(response.text()).rejects.toBe(failure);source.error(failure);await reading;
 expect(report).toHaveBeenCalledExactlyOnceWith(failure,0);expect(flights.size).toBe(0);
});

it('does not report success, caller cancellation or a downstream cancel as body errors',async()=>{
 const report=vi.fn();const stop=new AbortController();let open=false;
 const flights=new NetworkFlights(async()=>new Response(open?new ReadableStream():new Uint8Array([1,2,3])),()=>stop.signal,async()=>{});
 const response=await flights.fetch('cursor','https://synthetic.example',undefined,false,undefined,undefined,undefined,report);await response.arrayBuffer();
 open=true;const caller=new AbortController();
 const canceled=await flights.fetch('cursor','https://synthetic.example',{signal:caller.signal},false,undefined,undefined,undefined,report);
 const rejection=expect(canceled.text()).rejects.toThrow('caller');caller.abort(Error('caller'));await rejection;
 const downstream=await flights.fetch('cursor','https://synthetic.example',undefined,false,undefined,undefined,undefined,report);await downstream.body!.cancel();
 expect(report).not.toHaveBeenCalled();expect(flights.size).toBe(0);
});

it('interrupts only the exact observed Cursor body once, without affecting its neighbour',async()=>{
 const stop=new AbortController(),report=vi.fn();
 const upstream=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([0,0,0]));}})));
 const flights=new NetworkFlights(upstream,()=>stop.signal,async()=>{});
 const open=(provider:'cursor'|'kimi',requestId:string,threadId:string)=>flights.fetch(provider,'https://synthetic.example',undefined,true,undefined,undefined,undefined,report,{requestId,threadId});
 const a=await open('cursor','request-a','thr_one'),b=await open('cursor','request-b','thr_two'),c=await open('kimi','request-c','thr_one');
 const reader=a.body!.getReader();await reader.read();
 expect(flights.cursorStreams('thr_one')).toEqual([{requestId:'request-a',threadId:'thr_one',bytesRead:3,contentType:'other'}]);
 expect(flights.interruptCursorStream('request-a','thr_two')).toBe(false);
 expect(flights.interruptCursorStream('request-c','thr_one')).toBe(false);
 const rejected=expect(reader.read()).rejects.toThrow('Controlled Cursor stream interruption');
 expect(flights.interruptCursorStream('request-a','thr_one')).toBe(true);await rejected;
 expect(flights.interruptCursorStream('request-a','thr_one')).toBe(false);
 expect(flights.cursorStreams('thr_one')).toEqual([]);expect(flights.size).toBe(2);
 expect(upstream).toHaveBeenCalledTimes(3);expect(report).toHaveBeenCalledTimes(1);
 expect((await b.body!.getReader().read()).value).toEqual(new Uint8Array([0,0,0]));await c.body!.cancel();
});

it('does not expose or interrupt unknown, header-pending, completed or cancelled streams',async()=>{
 const stop=new AbortController();let respond!:(r:Response)=>void;
 const flights=new NetworkFlights(()=>new Promise<Response>(r=>{respond=r;}),()=>stop.signal,async()=>{});
 const pending=flights.fetch('cursor','https://synthetic.example',undefined,true,undefined,undefined,undefined,undefined,{requestId:'pending',threadId:'thr_one'});
 await vi.waitFor(()=>expect(respond).toBeTypeOf('function'));
 expect(flights.cursorStreams('thr_one')).toEqual([]);expect(flights.interruptCursorStream('pending','thr_one')).toBe(false);
 respond(new Response('ok'));const response=await pending;expect(await response.text()).toBe('ok');
 expect(flights.interruptCursorStream('pending','thr_one')).toBe(false);expect(flights.cursorStreams('thr_one')).toEqual([]);
});

it('keeps running responses for a bounded time while the Guard gives no answer, and stops them on refusal',async()=>{
 const {GuardRequiredError}=await import('./network-errors.js');const {GUARD_UNREADABLE_GRACE_MS}=await import('./network-flights.js');
 let failure:Error|null=null,now=1_000_000;const stop=new AbortController();
 const flights=new NetworkFlights(async()=>new Response(new ReadableStream()),()=>stop.signal,async()=>{if(failure)throw failure;},undefined,undefined,()=>now);
 const open=async()=>{const response=await flights.fetch('codex','https://example.test');let outcome='open';
  void response.text().catch(error=>{outcome=String((error as Error).message);});return ()=>outcome;};
 // No answer (timeout, then failed call): the admitted response continues inside the grace.
 failure=null;const first=await open();
 failure=new GuardRequiredError('codex',true,'timeout');await flights.enforce();
 now+=GUARD_UNREADABLE_GRACE_MS-1;failure=new GuardRequiredError('codex',true,'rpc_failed');await flights.enforce();
 await Promise.resolve();expect(first()).toBe('open');expect(flights.size).toBe(1);
 // A successful read restarts the grace.
 failure=null;await flights.enforce();
 now+=GUARD_UNREADABLE_GRACE_MS-1;failure=new GuardRequiredError('codex',true,'timeout');await flights.enforce();
 await Promise.resolve();expect(first()).toBe('open');
 // Still unanswered when the grace ends: fail closed.
 now+=GUARD_UNREADABLE_GRACE_MS;await flights.enforce();
 await vi.waitFor(()=>expect(first()).toContain('VPN_GUARD_UNAVAILABLE'));expect(flights.size).toBe(0);
 // An explicit refusal and an invalid decision are never tolerated.
 for(const refusal of [new GuardRequiredError('codex'),new GuardRequiredError('codex',true,'invalid_decision')]){
  failure=null;const next=await open();failure=refusal;await flights.enforce();
  await vi.waitFor(()=>expect(next()).toContain(refusal.code));expect(flights.size).toBe(0);
 }
});
it('refuses a new request on an unanswered Guard read but lets an admitted one receive its response',async()=>{
 const {GuardRequiredError}=await import('./network-errors.js');
 let checks=0,failOn=0;const stop=new AbortController();const fetcher=vi.fn(async()=>new Response('OK'));
 const flights=new NetworkFlights(fetcher,()=>stop.signal,async()=>{if(++checks===failOn)throw new GuardRequiredError('claude',true,'timeout');});
 // First read (before dispatch) unanswered: nothing is sent.
 failOn=1;await expect(flights.fetch('claude','https://example.test')).rejects.toThrow('VPN_GUARD_UNAVAILABLE');
 expect(fetcher).not.toHaveBeenCalled();
 // Admitted by the first read; the repeat read after headers gets no answer: the response is delivered.
 checks=0;failOn=2;expect(await(await flights.fetch('claude','https://example.test')).text()).toBe('OK');
 // A refusal on the repeat read still cancels the response.
 checks=0;const refusing=new NetworkFlights(async()=>new Response(new ReadableStream()),()=>stop.signal,async()=>{if(++checks===2)throw new GuardRequiredError('claude');});
 await expect(refusing.fetch('claude','https://example.test')).rejects.toThrow('VPN_GUARD_BLOCKED');
});
