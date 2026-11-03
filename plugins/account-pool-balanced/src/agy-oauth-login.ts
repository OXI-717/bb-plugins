import {agyModelIds} from "./agy-wire.js";
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

export interface AgyAppConfig {clientId:string;clientSecret:string;scopes:string[]}
export interface AgyAuthorization {
  label:string;email:string;subscriptionType:string|null;
  secret:{kind:'oauth';accessToken:string;refreshToken:string;expiresAt:number;agy:{clientId:string;clientSecret:string;projectId:string;endpoint:"https://daily-cloudcode-pa.googleapis.com"}};
}
interface Pending {authorizeUrl?:string;config:AgyAppConfig;verifier:string;state:string;redirectUri:string;expiresAt:number;controller:AbortController;used:boolean;timer:ReturnType<typeof setTimeout>}
const TOKEN_URL='https://oauth2.googleapis.com/token';
const AUTHORIZE_URL='https://accounts.google.com/o/oauth2/v2/auth';
export const AGY_MANUAL_REDIRECT='https://antigravity.google/oauth-callback';
// Verified against the official CLI remote Google OAuth request.
const LOGIN_SCOPES=['cloud-platform','userinfo.email','userinfo.profile','cclog','experimentsandconfigs','aicode'].map(scope=>'https://www.googleapis.com/auth/'+scope).concat('openid');
const BOOTSTRAP_URL='https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
export const AGY_CONSUMER_ENDPOINT='https://daily-cloudcode-pa.googleapis.com';

export async function readNativeAgyConfig(archive=path.join(homedir(),'.local','lib','antigravity-acp','1.4.1','agy_acp_server.par')):Promise<AgyAppConfig> {
  try {
    const {stdout}=await promisify(execFile)('python3',[fileURLToPath(new URL('../scripts/agy-native-oauth-config.py',import.meta.url)),archive],{timeout:5000,maxBuffer:16384});
    const data=JSON.parse(stdout) as AgyAppConfig;
    if(typeof data.clientId!=='string'||!data.clientId.endsWith('.apps.googleusercontent.com')||typeof data.clientSecret!=='string'||!Array.isArray(data.scopes)||data.scopes.some(scope=>typeof scope!=='string'))throw Error('Invalid application defaults');
    return data;
  } catch {throw Error('Native Antigravity application configuration is unavailable on the pool server.');}
}

export async function raceAbort<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();
  let reject!:()=>void;
  const stopped=new Promise<never>((_,fail)=>{reject=()=>fail(Error('Authorization request canceled'));signal.addEventListener('abort',reject,{once:true});});
  try{return await Promise.race([promise,stopped]);}finally{signal.removeEventListener('abort',reject);}
}
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function managedProject(value:Record<string,unknown>):string|null {
  const raw=value.cloudaicompanionProject;
  const id=typeof raw==='string'?raw:object(raw)?raw.id:null;
  return typeof id==='string'&&id.trim()&&id.trim().length<=512?id.trim():null;
}
function eligibilityFailure(value:Record<string,unknown>):string {
  const tier=Array.isArray(value.ineligibleTiers)?value.ineligibleTiers.find(t=>object(t)&&t.tierId==='free-tier'):null;
  const code=object(tier)?tier.reasonCode:null;
  // Never expose arbitrary provider messages, URLs or identifiers.
  const reasons:Record<string,string>={
    UNSUPPORTED_LOCATION:'Google reports that personal Antigravity onboarding is unavailable in the current location',
    AGE_RESTRICTION:'Google reports an age restriction for personal Antigravity onboarding',
    VALIDATION_REQUIRED:'Google requires account verification before personal Antigravity onboarding',
  };
  return typeof code==='string'&&Object.hasOwn(reasons,code)?reasons[code]!:'Google returned no managed Antigravity project or eligible personal tier; the account was not added';
}
export async function readAgyJson(response:Response,signal:AbortSignal):Promise<Record<string,unknown>> {
  const reader=response.body?.getReader();if(!reader)throw Error('Invalid authorization response');
  try {
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const next=await raceAbort(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>1024*1024)throw Error('Authorization response exceeds limit');chunks.push(next.value);}
    const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
    const result:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!object(result))throw Error('Invalid authorization response');
    return result;
  } finally {void reader.cancel().catch(()=>undefined);}
}

