import {expect,it,vi} from 'vitest';
import {AgyOAuthLogin} from './agy-oauth-login.js';
const config={clientId:'synthetic.apps.googleusercontent.com',clientSecret:'synthetic-app-secret',scopes:['openid','https://www.googleapis.com/auth/userinfo.email']};
function fixture(){
 const calls:Array<{url:string;init:RequestInit|undefined}>=[];
 const login=new AgyOAuthLogin({appConfig:async()=>config,fetch:async(input,init)=>{
  const url=String(input);calls.push({url,init});
  if(url.endsWith('/token'))return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600});
  if(url.endsWith('/userinfo'))return Response.json({email:'fixture@example.com'});
  return Response.json({cloudaicompanionProject:'fixture-project',paidTier:{id:'fixture-subscription'}});
 }});
 return {login,calls};
}
it('starts PKCE without network, then keeps all Google tokens and project binding server-side',async()=>{
 const {login,calls}=fixture();
 try{
  const started=await login.start();const url=new URL(started.authorizeUrl);
  expect(calls).toHaveLength(0);expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(started).not.toHaveProperty('clientSecret');
  const callback=new URL(url.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({code:'synthetic-code',state:url.searchParams.get('state')!}).toString();
  const result=await login.complete(started.sessionId,callback.toString());
  expect(result.secret.agy.projectId).toBe('fixture-project');expect(result.secret.agy.clientSecret).toBe('synthetic-app-secret');
  expect(calls.map(call=>new URL(call.url).host)).toEqual(['oauth2.googleapis.com','www.googleapis.com','cloudcode-pa.googleapis.com']);
  const body=calls[0]!.init!.body as URLSearchParams;expect(body.get('code_verifier')).toBeTruthy();
  await expect(login.complete(started.sessionId,'synthetic-code')).rejects.toThrow('used');
 }finally{login.dispose();}
});
it('rejects foreign callback state and origin before any provider request',async()=>{
 const {login,calls}=fixture();try{
  const started=await login.start();
  for(const callback of ['http://foreign.example/?code=synthetic&state=wrong','http://127.0.0.1:1/?code=synthetic&state=wrong'])await expect(login.complete(started.sessionId,callback)).rejects.toThrow('match');
  expect(calls).toHaveLength(0);
 }finally{login.dispose();}
});
it('never exposes provider rejection bodies',async()=>{
 const login=new AgyOAuthLogin({appConfig:async()=>config,fetch:async()=>Response.json({error:'synthetic-private-body'},{status:400})});
 try{const s=await login.start();await expect(login.complete(s.sessionId,'synthetic-code')).rejects.toThrow('HTTP 400');}finally{login.dispose();}
});
it('cancels pending authorization requests and bounds session lifetime',async()=>{
 const login=new AgyOAuthLogin({appConfig:async()=>config,fetch:async()=>new Promise(()=>{})});
 try{const s=await login.start();const result=login.complete(s.sessionId,'synthetic-code');login.cancel(s.sessionId);await expect(result).rejects.toThrow('could not complete');}finally{login.dispose();}
 vi.useFakeTimers();
 const f=fixture();try{const s=await f.login.start();await vi.advanceTimersByTimeAsync(600001);await expect(f.login.complete(s.sessionId,'synthetic-code')).rejects.toThrow('expired');expect(f.calls).toHaveLength(0);}finally{f.login.dispose();vi.useRealTimers();}
});
it('counts concurrent starts and refuses late config completion after disposal',async()=>{
 let resolve!:(config:typeof configValue)=>void;
 const configValue=config;
 const pending=new Promise<typeof config>(done=>{resolve=done;});
 const login=new AgyOAuthLogin({appConfig:()=>pending,fetch:async()=>{throw Error('Unexpected request');}});
 const starts=Array.from({length:8},()=>login.start());
 await expect(login.start()).rejects.toThrow('Too many');
 login.dispose();resolve(configValue);
 const results=await Promise.allSettled(starts);expect(results.every(item=>item.status==='rejected')).toBe(true);
});
it('does not turn missing project or enterprise bootstrap into a personal subscription',async()=>{
 for(const bootstrap of [{paidTier:{id:'fixture'}},{cloudaicompanionProject:'fixture',gcpManaged:true},{cloudaicompanionProject:'fixture',paidTier:{usesGcpTos:true}}]){
  const login=new AgyOAuthLogin({appConfig:async()=>config,fetch:async(input)=>{
   const url=String(input);
   if(url.endsWith('/token'))return Response.json({access_token:'synthetic',refresh_token:'synthetic',expires_in:3600});
   if(url.endsWith('/userinfo'))return Response.json({email:'fixture@example.com'});
   return Response.json(bootstrap);
  }});
  try{const s=await login.start();await expect(login.complete(s.sessionId,'synthetic-code')).rejects.toThrow(/eligible|enterprise/);}finally{login.dispose();}
 }
});
it('browser URL is bound to an unexpired unused session',async()=>{
 let now=1000;const login=new AgyOAuthLogin({appConfig:async()=>config,fetch:vi.fn(),now:()=>now});
 try{const started=await login.start();expect(login.authorizationUrl(started.sessionId)).toBe(started.authorizeUrl);
 expect(()=>login.authorizationUrl('foreign')).toThrow();now=started.expiresAt;expect(()=>login.authorizationUrl(started.sessionId)).toThrow();
 now=1000;login.cancel(started.sessionId);expect(()=>login.authorizationUrl(started.sessionId)).toThrow();}finally{login.dispose();}
});

function onboardingFixture(initial:Record<string,unknown>,operation:Record<string,unknown>={done:true},final:Record<string,unknown>={cloudaicompanionProject:'resolved-project',paidTier:{id:'paid-personal'}}){
 const calls:string[]=[];let onboarded=false;
 const login=new AgyOAuthLogin({appConfig:async()=>config,fetch:async(input,init)=>{
  const url=String(input);calls.push(url);
  if(url.endsWith('/token'))return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600});
  if(url.endsWith('/userinfo'))return Response.json({email:'fixture@example.com'});
  if(url.includes('cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')&&!url.includes('daily-'))return Response.json(initial);
  if(url.endsWith(':onboardUser')){onboarded=true;expect(JSON.parse(String(init?.body))).toEqual({tierId:'free-tier',metadata:{ideType:'ANTIGRAVITY'}});return Response.json(operation);}
  if(url.includes('/operations/'))return Response.json({done:true});
  if(url.includes('daily-')&&url.endsWith(':loadCodeAssist'))return Response.json(onboarded?final:initial);
  throw Error('Unexpected request');
 }});
 return {login,calls};
}
it('resolves missing project through native personal onboarding and final actual tier',async()=>{
 const {login,calls}=onboardingFixture({allowedTiers:[{id:'free-tier'}]});
 try{const s=await login.start();const result=await login.complete(s.sessionId,'synthetic-code');expect(result.secret.agy.projectId).toBe('resolved-project');expect(result.subscriptionType).toBe('paid-personal');expect(calls.slice(-2)).toEqual(['https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser','https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist']);}finally{login.dispose();}
});
it('polls only a validated operation at the fixed personal endpoint',async()=>{
 const {login,calls}=onboardingFixture({allowedTiers:[{id:'free-tier'}]},{name:'operations/synthetic-operation',done:false});
 try{const s=await login.start();await login.complete(s.sessionId,'synthetic-code');expect(calls).toContain('https://daily-cloudcode-pa.googleapis.com/v1internal/operations/synthetic-operation');}finally{login.dispose();}
});
it.each([{allowedTiers:[]},{allowedTiers:[{id:'other'}]},{allowedTiers:[{id:'free-tier'}],paidTier:{usesGcpTos:true}}])('never onboards without personal eligibility: %j',async initial=>{
 const {login,calls}=onboardingFixture(initial);try{const s=await login.start();await expect(login.complete(s.sessionId,'synthetic-code')).rejects.toThrow();expect(calls.some(u=>u.endsWith(':onboardUser'))).toBe(false);}finally{login.dispose();}
});
it.each([{name:'https://foreign.invalid/private',done:false},{done:true,error:{message:'synthetic-private-error'}}])('rejects invalid operations without raw errors: %j',async operation=>{
 const {login,calls}=onboardingFixture({allowedTiers:[{id:'free-tier'}]},operation);try{const s=await login.start();const error=await login.complete(s.sessionId,'synthetic-code').catch(e=>e as Error);expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('synthetic-private-error');expect(calls.some(u=>u.includes('foreign.invalid'))).toBe(false);}finally{login.dispose();}
});
it.each([{},{cloudaicompanionProject:'resolved',gcpManaged:true}])('refuses unresolved or enterprise final state: %j',async final=>{
 const {login}=onboardingFixture({allowedTiers:[{id:'free-tier'}]},{done:true},final);try{const s=await login.start();await expect(login.complete(s.sessionId,'synthetic-code')).rejects.toThrow(/project|enterprise/);}finally{login.dispose();}
});

