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
