import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAccountPoolPlugin} from './server.js';
import {accountSchema} from './contracts.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const appConfig={clientId:'synthetic.apps.googleusercontent.com',clientSecret:'synthetic-application-secret',scopes:['openid','https://www.googleapis.com/auth/userinfo.email']};
async function fixture(streamResponse?:()=>Response){
 const requests:Request[]=[];
 const mock:typeof fetch=async(input,init)=>{
  const request=new Request(input,init);requests.push(request);
  if(request.url.endsWith('/token'))return Response.json({access_token:'synthetic-google-access',refresh_token:'synthetic-google-refresh',expires_in:3600});
  if(request.url.endsWith('/userinfo'))return Response.json({email:'fixture@example.com'});
  if(request.url.endsWith(':loadCodeAssist'))return Response.json({cloudaicompanionProject:'synthetic-bound-project',paidTier:{id:'synthetic-personal'}});
  if(request.url.endsWith(':fetchAvailableModels'))return Response.json({models:{'gemini-3.8-flash-high':{maxTokens:100}},privateTrace:'synthetic'});
  if(request.url.includes(':streamGenerateContent')&&streamResponse)return streamResponse();
  if(request.url.includes(':streamGenerateContent'))return new Response('data: {"response":{"candidates":[]},"traceId":"synthetic-private"}\n\n',{headers:{'content-type':'text/event-stream'}});
  return Response.json({response:{candidates:[]},traceId:'synthetic-private'});
 };
 const dataDir=await mkdtemp(path.join(tmpdir(),'pool-agy-test-'));
 const {bb,harness}=createFakePluginHost({pluginId:'account-pool',dataDir,sdk:{hosts:{list:async()=>[{id:'host-one',name:'Fixture'}]},system:{providerStates:async()=>({providers:[]})},plugins:{list:async()=>({plugins:[]})}}});
 await createAccountPoolPlugin({fetch:mock,fetchIpv4:mock,agyAppConfig:async()=>appConfig})(bb);
 const service=harness.behavior.runService('hub');
 cleanups.push(async()=>{service.controller.abort();await service.done;await harness.lifecycle.dispose();await rm(dataDir,{recursive:true,force:true});});
 await vi.waitFor(async()=>{const status=await harness.behavior.callRpc('status.get',null) as {accepting:boolean};expect(status.accepting).toBe(true);});
 const start=await harness.behavior.callRpc('agyLogin.start',null) as {sessionId:string};expect(requests).toHaveLength(0);
 const account=accountSchema.parse(await harness.behavior.callRpc('agyLogin.complete',{sessionId:start.sessionId,pasted:'synthetic-authorization-code'}));
 const env=await harness.behavior.resolveProviderEnv('acp-agy',{hostId:'host-one',projectId:'project-one',threadId:'thread-one'});
 const token=env.find(entry=>entry.name==='OXI_AGY_POOL_AUTH_TOKEN')?.value;
 if(typeof token!=='string')throw Error('Missing pool credential');
 return {bb,harness,requests,token,account,env,dataDir};
}
it('central login issues only pool credentials, forwards native wire and unwraps JSON/SSE/catalog',async()=>{
 const f=await fixture();expect(f.account.provider).toBe('agy');expect(f.account.autopilotAllowed).toBe(false);
 expect(JSON.stringify(f.env)).not.toContain('synthetic-google');expect(JSON.stringify(f.env)).not.toContain('synthetic-application-secret');
 const headers={authorization:`Bearer ${f.token}`,'content-type':'application/json'};
 for(const action of ['generateContent','streamGenerateContent']){
  const response=await f.harness.behavior.fetchHttp('POST',`/agy/v1beta/models/gemini-3.8-flash-high:${action}`,{headers,body:JSON.stringify({contents:[{role:'user',parts:[{text:'synthetic'}]}]})});
  expect(response.status).toBe(200);const text=await response.text();expect(text).toContain('candidates');expect(text).not.toContain('synthetic-private');
 }
 const catalog=await f.harness.behavior.fetchHttp('GET','/agy/v1beta/models',{headers});expect(catalog.status).toBe(200);expect(await catalog.json()).toMatchObject({models:[{name:'models/gemini-3.8-flash-high'}]});
 const sent=f.requests.filter(r=>r.url.includes('daily-cloudcode-pa'));
 expect(sent).toHaveLength(4);
 for(const req of sent){expect(req.method).toBe('POST');expect(req.headers.get('authorization')).toBe('Bearer synthetic-google-access');expect(await req.json()).toMatchObject({project:'synthetic-bound-project'});}
});
it('shared project and trusted-purpose permissions also gate native routes',async()=>{
 const f=await fixture();
 await f.harness.behavior.callRpc('account.setProjects',{accountId:f.account.id,projects:{onlySelected:true,rules:[{projectId:'other-project',role:'primary'}]}});
 const response=await f.harness.behavior.fetchHttp('POST','/agy/v1beta/models/gemini-3.8-flash-high:generateContent',{headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},body:'{"contents":[]}'});
 expect(response.status).toBe(403);expect(f.requests.filter(r=>r.url.includes(':generateContent'))).toHaveLength(0);
});

it('purpose-bound native requests deny default opt-out and use the same admission on all routes',async()=>{
 const f=await fixture();const file=path.join(f.dataDir,'synthetic-purpose.token');
 const issued=await f.harness.behavior.runCli(['client','add','synthetic-purpose','--project','project-one','--purpose','autopilot','--output',file]);expect(issued.exitCode).toBe(0);
 const key=(await readFile(file,'utf8')).trim();
 const request=(method:'GET'|'POST',route:string)=>f.harness.behavior.fetchHttp(method,route,{headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},...(method==='POST'?{body:'{"contents":[]}'}:{})});
 for(const [method,route] of [['GET','/agy/v1beta/models'],['POST','/agy/v1beta/models/gemini-3.8-flash-high:generateContent'],['POST','/agy/v1beta/models/gemini-3.8-flash-high:streamGenerateContent']] as const){
  const denied=await request(method,route);expect(denied.status).toBe(403);
 }
 await f.harness.behavior.callRpc('account.setAutopilotAllowed',{accountId:f.account.id,allowed:true,expectedAllowed:false});
 const allowed=await request('POST','/agy/v1beta/models/gemini-3.8-flash-high:generateContent');expect(allowed.status).toBe(200);await allowed.text();
 await f.harness.behavior.callRpc('account.setAutopilotAllowed',{accountId:f.account.id,allowed:false,expectedAllowed:true});
 const deniedAgain=await request('POST','/agy/v1beta/models/gemini-3.8-flash-high:generateContent');expect(deniedAgain.status).toBe(403);
});

it('canceled native streams release the account flight and cancel upstream once',async()=>{
 let canceled=0;
 const f=await fixture(()=>new Response(new ReadableStream<Uint8Array>({
  start(controller){controller.enqueue(new TextEncoder().encode('data: {"response":{"candidates":[]}}\n\n'));},
  cancel(){canceled++;},
 }),{headers:{'content-type':'text/event-stream'}}));
 const response=await f.harness.behavior.fetchHttp('POST','/agy/v1beta/models/gemini-3.8-flash-high:streamGenerateContent',{headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},body:'{"contents":[]}'});
 expect(response.status).toBe(200);
 const reader=response.body!.getReader();await reader.read();await reader.cancel();
 await vi.waitFor(async()=>{
  const status=await f.harness.behavior.callRpc('status.get',null) as {inFlight:number};
  expect(status.inFlight).toBe(0);expect(canceled).toBe(1);
 });
});
