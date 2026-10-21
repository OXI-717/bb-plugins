import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({exec:vi.fn(),resolve:vi.fn(async()=>'/fixture/gh'),invalidate:vi.fn()}));
vi.mock('node:child_process',()=>({execFile:mocks.exec}));
vi.mock('../sources/github',()=>({resolveGhPath:mocks.resolve,invalidateGhPath:mocks.invalidate}));
import {makeRunner,cleanEnv} from './api';
beforeEach(()=>{vi.clearAllMocks();mocks.exec.mockReset();});
afterEach(()=>vi.restoreAllMocks());
function respond(error:Record<string,unknown>|null,stderr='',out=''){
 mocks.exec.mockImplementationOnce((_file,_args,_options,callback)=>callback(error,out,stderr));
}
it('retries a transient GET failure once with the same account environment',async()=>{
 respond({code:1},'error connecting to api.github.com: unexpected EOF');respond(null,'','[]');
 const env={...cleanEnv(),GH_TOKEN:'synthetic-request-account'};
 expect(await makeRunner()(['api','repos/example/project/issues'],env)).toBe('[]');
 expect(mocks.exec).toHaveBeenCalledTimes(2);
 expect(mocks.exec.mock.calls.map(c=>c[2].env.GH_TOKEN)).toEqual(['synthetic-request-account','synthetic-request-account']);
});
it.each([
 [{code:1},'gh: Bad credentials (HTTP 401)','авторизац'],
 [{code:1},'gh: Resource not accessible by integration (HTTP 403)','403'],
 [{code:1},'gh: Not Found (HTTP 404)','404'],
 [{code:1},'GraphQL: Resource not accessible by personal access token','403'],
 [{code:1},'GraphQL: Your token has not been granted the required scopes to execute this query','403'],
 [{code:1},'GraphQL: Could not resolve to a Repository with the name example/project','404'],
 [{code:1},'gh: API rate limit exceeded (HTTP 403)','лимит'],
 [{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'},'','объём'],
 [{code:'ABORT_ERR'},'','отменён'],
 [{code:null,killed:true,signal:'SIGTERM'},'','время'],
])('classifies %j safely without a blind retry',async(error,stderr,message)=>{
 respond(error,stderr+' sensitive-response https://user:secret@example.invalid');
 const task=makeRunner()(['api','repos/example/project/issues'],cleanEnv());
 await expect(task).rejects.toThrow(message);await expect(task).rejects.not.toThrow('sensitive-response');
 expect(mocks.exec).toHaveBeenCalledTimes(1);
});
it.each([
 ['issue','create','-R','example/project'],
 ['api','repos/example/project/issues','-X','POST'],
 ['api','repos/example/project/issues','--method=PATCH'],
 ['api','repos/example/project/issues','-f','title=changed'],
 ['api','repos/example/project/issues','--input','-'],
 ['api','graphql','-f','query=mutation { change }'],
])('never retries an executed write or ambiguous command %j',async(...args)=>{
 respond({code:1},'HTTP 503 unexpected EOF');
 await expect(makeRunner()(args,cleanEnv())).rejects.toThrow();expect(mocks.exec).toHaveBeenCalledTimes(1);
});
it('stops after the second transient failure and reports a network error without raw output',async()=>{
 respond({code:1},'dial tcp: no such host synthetic-secret');respond({code:1},'dial tcp: no such host synthetic-secret');
 const task=makeRunner()(['api','repos/example/project/issues'],cleanEnv());
 await expect(task).rejects.toThrow('соединени');await expect(task).rejects.not.toThrow('synthetic-secret');expect(mocks.exec).toHaveBeenCalledTimes(2);
});
it('keeps both attempts inside the original deadline',async()=>{
 let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now);
 mocks.exec.mockImplementationOnce((_file,_args,_options,callback)=>{now+=700;callback({code:1},'','unexpected EOF');});
 respond(null,'','[]');
 expect(await makeRunner()(['api','repos/example/project/issues'],cleanEnv(),2000)).toBe('[]');
 expect(mocks.exec.mock.calls.map(c=>c[2].timeout)).toEqual([2000,1300]);
});
it('does not retry when the original deadline is nearly exhausted',async()=>{
 let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now);
 mocks.exec.mockImplementationOnce((_file,_args,_options,callback)=>{now+=1900;callback({code:1},'','unexpected EOF');});
 await expect(makeRunner()(['api','repos/example/project/issues'],cleanEnv(),2000)).rejects.toThrow('соединени');
 expect(mocks.exec).toHaveBeenCalledTimes(1);
});
it('cancels the wait between attempts when the plugin is disposed',async()=>{
 const controller=new AbortController();respond({code:1},'unexpected EOF');
 const task=makeRunner(controller.signal)(['api','repos/example/project/issues'],cleanEnv());
 setTimeout(()=>controller.abort(),10);
 await expect(task).rejects.toThrow('отменён');expect(mocks.exec).toHaveBeenCalledTimes(1);
});
it('lets the page traversal own retries without nesting additional REST retries',async()=>{
 respond({code:1},'unexpected EOF');
 await expect(makeRunner()(['api','repos/example/project/issues'],cleanEnv(),20000,{retryRead:false})).rejects.toMatchObject({kind:'network'});
 expect(mocks.exec).toHaveBeenCalledTimes(1);
});
it('does not start a process after disposal',async()=>{
 const controller=new AbortController();controller.abort();
 await expect(makeRunner(controller.signal)(['api','repos/example/project/issues'],cleanEnv())).rejects.toMatchObject({kind:'cancelled'});
 expect(mocks.exec).not.toHaveBeenCalled();
});
