import {expect,it,vi} from 'vitest';
import {agyRoute,agyRequest,agyResponse} from './agy-wire.js';
const encode=new TextEncoder();
it('only accepts explicit native GenAI gateway paths',()=>{
 expect(agyRoute(new URL('https://pool.example/http/agy/v1beta/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse'))).toEqual({kind:'stream',model:'gemini-3.8-flash-high'});
 for(const path of ['/agy/v1beta/models/x:countTokens','/agy/v1beta/models/%2Fbad:generateContent','/v1/responses','/agy/v1beta/models/x:generateContent/extra'])expect(agyRoute(new URL('https://pool.example'+path))).toBeNull();
});
it('wraps the selected server account project and preserves GenAI tools/thinking',()=>{
 const request={contents:[{role:'user',parts:[{text:'synthetic'}]}],tools:[{functionDeclarations:[{name:'read_file'}]}],generationConfig:{thinkingConfig:{thinkingBudget:1024}}};
 expect(JSON.parse(new TextDecoder().decode(agyRequest({kind:'generate',model:'gemini-3.8-flash-high'},encode.encode(JSON.stringify(request)),'synthetic-server-project')))).toEqual({project:'synthetic-server-project',model:'gemini-3.8-flash-high',request});
 expect(()=>agyRequest({kind:'generate',model:'x'},encode.encode('{"input":"wrong wire"}'),'fixture')).toThrow('contents');
 expect(()=>agyRequest({kind:'generate',model:'x'},encode.encode('{"contents":[],"project":"foreign"}'),'fixture')).toThrow('envelope');
});
it('unwraps JSON without exposing provider trace/credit metadata or cookies',async()=>{
 const inner={candidates:[{content:{parts:[{functionCall:{name:'read_file',args:{}},thoughtSignature:'synthetic-signature'}]}}]};
 const response=agyResponse({kind:'generate',model:'x'},Response.json({response:inner,traceId:'synthetic-private-trace',remainingCredits:42},{headers:{'set-cookie':'synthetic-cookie','x-private':'synthetic'}}));
 expect(await response.json()).toEqual(inner);
 expect([...response.headers.keys()]).toEqual(['content-type']);
});
it('handles fragmented UTF-8 and CRLF events, preserving only inner responses',async()=>{
 const bytes=encode.encode(': heartbeat\r\n\r\ndata: {"response":{"text":"тест"},"traceId":"synthetic"}\r\n\r\ndata: {"response":{"done":true}}\n\n');
 let offset=0;
 const body=new ReadableStream<Uint8Array>({pull(controller){if(offset===bytes.length){controller.close();return;}controller.enqueue(bytes.slice(offset,++offset));}});
 const response=agyResponse({kind:'stream',model:'x'},new Response(body,{headers:{'content-type':'text/event-stream'}}));
 expect(await response.text()).toBe('data: {"text":"тест"}\n\ndata: {"done":true}\n\n');
});
it('rejects malformed/truncated/oversized events and propagates cancellation',async()=>{
 for(const text of ['data: {"response":{}}','data: {"traceId":"synthetic"}\n\n','data: '+ 'x'.repeat(1024*1024)+'\n\n']){
  const response=agyResponse({kind:'stream',model:'x'},new Response(text,{headers:{'content-type':'text/event-stream'}}));
  await expect(response.text()).rejects.toThrow();
 }
 let cancelled=false;
 const upstream=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
 await agyResponse({kind:'stream',model:'x'},new Response(upstream,{headers:{'content-type':'text/event-stream'}})).body!.cancel();
 await vi.waitFor(()=>expect(cancelled).toBe(true));
});
it('maps only enabled model entries, dropping metadata and invalid names',async()=>{
 const response=agyResponse({kind:'models'},Response.json({models:{'gemini-3.8-flash-high':{maxTokens:100,maxOutputTokens:20},'disabled-model':{disabled:true},'bad/name':{}},account:'synthetic-private'}));
 expect(await response.json()).toEqual({models:[{name:'models/gemini-3.8-flash-high',displayName:'gemini-3.8-flash-high',supportedGenerationMethods:['generateContent','streamGenerateContent'],inputTokenLimit:100,outputTokenLimit:20}]});
});

it('does not disclose malformed provider data in parser errors',async()=>{
 const marker='synthetic-private-envelope';
 for(const kind of ['stream','generate'] as const){
  const raw=kind==='stream'?`data: ${marker}\n\n`:marker;
  const response=agyResponse({kind,model:'x'},new Response(raw,{headers:{'content-type':kind==='stream'?'text/event-stream':'application/json'}}));
  await expect(response.text()).rejects.toThrow('Invalid Code Assist JSON');
 }
});
