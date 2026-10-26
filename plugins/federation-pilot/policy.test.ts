import assert from 'node:assert/strict';
import {classifyRequest,routingIds} from './policy.ts';
const i={projectId:'proj_remote',threads:new Set(['thr_remote']),hosts:new Set(['host_remote']),environments:new Set(['env_remote'])};
const test=(name:string,fn:()=>void)=>{fn();console.log('PASS',name);};
test('mixed nested machine rejected',()=>assert.equal(classifyRequest('POST','/api/v1/threads',{projectId:'proj_remote',environmentSelection:{machine:{type:'existing',hostId:'host_primary'}}},i,true).ok,false));
test('foreign parent rejected',()=>assert.equal(classifyRequest('POST','/api/v1/threads',{projectId:'proj_remote',parentThreadId:'thr_primary'},i,true).ok,false));
test('new remote thread allowed',()=>assert.equal(classifyRequest('POST','/api/v1/threads',{projectId:'proj_remote',parentThreadId:'thr_remote',environmentSelection:{machine:{type:'existing',hostId:'host_remote'}}},i,true).ok,true));
test('read only refuses all mutations',()=>assert.equal(classifyRequest('POST','/api/v1/threads/thr_remote/send',{input:[]},i,false).ok,false));
test('ordinary remote approval supported',()=>assert.equal(classifyRequest('POST','/api/v1/threads/thr_remote/interactions/pint_one/resolve',{decision:'allow_once'},i,true).ok,true));
test('unscoped settings cannot leave primary',()=>assert.equal(classifyRequest('GET','/api/v1/system/execution-options',null,i,true).ok,false));
test('remote host model settings allowed',()=>assert.equal(classifyRequest('GET','/api/v1/system/execution-options?hostId=host_remote',null,i,true).ok,true));
test('project plus wrong host refused',()=>assert.equal(classifyRequest('GET','/api/v1/system/environment-providers?projectId=proj_remote&hostId=host_primary',null,i,true).ok,false));
test('path traversal refused',()=>assert.equal(classifyRequest('GET','/api/v1/projects/proj_remote/../../system/config',null,i,true).ok,false));
test('encoded separators refused',()=>assert.equal(classifyRequest('GET','/api/v1/threads/thr_remote%2f..%2fconfig',null,i,true).ok,false));
test('plugin RPC refused',()=>assert.equal(classifyRequest('POST','/api/v1/plugins/anything/rpc/run',{threadId:'thr_remote'},i,true).ok,false));
test('routing does not inspect prompt text',()=>assert.deepEqual(routingIds('/api/v1/threads',{projectId:'proj_remote',input:[{type:'text',text:'host_primary'}]}),['proj_remote']));

test('native new machine refused',()=>assert.equal(classifyRequest('POST','/api/v1/threads',{projectId:'proj_remote',environment:{type:'provider',machine:{type:'new'}}},i,true).ok,false));
test('local section refused',()=>assert.equal(classifyRequest('POST','/api/v1/threads',{projectId:'proj_remote',sectionId:'section_local'},i,true).ok,false));

const primaryMention={type:'text',text:'See @local',mentions:[{start:4,end:10,resource:{kind:'thread',threadId:'thr_primary',projectId:'proj_primary',label:'Local'}}]};
test('send references are content, only destination belongs to inventory',()=>{
 const body={input:[primaryMention],mode:'queue-if-active'};
 assert.deepEqual(routingIds('/api/v1/threads/thr_remote/send',body),['thr_remote']);
 assert.equal(classifyRequest('POST','/api/v1/threads/thr_remote/send',body,i,true).ok,true);
});
test('create preserves local reference but still rejects a local machine or parent',()=>{
 const body={projectId:'proj_remote',input:[primaryMention],environment:{type:'existing',environmentId:'env_remote'}};
 assert.equal(classifyRequest('POST','/api/v1/threads',body,i,true).ok,true);
 assert.equal(classifyRequest('POST','/api/v1/threads',{...body,parentThreadId:'thr_primary'},i,true).ok,false);
 assert.equal(classifyRequest('POST','/api/v1/threads',{...body,environment:{type:'provider',machine:{type:'existing',hostId:'host_primary'}}},i,true).ok,false);
});
test('queue and edit use destination, not mentioned project',()=>{
 for(const action of ['queued-messages','edit-message'])assert.equal(classifyRequest('POST',`/api/v1/threads/thr_remote/${action}`,{input:[primaryMention]},i,true).ok,true);
});
