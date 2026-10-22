import {afterEach,expect,it,vi} from 'vitest';
import {readIssuePages} from './issue-pages';
import {GithubCliError} from './cli-failure';
const issue=(number:number)=>({number,title:`Issue ${number}`,body:null,state:'OPEN',author:null,updatedAt:'2026-10-21T10:00:00Z',url:`https://github.com/example/project/issues/${number}`,labels:{nodes:[{name:'bug'}],pageInfo:{hasNextPage:false}},assignees:{nodes:[{login:'example-user'}],pageInfo:{hasNextPage:false}}});
const page=(numbers:number[],next:string|null=null)=>JSON.stringify({data:{repository:{issues:{nodes:numbers.map(issue),pageInfo:{hasNextPage:next!==null,endCursor:next}}}}});
afterEach(()=>vi.restoreAllMocks());
it('traverses issue-only cursors and converts complete metadata without requesting REST PR pages',async()=>{
 const gh=vi.fn().mockResolvedValueOnce(page([1,2],'cursor-one')).mockResolvedValueOnce(page([3]));
 const rows=await readIssuePages(gh,'example/project','all',Date.now()+120000);
 expect(rows.map(r=>r.number)).toEqual([1,2,3]);
 expect(rows[0]).toMatchObject({body:null,user:null,labels:[{name:'bug'}],assignees:[{login:'example-user'}],updated_at:'2026-10-21T10:00:00Z'});
 expect(gh.mock.calls[0][0].slice(0,2)).toEqual(['api','graphql']);
 expect(gh.mock.calls[0][0].join(' ')).toContain('states:[OPEN,CLOSED]');
 expect(gh.mock.calls[1][0]).toContain('after=cursor-one');
 expect(gh.mock.calls.every(c=>c[1]<=20000&&c[2].retryRead===false)).toBe(true);
});
it('retries only the failed read page and discards nothing from preceding complete pages',async()=>{
 const gh=vi.fn().mockResolvedValueOnce(page([1],'next')).mockRejectedValueOnce(new GithubCliError('timeout',null)).mockResolvedValueOnce(page([2]));
 expect((await readIssuePages(gh,'example/project','open')).map(r=>r.number)).toEqual([1,2]);
 expect(gh).toHaveBeenCalledTimes(3);expect(gh.mock.calls[1][0]).toEqual(gh.mock.calls[2][0]);
});
it.each(['authentication','forbidden','not_found','rate_limit','cancelled','unknown'] as const)('does not retry or fallback after %s',async kind=>{
 const gh=vi.fn().mockResolvedValueOnce(page([1],'next')).mockRejectedValueOnce(new GithubCliError(kind,null));
 await expect(readIssuePages(gh,'example/project','all')).rejects.toMatchObject({kind});expect(gh).toHaveBeenCalledTimes(2);
});
it.each([
 {data:{repository:{issues:{nodes:[],pageInfo:{hasNextPage:true,endCursor:null}}}}},
 {data:{repository:null}},
 {data:{repository:{issues:{nodes:[issue(1)],pageInfo:{hasNextPage:false,endCursor:null}}}},errors:[{message:'synthetic private detail'}]},
 {data:{repository:{issues:{nodes:[{number:1}],pageInfo:{hasNextPage:false,endCursor:null}}}}},
])('rejects malformed or partial envelopes instead of returning an empty success',async body=>{
 await expect(readIssuePages(vi.fn(async()=>JSON.stringify(body)),'example/project','all')).rejects.toThrow();
});
it('detects a repeated cursor instead of looping until timeout',async()=>{
 const gh=vi.fn(async()=>page([1],'same'));
 await expect(readIssuePages(gh,'example/project','all')).rejects.toThrow();expect(gh).toHaveBeenCalledTimes(2);
});
it('falls back to a complete REST traversal for metadata overflow, preserving the same deadline',async()=>{
 const first=issue(1);first.labels.pageInfo.hasNextPage=true;
 const gh=vi.fn().mockResolvedValueOnce(JSON.stringify({data:{repository:{issues:{nodes:[first],pageInfo:{hasNextPage:false,endCursor:null}}}}}));
 const fallback=vi.fn(async()=>[{number:10}]);const deadline=Date.now()+120000;
 expect(await readIssuePages(gh,'example/project','all',deadline,fallback)).toEqual([{number:10}]);
 expect(fallback).toHaveBeenCalledWith(gh,'example/project','all','issue',deadline);
});
it('keeps the original traversal deadline across pages',async()=>{
 let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now);
 const gh=vi.fn().mockImplementationOnce(async()=>{now+=115000;return page([1],'next');}).mockResolvedValueOnce(page([2]));
 await readIssuePages(gh,'example/project','all',121000);expect(gh.mock.calls.map(c=>c[1])).toEqual([20000,5000]);
});
it('returns no prefix when a second page exhausts both attempts',async()=>{
 const gh=vi.fn().mockResolvedValueOnce(page([1],'next')).mockRejectedValue(new GithubCliError('network',null));
 await expect(readIssuePages(gh,'example/project','all')).rejects.toMatchObject({kind:'network'});expect(gh).toHaveBeenCalledTimes(3);
});
it('returns a successful empty result only for an error-free terminal connection',async()=>{
 expect(await readIssuePages(vi.fn(async()=>page([])),'example/project','closed')).toEqual([]);
});
it('enforces the cumulative response budget without returning an earlier page prefix',async()=>{
 const original=Buffer.byteLength;
 vi.spyOn(Buffer,'byteLength').mockImplementation((value,encoding)=>typeof value==='string'&&value.startsWith('{"data"')?40*1024*1024:original(value,encoding));
 const gh=vi.fn().mockResolvedValueOnce(page([1],'next')).mockResolvedValueOnce(page([2]));
 await expect(readIssuePages(gh,'example/project','all')).rejects.toMatchObject({kind:'response_too_large'});expect(gh).toHaveBeenCalledTimes(2);
});
it('does not start a request after the repository deadline',async()=>{
 const gh=vi.fn();
 await expect(readIssuePages(gh,'example/project','all',Date.now()-1)).rejects.toMatchObject({kind:'timeout'});expect(gh).not.toHaveBeenCalled();
});
it('discards already downloaded GraphQL pages when later metadata requires the REST fallback',async()=>{
 const row=issue(2);row.assignees.pageInfo.hasNextPage=true;
 const gh=vi.fn().mockResolvedValueOnce(page([1],'next')).mockResolvedValueOnce(JSON.stringify({data:{repository:{issues:{nodes:[row],pageInfo:{hasNextPage:false,endCursor:null}}}}}));
 const fallback=vi.fn(async()=>[{number:10}]);
 expect(await readIssuePages(gh,'example/project','all',Date.now()+120000,fallback)).toEqual([{number:10}]);
});
