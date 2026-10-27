import {expect,it} from 'vitest';
import {createAgyAdapter} from './agy-adapter.js';
import {accountPoolConfigSchema,type Account,type AccountSecret} from './contracts.js';
import type {AdapterSecretContext} from './provider-adapter.js';
import {AccountAuthorizationRequiredError,TransientOAuthRefreshError} from './provider-adapter.js';
const adapter=createAgyAdapter();
const secret:AccountSecret={kind:'oauth',accessToken:'synthetic-google-access',refreshToken:'synthetic-google-refresh',expiresAt:1,
 agy:{clientId:'synthetic-app',clientSecret:'synthetic-app-secret',projectId:'synthetic-project',endpoint:'https://daily-cloudcode-pa.googleapis.com'}};
function context(mock:typeof fetch):AdapterSecretContext{return {secret,account:{} as Account,accounts:{} as AdapterSecretContext['accounts'],quotas:{} as AdapterSecretContext['quotas'],fetch:mock,now:()=>1800000000000,forceRefresh:true};}
it('maps native paths to exact guarded upstream POSTs, dropping client query/auth headers',()=>{
 const request=new Request('https://pool.example/agy/v1beta/models/native-model:streamGenerateContent?key=synthetic-client-key');
 expect(adapter.upstreamUrl(request,accountPoolConfigSchema.parse({})).toString()).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
 expect(adapter.upstreamMethod!(request)).toBe('POST');
 const headers=adapter.requestHeaders(new Headers({authorization:'Bearer synthetic-pool-token','x-private':'synthetic-client-data'}),{} as Account,secret);
 expect(Object.fromEntries(headers)).toEqual({'authorization':'Bearer synthetic-google-access','content-type':'application/json'});
});
it('refreshes only server-side Google credentials and preserves project/application authority',async()=>{
 const requests:Request[]=[];
 const result=await adapter.refreshSecret(context(async(input,init)=>{requests.push(new Request(input,init));return Response.json({access_token:'synthetic-new-access',expires_in:3600});}));
 expect(result.secret).toMatchObject({kind:'oauth',accessToken:'synthetic-new-access',refreshToken:'synthetic-google-refresh',agy:secret.kind==='oauth'?secret.agy:undefined});
 expect(requests[0]!.url).toBe('https://oauth2.googleapis.com/token');expect(requests[0]!.redirect).toBe('error');
});
it('rejects missing project binding and malformed refresh; does not retain Google error bodies',async()=>{
 await expect(adapter.refreshSecret({...context(async()=>{throw Error('No request allowed');}),secret:{kind:'api-key',apiKey:'synthetic'}})).rejects.toBeInstanceOf(AccountAuthorizationRequiredError);
 for(const value of [{access_token:'synthetic',expires_in:true},{access_token:'synthetic',expires_in:1.5},{access_token:'',expires_in:3600}])await expect(adapter.refreshSecret(context(async()=>Response.json(value)))).rejects.toBeInstanceOf(TransientOAuthRefreshError);
 await expect(adapter.refreshSecret(context(async()=>Response.json({error:'synthetic-private-upstream-body'},{status:400})))).rejects.toThrow('HTTP 400');
});
