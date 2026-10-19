import {createFakePluginHost,makeHostResponse,makeThreadResponse,makeTurnFailedEvent,makeMessageDispatchHookContext} from '@get-bb/plugin-sdk/testing';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAccountPoolPlugin} from './server.js';
import {vpnProof} from './vpn-test-fixture.js';
import type {PoolProvider,Account} from './contracts.js';
const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{while(cleanup.length)await cleanup.pop()!();});
async function setup(provider:PoolProvider,providerId:string){
 const dir=await mkdtemp(path.join(tmpdir(),'pool-identity-'));
 const host=createFakePluginHost({pluginId:'account-pool-balanced',dataDir:dir,sdk:{hosts:{list:async()=>[makeHostResponse({id:'host-one'})]},system:{providerStates:async()=>({providers:[]})},threads:{events:{list:async()=>[]},get:async({threadId})=>({...makeThreadResponse({id:threadId,providerId,projectId:'project-one'}),environment:{hostId:'host-one'}}) as never}}});
 const fetcher:typeof fetch=async input=>String(input).includes('exchange_user_api_key')?Response.json({accessToken:'synthetic-access'}):Response.json({id:'synthetic-response'});
 await createAccountPoolPlugin({fetch:fetcher,fetchIpv4:fetcher,vpnPayload:async now=>vpnProof(now,'connected')})(host.bb);
 const service=host.harness.behavior.runService('hub');
 cleanup.push(async()=>{service.controller.abort();await service.done;await host.harness.lifecycle.dispose();await rm(dir,{recursive:true,force:true});});
 const account=await host.harness.behavior.callRpc('account.add',{provider,source:{kind:'api-key',apiKey:'synthetic-key'},label:'Synthetic subscription',priority:0}) as Account;
 await host.harness.behavior.callRpc('account.setEmail',{accountId:account.id,email:'account@example.com',expectedEmail:null});
 if(provider==='devin')await host.harness.behavior.callRpc('account.add',{provider:'claude',source:{kind:'api-key',apiKey:'synthetic-secondary'},label:'Secondary fixture',priority:0});
 const env=await host.harness.behavior.resolveProviderEnv(provider==='devin'?'claude-code':providerId,{threadId:'thread-one',projectId:'project-one',hostId:'host-one'});
 const key=env.find(entry=>['ANTHROPIC_AUTH_TOKEN','CURSOR_API_KEY','OXI_DEVIN_POOL_TOKEN','KIMI_API_KEY','ZAI_API_KEY','OPENCODE_API_KEY'].includes(entry.name));
 expect(typeof key?.value).toBe('string');return {host,account,token:key!.value as string};
}
it.each([
 ['claude','claude-code','/v1/messages'],['kimi','acp-opencode-kimi','/kimi/v1/messages'],['zai','acp-opencode-zai','/zai/v1/chat/completions'],['opencode-go','acp-opencode-go','/opencode-go/v1/chat/completions'],['cursor','acp-oxi-cursor','/cursor/rpc'],['devin','acp-oxi-devin-pool','/devin/exa.seat_management_pb.SeatManagementService/GetUserStatus'],
] as const)('shows only the observed %s account in its own thread',async(provider,providerId,route)=>{
 const {host,account,token}=await setup(provider,providerId);
 expect(await host.harness.behavior.callRpc('thread.account',{threadId:'thread-one'})).toMatchObject({state:'unobserved',account:null});
 const body=provider==='devin'?Uint8Array.of(10,3,26,1,120):'{}';
 const response=await host.harness.behavior.fetchHttp('POST',route,{headers:{authorization:`${provider==='devin'?'Basic':'Bearer'} ${token}`,'x-api-key':token,'content-type':provider==='devin'?'application/proto':'application/json','x-bb-cursor-rpc-path':'agent.v1.AgentService/Run'},body});
 expect(response.status).toBe(200);await response.arrayBuffer();
 expect(await host.harness.behavior.callRpc('thread.account',{threadId:'thread-one'})).toMatchObject({state:'observed',account:{id:account.id,email:'account@example.com'}});
 expect(await host.harness.behavior.callRpc('thread.account',{threadId:'thread-two'})).toMatchObject({state:'unobserved',account:null});
 await host.harness.behavior.callRpc('bypass.set',{threadId:'thread-one',bypassed:true});
 expect(await host.harness.behavior.callRpc('thread.account',{threadId:'thread-one'})).toMatchObject({state:'bypassed',account:null});
});
it('rejects invalid emails and conflicting edits without changing the prior address',async()=>{
 const {host,account}=await setup('kimi','acp-opencode-kimi');
 await expect(host.harness.behavior.callRpc('account.setEmail',{accountId:account.id,email:'invalid'})).rejects.toThrow();
 await expect(host.harness.behavior.callRpc('account.setEmail',{accountId:account.id,email:'new@example.com',expectedEmail:null})).rejects.toThrow();
 const listed=await host.harness.behavior.callRpc('account.list',null) as Account[];expect(listed[0]?.email).toBe('account@example.com');
 await host.harness.behavior.callRpc('account.setEmail',{accountId:account.id,email:null,expectedEmail:'account@example.com'});
 expect((await host.harness.behavior.callRpc('account.list',null) as Account[])[0]?.email).toBeNull();
});
it('does not let a manually supplied address replace provider OAuth identity',async()=>{
 const {host,account}=await setup('claude','claude-code');
 const records=await host.bb.storage.kv.get<Account[]>('accounts:v1');
 await host.bb.storage.kv.set('accounts:v1',records!.map(value=>({...value,kind:'oauth',email:'verified@example.com'})));
 await expect(host.harness.behavior.callRpc('account.setEmail',{accountId:account.id,email:'manual@example.com'})).rejects.toThrow('OAuth email');
 expect((await host.bb.storage.kv.get<Account[]>('accounts:v1'))![0]!.email).toBe('verified@example.com');
});
it.each(['bypass','routing-off','account-disabled'] as const)('cancels queued recovery after actual %s settings remove pooled credentials',async change=>{
 const {host,account}=await setup('kimi','acp-opencode-kimi');
 host.harness.sdk.stub('threads.get',async()=>makeThreadResponse({id:'thread-one',providerId:'acp-opencode-kimi',status:'error'}));
 host.harness.sdk.stub('threads.events.list',async()=>[{threadId:'thread-one',type:'client/turn/requested',data:{requestId:'request-one'}}] as never);
 host.harness.sdk.stub('threads.queue.list',async()=>[]);
 const retry=vi.fn(async()=>({ok:true,delivery:'queued',queuedMessageId:'retry-one'}) as never);host.harness.sdk.stub('threads.retry',retry);
 await host.harness.behavior.emitThreadEvent('turn.failed',makeTurnFailedEvent({threadId:'thread-one',requestId:'request-one',errorInfo:{category:'connection-failed',httpStatusCode:503,providerCode:null}}));
 expect(retry).toHaveBeenCalledTimes(1);
 if(change==='bypass')await host.harness.behavior.callRpc('bypass.set',{threadId:'thread-one',bypassed:true});
 else if(change==='routing-off')await host.harness.behavior.callRpc('routing.set',{provider:'kimi',enabled:false});
 else await host.harness.behavior.callRpc('account.disable',{id:account.id});
 expect(await host.harness.behavior.resolveProviderEnv('acp-opencode-kimi',{threadId:'thread-one',projectId:'project-one',hostId:'host-one'})).toEqual([]);
 const hook=host.harness.registrations.hooks['message.dispatch']!;
 expect(await hook(makeMessageDispatchHookContext({thread:{id:'thread-one',status:'error'},requestedExecution:{providerId:'acp-opencode-kimi'},queuedMessage:{id:'retry-one',payload:{kind:'retry',retryOfTurnRequestId:'request-one',attempt:2,reason:'Temporary connection failure. Retry 1/3.'}}}))).toMatchObject({action:'reject'});
});