it('cancels onboarding polling before any operation fetch',async()=>{
 const {login,calls}=onboardingFixture({allowedTiers:[{id:'free-tier'}]},{name:'operations/synthetic-operation'});
 try{const s=await login.start();const result=login.complete(s.sessionId,'synthetic-code');const rejected=expect(result).rejects.toThrow();
 for(let n=0;n<50&&!calls.some(u=>u.endsWith(':onboardUser'));n++)await new Promise(resolve=>setImmediate(resolve));
 expect(calls.some(u=>u.endsWith(':onboardUser'))).toBe(true);login.cancel(s.sessionId);await rejected;
 expect(calls.some(u=>u.includes('/operations/'))).toBe(false);
 }finally{login.dispose();}
});

it('recovers an existing personal project on Daily without registering again',async()=>{
 const calls:string[]=[];const login=new AgyOAuthLogin({appConfig:async()=>config,fetch:async input=>{
 const url=String(input);calls.push(url);
 if(url.endsWith('/token'))return Response.json({access_token:'synthetic',refresh_token:'synthetic',expires_in:3600});
 if(url.endsWith('/userinfo'))return Response.json({email:'fixture@example.com'});
 if(url.includes('daily-'))return Response.json({cloudaicompanionProject:'existing-project',currentTier:{id:'existing-tier'}});
 return Response.json({});
 }});
 try{const s=await login.start();const result=await login.complete(s.sessionId,'synthetic-code');expect(result.secret.agy.projectId).toBe('existing-project');expect(calls.some(u=>u.endsWith(':onboardUser'))).toBe(false);}finally{login.dispose();}
});

