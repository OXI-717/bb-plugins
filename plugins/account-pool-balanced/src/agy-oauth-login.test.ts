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
  try{const s=await login.start();await expect(login.complete(s.sessionId,'synthetic-code')).rejects.toThrow(/Activate|enterprise/);}finally{login.dispose();}
 }
});
