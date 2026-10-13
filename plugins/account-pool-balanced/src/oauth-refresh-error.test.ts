import {expect,it} from 'vitest';
import {fetchOAuthRefresh,OAuthRefreshRejectedError,TransientOAuthRefreshError} from './provider-adapter.js';
it('keeps only an allowlisted OAuth reason and never includes provider secrets',async()=>{
 const context={now:()=>Date.now(),fetch:(async()=>Response.json({error:'invalid_grant',error_description:'sensitive bearer fixture-token'},{status:400})) as typeof fetch};
 let error:unknown;try{await fetchOAuthRefresh(context,'https://fixture.test',{});}catch(e){error=e;}
 expect(error).toBeInstanceOf(OAuthRefreshRejectedError);
 expect(error).toMatchObject({oauthCode:'invalid_grant',status:400});
 expect(String(error)).not.toContain('fixture-token');
});
it.each([403,408,429,500,503])('keeps HTTP %s as a transient refresh failure rather than requiring reauthorization',async status=>{
 const context={now:()=>Date.now(),fetch:(async()=>Response.json({error:'invalid_grant'},{status})) as typeof fetch};
 await expect(fetchOAuthRefresh(context,'https://fixture.test',{})).rejects.toBeInstanceOf(TransientOAuthRefreshError);
});
it('discards oversized or unrecognized OAuth responses',async()=>{
 for(const body of [{error:'untrusted-secret-value'},{error:'invalid_grant',description:'x'.repeat(8192)}]){
  const context={now:()=>Date.now(),fetch:(async()=>Response.json(body,{status:400})) as typeof fetch};
  await expect(fetchOAuthRefresh(context,'https://fixture.test',{})).rejects.toMatchObject({oauthCode:null});
 }
});
it('does not invent invalid_grant from a plain HTTP 400',async()=>{
 const context={now:()=>Date.now(),fetch:(async()=>new Response('not-json',{status:400})) as typeof fetch};
 await expect(fetchOAuthRefresh(context,'https://fixture.test',{})).rejects.toMatchObject({oauthCode:null,status:400});
});