/** Only explicit operator login calls this. Every upstream fetch is caller-supplied
 * so the hub's per-request network authorization remains mandatory. */
export class AgyOAuthLogin {
  private readonly sessions=new Map<string,Pending>();
  private starting=0;
  private disposed=false;
  constructor(private readonly options:{fetch:typeof fetch;appConfig:()=>Promise<AgyAppConfig>;onModels?:(ids:string[])=>Promise<void>;now?:()=>number}){}
  private now(){return this.options.now?.()??Date.now();}
  async start(){
    if(this.disposed)throw Error('Authorization service stopped');
    if(this.sessions.size+this.starting>=8)throw Error('Too many pending authorization sessions');
    this.starting++;
    let config:AgyAppConfig;
    try{config=await this.options.appConfig();}finally{this.starting--;}
    if(this.disposed)throw Error('Authorization service stopped');
    const sessionId=randomBytes(24).toString('base64url');const verifier=randomBytes(48).toString('base64url');
    const state=randomBytes(24).toString('base64url');const redirectUri=AGY_MANUAL_REDIRECT;
    const expiresAt=this.now()+600000;const controller=new AbortController();
    const timer=setTimeout(()=>this.cancel(sessionId),600000);timer.unref();
    this.sessions.set(sessionId,{config,verifier,state,redirectUri,expiresAt,controller,used:false,timer});
    const url=new URL(AUTHORIZE_URL);url.search=new URLSearchParams({client_id:config.clientId,redirect_uri:redirectUri,response_type:'code',scope:LOGIN_SCOPES.join(' '),access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
    this.sessions.get(sessionId)!.authorizeUrl=url.toString();
    return {sessionId,authorizeUrl:url.toString(),expiresAt};
  }
  authorizationUrl(id:string):string {
    const session=this.sessions.get(id);
    if(!session||session.used||this.now()>=session.expiresAt||!session.authorizeUrl)throw Error('Authorization session expired or already used');
    return session.authorizeUrl;
  }
  cancel(id:string){const session=this.sessions.get(id);if(!session)return;this.sessions.delete(id);clearTimeout(session.timer);session.controller.abort();}
  dispose(){this.disposed=true;for(const id of this.sessions.keys())this.cancel(id);}
  async complete(id:string,input:string):Promise<AgyAuthorization>{
    const session=this.sessions.get(id);
    if(!session||session.used||this.now()>=session.expiresAt)throw Error('Authorization session expired or already used');
    let code=input.trim();
    if(code.length>16384)throw Error('Invalid authorization code');
    if(/^https?:/i.test(code)){
      let url:URL;try{url=new URL(code);}catch{throw Error('Invalid authorization callback');}
      const expected=new URL(session.redirectUri);
      if(url.origin!==expected.origin||url.pathname!==expected.pathname||url.username||url.password||url.hash||url.searchParams.getAll('state').length!==1||url.searchParams.get('state')!==session.state||url.searchParams.getAll('code').length!==1)throw Error('Authorization callback does not match this session');
      code=url.searchParams.get('code')??'';
    }
    if(!code||/[\x00-\x20]/.test(code))throw Error('Invalid authorization code');
    session.used=true;
    const request=async(url:string,init:RequestInit={})=>{
      const signal=AbortSignal.any([session.controller.signal,AbortSignal.timeout(15000)]);
      signal.throwIfAborted();
      const pending=this.options.fetch(url,{...init,signal,redirect:'error'});
      let response:Response;
      try{response=await raceAbort(pending,signal);}catch{void pending.then(late=>late.body?.cancel()).catch(()=>undefined);throw Error('Google authorization request could not complete');}
      if(!response.ok){void response.body?.cancel().catch(()=>undefined);throw Error(`Google authorization refused (HTTP ${response.status})`);}
      try{return await readAgyJson(response,signal);}catch{throw Error('Invalid Google authorization response');}
    };
    try {
      const token=await request(TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:session.config.clientId,client_secret:session.config.clientSecret,code_verifier:session.verifier,code,redirect_uri:session.redirectUri})});
      if(typeof token.access_token!=='string'||!token.access_token||typeof token.refresh_token!=='string'||!token.refresh_token||typeof token.expires_in!=='number'||!Number.isSafeInteger(token.expires_in)||token.expires_in<1||token.expires_in>86400)throw Error('Google did not return renewable authorization');
      const headers={authorization:`Bearer ${token.access_token}`,'content-type':'application/json'};
      const identity=await request('https://www.googleapis.com/oauth2/v2/userinfo',{headers});
      if(typeof identity.email!=='string'||identity.email.length>320||!identity.email.includes('@'))throw Error('Google account identity unavailable');
      const load={method:'POST',headers,body:JSON.stringify({metadata:{ideType:'ANTIGRAVITY'}})};
      let subscription=await request(BOOTSTRAP_URL,load);
      const personal=(value:Record<string,unknown>)=>{
        if(value.gcpManaged===true||[value.paidTier,value.currentTier].some(t=>object(t)&&t.usesGcpTos===true))throw Error('This login supports personal Antigravity subscriptions; enterprise authorization is not configured');
      };
      personal(subscription);
      const initialSubscription=subscription;
      if(!managedProject(subscription)){
        // An existing personal registration may already be visible on Daily.
        subscription=await request(AGY_CONSUMER_ENDPOINT+'/v1internal:loadCodeAssist',load);
        personal(subscription);
      }
      if(!managedProject(subscription)){
        // Match native ACP onboarding; never infer eligibility from a missing project.
        const eligible=(value:Record<string,unknown>)=>Array.isArray(value.allowedTiers)&&value.allowedTiers.some(t=>object(t)&&t.id==='free-tier'&&t.usesGcpTos!==true&&t.userDefinedCloudaicompanionProject!==true);
        if(!eligible(initialSubscription)&&!eligible(subscription))throw Error(eligibilityFailure(subscription));
        let operation=await request(AGY_CONSUMER_ENDPOINT+'/v1internal:onboardUser',{method:'POST',headers,body:JSON.stringify({tierId:'free-tier',metadata:{ideType:'ANTIGRAVITY'}})});
        for(let poll=0;operation.done!==true&&poll<30;poll++){
          if(operation.error)throw Error('Antigravity onboarding failed');
          const name=operation.name;
          if(typeof name!=='string'||name.length>512||!/^operations\/[A-Za-z0-9_-]+$/.test(name))throw Error('Invalid Antigravity onboarding operation');
          await delay(1000,undefined,{signal:session.controller.signal});
          operation=await request(AGY_CONSUMER_ENDPOINT+'/v1internal/'+name,{headers});
        }
        if(operation.error)throw Error('Antigravity onboarding failed');
        if(operation.done!==true)throw Error('Antigravity onboarding did not finish within the allowed wait');
        subscription=await request(AGY_CONSUMER_ENDPOINT+'/v1internal:loadCodeAssist',load);
        personal(subscription);
      }
      const project=managedProject(subscription);
      if(typeof project!=='string'||!project.trim()||project.length>512)throw Error('Google did not return a valid Antigravity project after onboarding');
      const tier=object(subscription.paidTier)?subscription.paidTier:object(subscription.currentTier)?subscription.currentTier:null;
      if(tier?.usesGcpTos===true||subscription.gcpManaged===true)throw Error('This login supports personal Antigravity subscriptions; enterprise authorization is not configured');
      if(this.options.onModels){
        const catalog=await request(AGY_CONSUMER_ENDPOINT+'/v1internal:fetchAvailableModels',{method:'POST',headers,body:JSON.stringify({project})});
        await this.options.onModels(agyModelIds(catalog));
      }
      session.controller.signal.throwIfAborted();
      return {label:identity.email,email:identity.email,subscriptionType:typeof tier?.id==='string'?tier.id:null,secret:{kind:'oauth',accessToken:token.access_token,refreshToken:token.refresh_token,expiresAt:this.now()+token.expires_in*1000,agy:{clientId:session.config.clientId,clientSecret:session.config.clientSecret,projectId:project,endpoint:AGY_CONSUMER_ENDPOINT}}};
    } finally {this.cancel(id);}
  }
}
