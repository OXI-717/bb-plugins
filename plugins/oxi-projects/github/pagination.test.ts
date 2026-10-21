import {afterEach,expect,it,vi} from 'vitest';
import {readRepositoryPages,listProject} from './api';
import {GithubCliError} from './cli-failure';
const row=(n:number,pr=false)=>({number:n,title:`Task ${n}`,state:'open',user:null,labels:[],assignees:[],updated_at:'2026-10-15T10:00:00Z',html_url:`https://github.com/example/project/issues/${n}`,body:'Body',...(pr?{pull_request:{}}:{})});
afterEach(()=>vi.restoreAllMocks());
it('recovers the failed page without downloading earlier pages again',async()=>{
 const gh=vi.fn().mockResolvedValueOnce(JSON.stringify(Array.from({length:100},(_,i)=>row(i+1)))).mockRejectedValueOnce(new GithubCliError('timeout',null)).mockResolvedValueOnce(JSON.stringify([row(101)]));
 const result=await readRepositoryPages(gh,'example/project','all','issue');
 expect(result).toHaveLength(101);
 expect(gh.mock.calls.map(c=>c[0][1])).toEqual(['repos/example/project/issues?state=all&per_page=100&page=1','repos/example/project/issues?state=all&per_page=100&page=2','repos/example/project/issues?state=all&per_page=100&page=2']);
 expect(gh.mock.calls.every(c=>c[1]<=20000&&c[2].retryRead===false)).toBe(true);
});
it('does not mistake a full page of PRs for the end of the issue list',async()=>{
 const gh=vi.fn().mockResolvedValueOnce(JSON.stringify(Array.from({length:100},(_,i)=>row(i+1,true)))).mockResolvedValueOnce(JSON.stringify([row(101)]));
 expect((await readRepositoryPages(gh,'example/project','all','issue')).map(r=>r.number)).toEqual([101]);
 expect(gh).toHaveBeenCalledTimes(2);
});
it.each(['authentication','forbidden','not_found','rate_limit','cancelled','unknown'] as const)('does not retry %s or return partial pages',async kind=>{
 const gh=vi.fn().mockResolvedValueOnce(JSON.stringify(Array.from({length:100},(_,i)=>row(i+1)))).mockRejectedValueOnce(new GithubCliError(kind,null));
 await expect(readRepositoryPages(gh,'example/project','all','issue')).rejects.toMatchObject({kind});expect(gh).toHaveBeenCalledTimes(2);
});
it('fails instead of returning an incomplete list after two page failures',async()=>{
 const gh=vi.fn().mockResolvedValueOnce(JSON.stringify(Array.from({length:100},(_,i)=>row(i+1)))).mockRejectedValue(new GithubCliError('timeout',null));
 await expect(readRepositoryPages(gh,'example/project','all','issue')).rejects.toMatchObject({kind:'timeout'});expect(gh).toHaveBeenCalledTimes(3);
});
it('keeps the original whole-list deadline and reduces the last page attempt budget',async()=>{
 let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now);
 const gh=vi.fn().mockImplementationOnce(async()=>{now+=115000;return JSON.stringify(Array.from({length:100},(_,i)=>row(i+1)));}).mockResolvedValueOnce('[]');
 await readRepositoryPages(gh,'example/project','all','issue');
 expect(gh.mock.calls.map(c=>c[1])).toEqual([20000,5000]);
});
it('rejects malformed pages instead of publishing partial data',async()=>{
 const gh=vi.fn().mockResolvedValueOnce(JSON.stringify(Array.from({length:100},(_,i)=>row(i+1)))).mockResolvedValueOnce('[{"number":101}]');
 await expect(readRepositoryPages(gh,'example/project','all','issue')).rejects.toThrow();expect(gh).toHaveBeenCalledTimes(2);
});
it('returns a successful empty result only for a successful empty traversal',async()=>{
 expect(await readRepositoryPages(vi.fn(async()=>'[]'),'example/project','all','issue')).toEqual([]);
});
it('does not publish a successful prefix at the repository boundary after a page times out',async()=>{
 let pageCalls=0;
 const runner=vi.fn(async(args:string[])=>{
  if(args[0]==='auth')return 'synthetic-local-lookup';
  if(++pageCalls===1)return JSON.stringify({data:{repository:{issues:{pageInfo:{hasNextPage:true,endCursor:'next'},nodes:Array.from({length:100},(_,i)=>({number:i+1,title:`Task ${i+1}`,body:'Body',state:'OPEN',author:null,updatedAt:'2026-10-15T10:00:00Z',url:`https://github.com/example/project/issues/${i+1}`,labels:{nodes:[],pageInfo:{hasNextPage:false}},assignees:{nodes:[],pageInfo:{hasNextPage:false}}}))}}}});
  throw new GithubCliError('timeout',null);
 });
 const result=await listProject({id:'example',name:'Example',bbProjectId:'p',autopilotProject:null,repositories:[{repo:'example/project',account:'example-account'}]},{projectId:'example',repos:[],account:null,kind:'issue',state:'all'},runner);
 expect(result.items).toEqual([]);expect(result.errors).toHaveLength(1);
 expect(result.errors[0]).toMatchObject({repo:'example/project',account:'example-account'});
 expect(result.errors[0]?.message).toContain('страница 2');
 expect(pageCalls).toBe(3);
});
it('keeps PR browsing on REST and uses the selected account without a global auth switch',async()=>{
 const calls:Array<{args:string[];token:string|undefined}>=[];
 const runner=vi.fn(async(args:string[],env:NodeJS.ProcessEnv)=>{
  calls.push({args,token:env.GH_TOKEN});
  if(args[0]==='auth')return 'synthetic-account-token';
  return JSON.stringify([row(42,true)]);
 });
 const result=await listProject({id:'example',name:'Example',bbProjectId:'p',autopilotProject:null,repositories:[{repo:'example/project',account:'example-account'}]},{projectId:'example',repos:[],account:null,kind:'pr',state:'all'},runner);
 expect(result.errors).toEqual([]);expect(result.items.map(i=>i.number)).toEqual([42]);
 expect(calls[0]?.args).toContain('example-account');
 expect(calls.filter(c=>c.args[0]==='api').every(c=>c.args[1].startsWith('repos/')&&c.token==='synthetic-account-token')).toBe(true);
 expect(calls.some(c=>c.args.includes('switch'))).toBe(false);
});
