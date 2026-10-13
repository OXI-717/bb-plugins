import type {PoolProvider} from './contracts.js';
export function defaultPoolErrorCode(status:number):string {
 if(status===401)return 'POOL_AUTH_REQUIRED';
 if(status===429)return 'POOL_RATE_LIMITED';
 if(status===499)return 'POOL_REQUEST_CANCELED';
 if(status>=500)return 'POOL_UPSTREAM_UNAVAILABLE';
 if(status===403)return 'POOL_ACCESS_DENIED';
 return 'POOL_REQUEST_REJECTED';
}
/** Only local Pooler errors are rendered here; upstream success/passthrough is unchanged. */
export function poolErrorResponse(provider:PoolProvider,status:number,message:string,init?:HeadersInit,request?:Request):Response {
 const headers=new Headers(init);
 const reason=headers.get('x-bb-pool-error')??defaultPoolErrorCode(status);
 headers.set('x-bb-pool-error',reason);
 const text=message.startsWith(reason+':')||message.startsWith('['+reason+']')?message:`[${reason}] ${message}`;
 if(provider==='cursor'){
  const code=status===401?'unauthenticated':status===403?'permission_denied':status===429?'resource_exhausted':status===499?'canceled':status>=500?'unavailable':'invalid_argument';
  const error={code,message:text};
  const contentType=request?.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if(contentType==='application/connect+proto'||contentType==='application/connect+json'){
   const payload=new TextEncoder().encode(JSON.stringify({error}));
   const frame=new Uint8Array(5+payload.length);frame[0]=2;new DataView(frame.buffer).setUint32(1,payload.length);frame.set(payload,5);
   headers.set('content-type',contentType);headers.set('x-bb-pool-http-status',String(status));
   return new Response(frame,{status:200,headers});
  }
  return Response.json(error,{status,headers});
 }
 const anthropic=provider==='claude'||provider==='kimi';
 const type=status===401?'authentication_error':status===429?'rate_limit_error':'api_error';
 return Response.json(anthropic?{type:'error',error:{type,code:reason,message:text}}:{error:{type,code:reason,message:text}},{status,headers});
}
