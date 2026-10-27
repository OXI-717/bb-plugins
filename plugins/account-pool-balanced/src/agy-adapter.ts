import type {AccountSecret} from './contracts.js';
import {agyRoute,agyRequest,agyResponse} from './agy-wire.js';
import {AGY_CONSUMER_ENDPOINT,raceAbort,readAgyJson} from './agy-oauth-login.js';
import {AccountAuthorizationRequiredError,OAuthRefreshRejectedError,TransientOAuthRefreshError,oauthSecretDueForRefresh,type ProviderAdapter} from './provider-adapter.js';
import {VpnRequiredError} from './vpn-policy.js';
import {poolErrorResponse} from './pool-errors.js';

function bound(secret:AccountSecret){
  if(secret.kind!=='oauth'||!secret.agy||secret.agy.endpoint!==AGY_CONSUMER_ENDPOINT)
    throw new AccountAuthorizationRequiredError('Add this personal Antigravity subscription through Pooler login.');
  return secret as Extract<AccountSecret,{kind:'oauth'}>&{agy:NonNullable<Extract<AccountSecret,{kind:'oauth'}>['agy']>};
}
export function createAgyAdapter(onModels?:(ids:string[])=>Promise<void>):ProviderAdapter {
 return {
  provider:'agy',upstreamName:'Antigravity',
  async importAccount(){throw Error('Use Antigravity login in Pooler; local credentials are not imported.');},
  guardRequest(request,body){
   const route=agyRoute(new URL(request.url));
   try{
    if(!route||request.method!==(route.kind==='models'?'GET':'POST'))throw Error('Unsupported route');
    if(route.kind!=='models')agyRequest(route,body,'validation-only');
    return null;
   }catch{return poolErrorResponse('agy',400,'Expected supported native GenAI route and body.');}
  },
  parseRequest(_body,_headers,request){
   const route=request&&agyRoute(new URL(request.url));
   if(!route)throw Error('Missing native Antigravity route');
   return {model:route.kind==='models'?null:route.model,family:'other',affinityId:null,parentAffinityId:null,
    forAccount:(_account,secret)=>agyRequest(route,_body,bound(secret).agy.projectId)};
  },
  upstreamMethod(){return 'POST';},
  upstreamUrl(request){
   const route=agyRoute(new URL(request.url));if(!route)throw Error('Unsupported Antigravity route');
   return new URL('/v1internal:'+(route.kind==='models'?'fetchAvailableModels':route.kind==='stream'?'streamGenerateContent?alt=sse':'generateContent'),AGY_CONSUMER_ENDPOINT);
  },
  requestHeaders(_inbound,_account,secret){return new Headers({'content-type':'application/json',authorization:`Bearer ${bound(secret).accessToken}`});},
  transformResponse(request,response,signal){const route=agyRoute(new URL(request.url));if(!route)throw Error('Unsupported Antigravity response');return agyResponse(route,response,signal,onModels);},
  quotaFromHeaders(_id,_headers,previous){return previous;},
  isQuotaRejection(){return false;},
  async refreshSecret(context){
   const current=bound(context.secret);const due=oauthSecretDueForRefresh(context);
   if(!due)return {secret:current,refreshed:false};
   const signal=AbortSignal.timeout(15000);
   const pending=context.fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal,
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'refresh_token',refresh_token:current.refreshToken,client_id:current.agy.clientId,client_secret:current.agy.clientSecret})});
   try {
    const response=await raceAbort(pending,signal);
    if(!response.ok){void response.body?.cancel().catch(()=>undefined);
     if(response.status===400||response.status===401)throw new OAuthRefreshRejectedError(response.status,null);
     throw new TransientOAuthRefreshError(`Antigravity authorization unavailable (HTTP ${response.status}).`,0);
    }
    const value=await readAgyJson(response,signal);
    if(typeof value.access_token!=='string'||!value.access_token||typeof value.expires_in!=='number'||!Number.isSafeInteger(value.expires_in)||value.expires_in<1||value.expires_in>86400||('refresh_token' in value&&(typeof value.refresh_token!=='string'||!value.refresh_token)))throw Error('Malformed token response');
    return {secret:{...current,accessToken:value.access_token,expiresAt:context.now()+value.expires_in*1000,...(typeof value.refresh_token==='string'?{refreshToken:value.refresh_token}:{})},refreshed:true};
   }catch(error){
    if(error instanceof VpnRequiredError||error instanceof AccountAuthorizationRequiredError||error instanceof TransientOAuthRefreshError)throw error;
    throw new TransientOAuthRefreshError('Antigravity authorization request failed or timed out.',0);
   }finally{if(signal.aborted)void pending.then(response=>response.body?.cancel()).catch(()=>undefined);}
  },
  async refreshUsage(){/* No evidenced subscription-window contract. Keep unknown, do not infer headroom. */},
  errorResponse:(status,message,headers,request)=>poolErrorResponse('agy',status,message,headers,request),
 };
}
