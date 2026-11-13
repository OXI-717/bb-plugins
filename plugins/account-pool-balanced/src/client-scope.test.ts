import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { clientAccountScopeSchema, clientRouteAllowed, type ClientAccountScope } from './client-scope.js';
import { createHub } from './hub.js';
import { createAccountPoolPlugin } from './management-test-fixture.js';
import { accountPoolConfigSchema, type PoolProvider } from './contracts.js';
import { AccountStore, HubTokenStore, PoolAffinityStore, QuotaStore, QUOTA_MIGRATIONS } from './store.js';
import { combinedTokens } from './external-clients.js';
import type { AccountRoute } from './account-egress.js';
import { CURSOR_EXCHANGE_PATH, CURSOR_MOUNT_PREFIX } from './cursor-adapter.js';

const cleanups: Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.restoreAllMocks();});
const syntheticId='11111111-1111-4111-8111-111111111111';
const scope=(ids=[syntheticId]):ClientAccountScope=>({schema:'bb-account-pool/client-account-scope/1',accountIds:ids,egress:{id:'fixture-vpn',version:1}});
const profile={id:'fixture-vpn',version:1,label:'Fixture',node:'fixture-node',hostIds:['fixture-host'],transport:'ssh-connect' as const,
  endpoint:'http://127.0.0.1:19081',dns:'remote' as const,ipv4:true as const,ipv6:false as const,failure:'closed' as const,
  expectedExit:['192.0.2.1'],assurance:'proxy-enforced' as const};
