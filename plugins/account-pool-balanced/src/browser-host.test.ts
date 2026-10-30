import {expect,it,vi} from 'vitest';
import {createBrowserRouter, browserHostContract, createMacBrowserHandlers} from './browser-host.js';
const account={id:'11111111-1111-4111-8111-111111111111',provider:'kimi' as const,email:'test@example.com',label:'Test'};
it('pins remote browser to Mac and sends only browser metadata',async()=>{
 const call=vi.fn(async()=>({opened:true as const}));const local=vi.fn();
 const router=createBrowserRouter({getHostId:()=> 'mac',listHosts:async()=>[{id:'mac',status:'connected'}],accounts:async()=>[{...account,apiKey:'must-not-travel'}],callHost:call,localOpen:local,localList:async()=>[]});
 await router.open(account.id,'https://example.com/login');
 expect(call).toHaveBeenCalledWith('open',{accounts:[account],accountId:account.id,url:'https://example.com/login'},'mac');
 expect(local).not.toHaveBeenCalled();
});
it('never falls back or retries on offline or uncertain remote launch',async()=>{
 const local=vi.fn();let online=false;const call=vi.fn(async()=>{throw Error('timeout');});
 const router=createBrowserRouter({getHostId:()=> 'mac',listHosts:async()=>online?[{id:'mac',status:'connected'}]:[],accounts:async()=>[account],callHost:call,localOpen:local,localList:async()=>[]});
 await expect(router.open(account.id)).rejects.toThrow();expect(call).not.toHaveBeenCalled();
 online=true;await expect(router.open(account.id)).rejects.toThrow();expect(call).toHaveBeenCalledTimes(1);expect(local).not.toHaveBeenCalled();
});
it('host refuses VPN-off and unsupported OS before browser work; VPN-on reaches only local registry',async()=>{
 let connected=false;const launch=vi.fn(async(_options:unknown)=>({}));
 const handlers=createMacBrowserHandlers({platform:()=> 'darwin',dataDir:()=>'/synthetic/bb',registryExists:async()=>true,readEvidence:async()=>({state:connected?'connected':'disconnected',assurance:connected?'verified_ipv4':'unverified'}),open:launch,list:async()=>[]});
 await expect(handlers.open({accounts:[account],accountId:account.id})).rejects.toThrow();expect(launch).not.toHaveBeenCalled();
 connected=true;expect(await handlers.open({accounts:[account],accountId:account.id})).toEqual({opened:true});
 expect(launch.mock.calls[0]?.[0]).toMatchObject({dataDir:'/synthetic/bb',query:account.id});
 const other=createMacBrowserHandlers({platform:()=> 'linux',dataDir:()=>'/synthetic/bb',registryExists:async()=>true,readEvidence:async()=>({state:'connected',assurance:'verified_ipv4'}),open:launch,list:async()=>[]});
 await expect(other.open({accounts:[account],accountId:account.id})).rejects.toThrow();expect(launch).toHaveBeenCalledTimes(1);
});
it('rejects arbitrary paths, credentials and invalid URLs in host contract',()=>{
 const schema=browserHostContract.open.input as any;
 for(const extra of [{apiKey:'secret'},{dataDir:'/tmp'},{url:'file:///tmp/a'},{url:'https://user@example.com'}])expect(schema.safeParse({accounts:[account],accountId:account.id,...extra}).success).toBe(false);
});
it('refuses missing retained registry rather than creating duplicate native profiles',async()=>{
 const open=vi.fn();const h=createMacBrowserHandlers({platform:()=> 'darwin',dataDir:()=>'/synthetic/bb',registryExists:async()=>false,readEvidence:async()=>({state:'connected',assurance:'verified_ipv4'}),open,list:async()=>[]});
 await expect(h.open({accounts:[account],accountId:account.id})).rejects.toThrow();expect(open).not.toHaveBeenCalled();
});
it('pins Google onboarding to configured Mac and a separate profile',async()=>{
 const call=vi.fn(async(_m:string,_i:unknown,_h:string)=>({opened:true as const}));const local=vi.fn();let host:string|null='mac';
 const router=createBrowserRouter({getHostId:()=>host,listHosts:async()=>[{id:'mac',status:'connected'}],accounts:async()=>[account],callHost:call,localOpen:local,localList:async()=>[]});
 await router.openAgyLogin('https://accounts.google.com/o/oauth2/v2/auth?state=synthetic');
 const input=call.mock.calls[0]![1] as {accountId:string;accounts:unknown[]};
 expect(input.accountId).not.toBe(account.id);expect(input.accounts.at(-1)).toMatchObject({provider:'agy',email:null});expect(local).not.toHaveBeenCalled();
 await expect(router.openAgyLogin('https://evil.example/login')).rejects.toThrow();
 host=null;await expect(router.openAgyLogin('https://accounts.google.com/o/oauth2/v2/auth')).rejects.toThrow('Select');expect(call).toHaveBeenCalledTimes(1);
});

it('keeps first-use close-and-retry guidance without exposing remote errors',async()=>{
 const router=createBrowserRouter({getHostId:()=> 'mac',listHosts:async()=>[{id:'mac',status:'connected'}],accounts:async()=>[account],callHost:async()=>{throw Error('private remote details');},localOpen:vi.fn(),localList:async()=>[]});
 const error=await router.openAgyLogin('https://accounts.google.com/o/oauth2/v2/auth').catch(e=>e as Error);
 if(!(error instanceof Error))throw Error('Expected browser failure');
 expect(error.message).toContain('close Helium once');expect(error.message).not.toContain('private remote details');
});