it('uses the official remote code callback and identical redirect in token exchange',async()=>{
 const {login,calls}=fixture();try{const s=await login.start();const u=new URL(s.authorizeUrl);
 expect(u.searchParams.get('redirect_uri')).toBe('https://antigravity.google/oauth-callback');
 expect(u.searchParams.get('scope')!.split(' ')).toEqual(['cloud-platform','userinfo.email','userinfo.profile','cclog','experimentsandconfigs','aicode'].map(x=>'https://www.googleapis.com/auth/'+x).concat('openid'));
 await login.complete(s.sessionId,'synthetic-manual-code');const token=calls[0]!.init!.body as URLSearchParams;
 expect(token.get('redirect_uri')).toBe('https://antigravity.google/oauth-callback');expect(token.get('code')).toBe('synthetic-manual-code');expect(token.get('code_verifier')).toBeTruthy();
 }finally{login.dispose();}
});

it('accepts the structured managed project without unnecessary onboarding',async()=>{
 const {login,calls}=onboardingFixture({cloudaicompanionProject:{id:' existing-project '},currentTier:{id:'personal'}});
 try{const session=await login.start();const result=await login.complete(session.sessionId,'synthetic-code');
 expect(result.secret.agy.projectId).toBe('existing-project');expect(calls).toHaveLength(3);expect(calls.some(u=>u.endsWith(':onboardUser'))).toBe(false);
 }finally{login.dispose();}
});
it('accepts a structured project in the final onboarding response',async()=>{
 const {login}=onboardingFixture({allowedTiers:[{id:'free-tier'}]},{done:true},{cloudaicompanionProject:{id:'final-project'}});
 try{const session=await login.start();expect((await login.complete(session.sessionId,'synthetic-code')).secret.agy.projectId).toBe('final-project');}finally{login.dispose();}
});
it.each(['UNSUPPORTED_LOCATION','untrusted-private-reason'])('reports only allowlisted eligibility reasons: %s',async reasonCode=>{
 const {login,calls}=onboardingFixture({ineligibleTiers:[{tierId:'free-tier',reasonCode,reasonMessage:'private-provider-message',validationUrl:'https://private.invalid'}]});
 try{const session=await login.start();const error=await login.complete(session.sessionId,'synthetic-code').catch(e=>e as Error);
 expect(error).toBeInstanceOf(Error);expect(String(error)).not.toMatch(/private|untrusted/);
 expect(String(error)).toContain(reasonCode==='UNSUPPORTED_LOCATION'?'current location':'no managed');
 expect(calls.some(u=>u.endsWith(':onboardUser'))).toBe(false);
 }finally{login.dispose();}
});

it('retains explicit bootstrap eligibility when Daily has no registration yet',async()=>{
 let onboarded=false;let onboardCalls=0;
 const login=new AgyOAuthLogin({appConfig:async()=>config,fetch:async input=>{
 const url=String(input);
 if(url.endsWith('/token'))return Response.json({access_token:'synthetic',refresh_token:'synthetic',expires_in:3600});
 if(url.endsWith('/userinfo'))return Response.json({email:'fixture@example.com'});
 if(!url.includes('daily-'))return Response.json({allowedTiers:[{id:'free-tier'}]});
 if(url.endsWith(':onboardUser')){onboarded=true;onboardCalls++;return Response.json({done:true});}
 return Response.json(onboarded?{cloudaicompanionProject:{id:'registered-project'}}:{});
 }});
 try{const s=await login.start();expect((await login.complete(s.sessionId,'synthetic-code')).secret.agy.projectId).toBe('registered-project');expect(onboardCalls).toBe(1);}finally{login.dispose();}
});