async function directory(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'client-scope-'));cleanups.push(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

it('strictly validates authority, normalizes sets and accepts empty deny',()=>{
  expect(clientAccountScopeSchema.parse(scope([])).accountIds).toEqual([]);
  expect(clientAccountScopeSchema.parse(scope([syntheticId,syntheticId])).accountIds).toEqual([syntheticId]);
  for(const input of [{...scope(),extra:true},{...scope(),accountIds:['bad']},{...scope(),egress:{id:'fixture-vpn',version:0}}, {...scope(),egress:{...scope().egress,direct:true}}, {...scope(),accountIds:Array(33).fill(syntheticId)}])expect(clientAccountScopeSchema.safeParse(input).success).toBe(false);
  expect(clientRouteAllowed({assigned:false,profile:null,fetch:()=>undefined},scope())).toBe(false);
  expect(clientRouteAllowed({assigned:true,profile,fetch:()=>undefined},scope())).toBe(false);
});

it('persists immutable authority through restart/rotation/grace, isolates returned copies and revokes synchronously',async()=>{
  const dir=await directory();const tokens=new HubTokenStore(dir);
  await expect(tokens.forIssuedClient('machine','project',undefined,scope())).rejects.toThrow('external');
  await expect(tokens.forIssuedClient('external_fixture',null,undefined,scope())).rejects.toThrow('project');
  const token=await tokens.forIssuedClient('external_fixture','project',undefined,scope());
  const context=await tokens.authenticateContext(token);context!.accountScope!.accountIds.length=0;
  expect(tokens.validatesAccountScope(token,scope())).toBe(true);
  for(const other of [undefined,scope([]),{...scope(),egress:{id:'other',version:1}}])await expect(tokens.forIssuedClient('external_fixture','project',undefined,other)).rejects.toThrow('binding differs');
  await tokens.rotate('external_fixture');
  const rotated=await tokens.forIssuedClient('external_fixture','project',undefined,scope());
  expect(tokens.validatesAccountScope(token,scope())).toBe(true);
  const restored=new HubTokenStore(dir);expect((await restored.authenticateContext(token))!.accountScope).toEqual(scope());
  const both=combinedTokens(new HubTokenStore(await directory()),tokens);
  expect(both.validatesAccountScope(token,scope())).toBe(true);
  await tokens.remove('external_fixture');expect(both.validatesAccountScope(token,scope())).toBe(false);
  expect(await tokens.authenticateContext(rotated)).toBeNull();
});

it('rejects malformed persisted scopes instead of restoring unscoped authority',async()=>{
  const dir=await directory();const tokens=new HubTokenStore(dir);await tokens.forIssuedClient('external_fixture','project',undefined,scope());
  const file=path.join(dir,(await fs.readdir(dir)).find(n=>n.endsWith('.json'))!);
  const record=JSON.parse(await fs.readFile(file,'utf8'));record.accountScope.accountIds=['invalid'];await fs.writeFile(file,JSON.stringify(record));
  await expect(new HubTokenStore(dir).initialize()).rejects.toThrow();
});

async function fixture(provider:PoolProvider='claude',ids?:string[]) {
  const dir=await directory();const host=createFakePluginHost({pluginId:'fixture-pool',dataDir:dir});cleanups.push(()=>host.harness.lifecycle.dispose());
  const accounts=new AccountStore(host.bb.storage.kv,path.join(dir,'accounts'));
  const common={provider,kind:'api-key' as const,label:'Fixture',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,enabled:true};
  const add=(key:string,priority:number)=>accounts.add({...common,kind:provider==='codex'?'oauth':'api-key',priority,...(provider==='codex'?{codexAccountId:key}:{})},provider==='codex'
    ?{kind:'oauth',accessToken:key,refreshToken:'fixture-refresh',expiresAt:1900000000000+86400000}
    :{kind:'api-key',apiKey:key});
  const personal=await add('fixture-personal',100);
  const allowed=await add('fixture-permitted',200);
  const db=host.bb.storage.database();for(const sql of QUOTA_MIGRATIONS)db.exec(sql);
  const affinity=new PoolAffinityStore(db),quotas=new QuotaStore(db),tokens=new HubTokenStore(path.join(dir,'tokens'));
  const authority=scope(ids??[allowed.id]);const token=await tokens.forIssuedClient('external_fixture','project',undefined,authority);
  const legacy=await tokens.forIssuedClient('external_fixture_legacy','project');
  let status=200;const seen:string[]=[];const direct=vi.fn<typeof fetch>(async(_url,init)=>{if(String(_url).includes('exchange_user_api_key'))return Response.json({accessToken:'fixture-minted'});seen.push(new Headers(init?.headers).get('x-api-key')??new Headers(init?.headers).get('authorization')!);return Response.json({id:'fixture-response'},{status});});
  let route:AccountRoute={assigned:true,profile,fetch:()=>direct};
  const fallback=vi.fn<typeof fetch>(async()=>{throw Error('Unexpected personal transport');});
  let guardAction=async()=>{};
  const settings=accountPoolConfigSchema.parse({vpnOnlyProviders:[],vpnPolicyVersion:2,vpnGuardEnabled:true});
  const hub=createHub({route:'/pool',accounts,quotas,affinity,hubTokens:tokens,getSettings:()=>settings,
    accountRoute:async()=>route,guardCheck:async()=>{await guardAction();return 'direct';},fetch:fallback,fetchIpv4:fallback,now:()=>1900000000000});
  vi.spyOn(hub,'refreshUsage').mockResolvedValue();
  const controller=new AbortController();const done=hub.start(controller.signal);cleanups.push(async()=>{controller.abort();await done;});await new Promise(r=>setImmediate(r));
  const request=async(key=token,parent?:string,method='POST')=>{
    const r=await hub.handle(new Request('http://localhost/pool/v1/'+(method==='GET'?'models':'messages'),{method,headers:{authorization:`Bearer ${key}`,'content-type':'application/json','x-account-id':personal.id,'x-bb-project-id':'other',...(provider==='cursor'?{'x-cursor-rpc-path':'aiserver.v1.AiService/AvailableModels'}:{})},...(method==='GET'?{}:{body:JSON.stringify({accountId:personal.id,accountScope:scope([personal.id]),metadata:{user_id:JSON.stringify({session_id:parent?'child':'same',...(parent?{parent_session_id:parent}:{})})}})})}),provider);
    const text=await r.text();return {status:r.status,text};};
  return {hub,request,allowed,personal,accounts,affinity,tokens,token,legacy,seen,quotas,fallback,authority,transport:direct,
    status:(s:number)=>status=s,route:(r:AccountRoute)=>route=r,onGuard:(fn:()=>Promise<void>)=>guardAction=fn};
}

it('ignores client claims and personal active/parent affinity; leaves legacy active persistence untouched',async()=>{
  const f=await fixture();
  expect((await f.request(f.legacy)).status).toBe(200);
  expect((await f.request()).status).toBe(200);
  expect((await f.request(f.token,'same')).status).toBe(200);
  expect((await f.request(f.legacy)).status).toBe(200);
  expect(f.seen).toEqual(['fixture-personal','fixture-permitted','fixture-permitted','fixture-personal']);
  expect(f.affinity.loadProjectActiveAccounts().get('claude:project')?.accountId).toBe(f.personal.id);
  expect(f.fallback).not.toHaveBeenCalled();
});
it.each([{ids:[]},{ids:['22222222-2222-4222-8222-222222222222']}])('denies empty or nonexistent accounts without fallback (%j)',async ({ids})=>{
  const f=await fixture('claude',ids);expect((await f.request()).status).not.toBe(200);expect(f.seen).toEqual([]);expect(f.fallback).not.toHaveBeenCalled();
});
it.each(['disabled','project','quota','purpose'] as const)('retains the %s gate on permitted accounts',async gate=>{
  const f=await fixture();
  if(gate==='disabled')await f.accounts.setEnabled(f.allowed.id,false);
  if(gate==='project')await f.accounts.setProjects(f.allowed.id,{onlySelected:true,rules:[{projectId:'other',role:'inherit'}]});
  if(gate==='quota')f.quotas.put({...f.quotas.get(f.allowed.id),error:'fixture unavailable'});
  let key=f.token;
  if(gate==='purpose')key=await f.tokens.forIssuedClient('external_auto','project','autopilot',f.authority);
  expect((await f.request(key)).status).not.toBe(200);expect(f.seen).toEqual([]);
});
it.each([401,429,503])('never fails over outside scope on upstream %s',async status=>{
  const f=await fixture();f.status(status);expect((await f.request()).status).toBe(status);
  expect(f.seen).toHaveLength(1);expect(f.seen.every(key=>key==='fixture-permitted')).toBe(true);expect(f.fallback).not.toHaveBeenCalled();
});
it.each(['unassigned','missing-transport'] as const)('denies %s route before credentials or inference',async mode=>{
  const f=await fixture();const read=vi.spyOn(f.accounts,'readSecret');
  f.route(mode==='unassigned'?{assigned:false,profile:null,fetch:()=>undefined}:{assigned:true,profile,fetch:()=>undefined});
  expect((await f.request()).status).toBe(503);expect(read).not.toHaveBeenCalled();expect(f.seen).toEqual([]);
});
it.each([
  {name:'wrong-id',patch:{id:'other-exit'}},
  {name:'wrong-version',patch:{version:2}},
  {name:'wrong-assurance',patch:{assurance:'observe'}},
  {name:'wrong-failure',patch:{failure:'open'}},
  {name:'wrong-transport',patch:{transport:'direct'}},
])('denies $name independently with an available transport before reading credentials',async ({patch})=>{
  const f=await fixture();const read=vi.spyOn(f.accounts,'readSecret');
  // Invalid metadata is deliberate: isolate each guard while every other gate passes.
  const route={assigned:true,profile:{...profile,...patch},fetch:()=>f.transport} as unknown as AccountRoute;
  expect(route.fetch(true)).toBe(f.transport);
  f.route(route);
  expect((await f.request()).status).toBe(503);
  expect(read).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();expect(f.fallback).not.toHaveBeenCalled();expect(f.seen).toEqual([]);
});
it('rechecks revocation after network guard before dispatch',async()=>{
  const f=await fixture();f.onGuard(async()=>{await f.tokens.remove('external_fixture');});
  expect((await f.request()).status).toBe(403);expect(f.seen).toEqual([]);
});
it.each(['claude','codex'] as const)('runs %s model enumeration through the same scoped dispatch',async provider=>{
  const f=await fixture(provider);expect((await f.request(f.token,undefined,'GET')).status).toBe(200);
  expect(f.seen).toEqual([provider==='codex'?'Bearer fixture-permitted':'fixture-permitted']);
});
it.each([200,401,429,503])('Codex dispatch %s stays on the sole permitted account without replay',async status=>{
  const f=await fixture('codex');f.status(status);expect((await f.request()).status).toBe(status);
  expect(f.seen).toEqual(['Bearer fixture-permitted']);expect(f.fallback).not.toHaveBeenCalled();
});
it.each(['codex','zai','cursor'] as const)('service %s evidence excludes personal accounts and makes no readiness assertion',async provider=>{
  const f=await fixture(provider);const request=new Request('http://localhost/budget',{headers:{authorization:`Bearer ${f.token}`}});
  const response=provider==='codex'?await f.hub.codexBudget(request,true,async()=>false):provider==='zai'?await f.hub.zaiBudget(request,true,async()=>false):await f.hub.providerBudget(request,provider,true,async()=>false);
  expect(response.status).toBe(200);const body=await response.json();expect(JSON.stringify(body)).not.toContain(f.personal.id);expect(body.accounts.map((a:{accountId:string})=>a.accountId)).toEqual([f.allowed.id]);expect(body.route.ready).toBe(false);expect(f.seen).toEqual([]);
});

it('CLI issues scoped private credentials, rejects invalid scope, exchange retains authority and native rejects it',async()=>{
  const dir=await directory();const transport=vi.fn<typeof fetch>(async()=>{throw Error('No upstream');});
  const host=createFakePluginHost({pluginId:'account-pool-balanced',dataDir:dir,sdk:{hosts:{list:async()=>[]},system:{providerStates:async()=>({providers:[]})}}});cleanups.push(()=>host.harness.lifecycle.dispose());
  await createAccountPoolPlugin({fetch:transport,fetchIpv4:transport})(host.bb);
  const out=path.join(dir,'client.token');
  const issue=(name:string,fields:string[],file=out)=>host.harness.behavior.runCli(['client','add',name,'--output',file,...fields]);
  expect((await issue('bad',['--project','project','--account-scope-json','{"accountIds":[]}'])).exitCode).not.toBe(0);
  expect((await issue('unbound',['--account-scope-json',JSON.stringify(scope())])).exitCode).not.toBe(0);
  const issued=await issue('fixture',['--project','project','--account-scope-json',JSON.stringify(scope())],path.join(dir,'good.token'));expect(issued.exitCode).toBe(0);
  const token=(await fs.readFile(path.join(dir,'good.token'),'utf8')).trim();expect(issued.stdout).not.toContain(token);expect((await fs.stat(path.join(dir,'good.token'))).mode&0o777).toBe(0o600);
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  const exchanged=await host.harness.behavior.fetchHttp('POST',`/${CURSOR_MOUNT_PREFIX}${CURSOR_EXCHANGE_PATH}`,{headers,body:'{}'});
  expect(await exchanged.json()).toEqual({accessToken:token,refreshToken:token});
  const native=await host.harness.behavior.fetchHttp('POST','/native/agy',{headers,body:'{}'});expect(native.status).toBe(401);expect(transport).not.toHaveBeenCalled();
});

it('fences revocation during metadata lock acquisition, with no await between check and send',async()=>{
  const f=await fixture();const snapshot=f.accounts.withSnapshot.bind(f.accounts);
  vi.spyOn(f.accounts,'withSnapshot').mockImplementationOnce(async action=>{
    await f.tokens.remove('external_fixture');return snapshot(action);
  });
  expect((await f.request()).status).toBe(403);expect(f.seen).toEqual([]);
});
it('rechecks account eligibility during metadata lock acquisition before dispatch',async()=>{
  const f=await fixture();const snapshot=f.accounts.withSnapshot.bind(f.accounts);
  vi.spyOn(f.accounts,'withSnapshot').mockImplementationOnce(async action=>{
    await f.accounts.setEnabled(f.allowed.id,false);return snapshot(action);
  });
  expect((await f.request()).status).toBe(403);
  expect((await f.accounts.get(f.allowed.id))!.enabled).toBe(false);
  expect(f.transport).not.toHaveBeenCalled();expect(f.fallback).not.toHaveBeenCalled();expect(f.seen).toEqual([]);
});
it('routes Cursor control/model enumeration with the same account authority and scoped refresh transport',async()=>{
  const f=await fixture('cursor');expect((await f.request()).status).toBe(200);
  expect(f.seen).toEqual(['Bearer fixture-minted']);expect(f.fallback).not.toHaveBeenCalled();
});

it('refuses to join credential refresh started through a different egress',async()=>{
  const f=await fixture('cursor');await f.accounts.setEnabled(f.personal.id,false);let enter!:()=>void,unblock!:()=>void;
  const reached=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>unblock=r);
  f.transport.mockImplementationOnce(async()=>{enter();await gate;return Response.json({accessToken:'fixture-minted'});});
  f.route({assigned:true,profile:{...profile,id:'other-exit'},fetch:()=>f.transport});
  const pending=f.request(f.legacy);await reached;
  f.route({assigned:true,profile,fetch:()=>f.transport});
  try {expect((await f.request()).status).toBe(503);expect(f.seen).toEqual([]);}
  finally {unblock();await pending;}
});

const httpProfile={id:profile.id,version:1,label:'Fixture HTTP',hostIds:['fixture-host'],transport:'http-connect' as const,
  endpoint:'http://proxy.example:18444/',secretRef:syntheticId,failure:'closed' as const};
it('denies ordinary HTTP before provider secret access and preserves legacy behavior',async()=>{
  const f=await fixture();f.route({assigned:true,profile:httpProfile,fetch:()=>f.transport});
  const read=vi.spyOn(f.accounts,'readSecret');
  expect((await f.request()).status).toBe(503);expect(read).not.toHaveBeenCalled();
  expect(f.transport).not.toHaveBeenCalled();expect(f.fallback).not.toHaveBeenCalled();
  expect(clientRouteAllowed({assigned:true,profile:httpProfile,fetch:()=>f.transport})).toBe(true);
});
it('refuses lost HTTP acceptance at the metadata fence without replay',async()=>{
  const f=await fixture();let accepted=true;
  f.route({assigned:true,profile:httpProfile,fetch:()=>f.transport,scopeAccepted:(id)=>id===f.allowed.id&&accepted});
  const snapshot=f.accounts.withSnapshot.bind(f.accounts);
  vi.spyOn(f.accounts,'withSnapshot').mockImplementationOnce(async action=>{accepted=false;return snapshot(action);});
  expect((await f.request()).status).toBe(503);
  expect(f.transport).not.toHaveBeenCalled();expect(f.fallback).not.toHaveBeenCalled();
});
it('rechecks after recordUsed before reading the provider secret',async()=>{
  const f=await fixture();let accepted=true;
  f.route({assigned:true,profile:httpProfile,fetch:()=>f.transport,scopeAccepted:id=>id===f.allowed.id&&accepted});
  const record=f.accounts.recordUsed.bind(f.accounts),read=vi.spyOn(f.accounts,'readSecret');
  vi.spyOn(f.accounts,'recordUsed').mockImplementationOnce(async(...args)=>{const result=await record(...args);accepted=false;return result;});
  expect((await f.request()).status).toBe(503);expect(read).not.toHaveBeenCalled();
  expect(f.transport).not.toHaveBeenCalled();expect(f.fallback).not.toHaveBeenCalled();
});
it('permits only an accepted HTTP account and rechecks at transport start after the snapshot',async()=>{
  const f=await fixture();let accepted=true;
  f.route({assigned:true,profile:httpProfile,scopeAccepted:id=>id===f.allowed.id&&accepted,
    fetch:(_ipv4,beforeSend)=>async(...args)=>{accepted=false;beforeSend?.();return f.transport(...args);}});
  expect((await f.request()).status).toBe(503);
  expect(f.transport).not.toHaveBeenCalled();expect(f.fallback).not.toHaveBeenCalled();
});
it('uses the existing assigned HTTP transport when its synthetic source remains accepted',async()=>{
  const f=await fixture();
  f.route({assigned:true,profile:httpProfile,fetch:()=>f.transport,scopeAccepted:id=>id===f.allowed.id});
  expect((await f.request()).status).toBe(200);expect(f.seen).toEqual(['fixture-permitted']);
  expect(f.fallback).not.toHaveBeenCalled();
});
it('refuses lost acceptance at credential-refresh transport start without replay',async()=>{
  const f=await fixture('cursor');let accepted=true;
  f.route({assigned:true,profile:httpProfile,scopeAccepted:id=>id===f.allowed.id&&accepted,
    fetch:(_ipv4,beforeSend)=>async(...args)=>{accepted=false;beforeSend?.();return f.transport(...args);}});
  expect((await f.request()).status).toBe(503);
  expect(f.transport).not.toHaveBeenCalled();expect(f.fallback).not.toHaveBeenCalled();
});
