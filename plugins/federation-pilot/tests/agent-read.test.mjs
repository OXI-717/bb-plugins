import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentReads,OUTPUT_LIMIT} from '../agent-read.ts';
import {parseServers} from '../configuration.ts';
function fixture(){
 const server={serverId:'alpha',label:'Alpha',projectId:'proj_alpha',bridgeHostId:'host_bridge',sshTarget:'remote-alpha',remotePort:38886,allowWrites:true,allowAgentReads:false,enabled:true};
 const cfg={enabled:true,servers:[server]},calls=[],checks=[];
 let detail={id:'thr_alpha',projectId:'proj_alpha',title:'Saved thread',status:'idle'};
 let events=[{threadId:'thr_alpha',seq:1,type:'user.message',data:{text:'Saved message'}},{threadId:'thr_alpha',seq:2,type:'agent.message',data:{text:'Saved answer'}}];
 let hook=()=>{},collision=null;
 const reads=createAgentReads({configurations:async()=>structuredClone(cfg),exclusive:async(c,ids)=>{checks.push(ids);if(collision&&ids.includes(collision))throw Error('collision');},get:async(c,path)=>{calls.push(path);await hook(path);const u=new URL(path,'http://remote.invalid');if(u.pathname==='/api/v1/threads')return [detail];if(u.pathname.endsWith('/events'))return events.filter(e=>e.seq>Number(u.searchParams.get('afterSeq'))).slice(0,Number(u.searchParams.get('limit')));return detail;}});
 return {reads,cfg,server,calls,checks,enable(){server.allowAgentReads=true;server.allowWrites=false;},events(v){events=v},detail(v){detail=v},hook(v){hook=v},collision(v){collision=v}};
}
const scope={serverId:'alpha',projectId:'proj_alpha'},target={...scope,threadId:'thr_alpha'};
test('agent reads default off even with broad writes; discovery is safe and separate',async()=>{
 const h=fixture();assert.deepEqual(await h.reads.servers(),{servers:[]});await assert.rejects(h.reads.read(target),/not enabled/);assert.equal(h.calls.length,0);
 const {allowAgentReads,...oldServer}=h.server;
 assert.equal(parseServers(JSON.stringify([oldServer]),{})[0].allowAgentReads,false);
 assert.equal(parseServers('',oldServer)[0].allowAgentReads,false);
 h.enable();const servers=await h.reads.servers();assert.deepEqual(servers.servers[0],{...scope,label:'Alpha',permissions:['list','read']});assert.ok(!JSON.stringify(servers).includes('remote-alpha'));
 assert.equal((await h.reads.read(target)).events.length,2);assert.ok(h.calls.every(p=>p.startsWith('/api/v1/threads/')));
 h.calls.length=0;h.cfg.enabled=false;assert.deepEqual(await h.reads.servers(),{servers:[]});await assert.rejects(h.reads.list(scope));assert.equal(h.calls.length,0);
});
test('wrong or implicit scope, arbitrary paths, invalid page limits and personal project are refused before upstream',async()=>{
 const h=fixture();h.enable();
 for(const args of [{projectId:'proj_alpha',threadId:'thr_alpha'},{...target,serverId:'beta'},{...target,projectId:'proj_wrong'},{...target,projectId:'proj_personal'},{...target,path:'/send'},{...target,limit:101},{...target,afterSeq:-1}])await assert.rejects(h.reads.read(args));
 assert.equal(h.calls.length,0);
});
test('primary/other ownership failure and project moves never expose events',async()=>{
 const h=fixture();h.enable();h.collision('thr_alpha');await assert.rejects(h.reads.read(target));assert.equal(h.calls.length,0);
 h.collision(null);h.detail({id:'thr_alpha',projectId:'proj_other'});await assert.rejects(h.reads.read(target),/outside/);assert.ok(!h.calls.some(p=>p.includes('/events')));
 h.detail({id:'thr_alpha',projectId:'proj_alpha'});h.hook(path=>{if(path.includes('/events'))h.detail({id:'thr_alpha',projectId:'proj_other'});});await assert.rejects(h.reads.read(target),/outside/);
});
test('revocation, connection changes, cancellation and upstream errors stop the read without fallback',async()=>{
 for(const kind of ['revoke','connection','cancel','offline']){
  const h=fixture();h.enable();const abort=new AbortController();h.hook(()=>{if(kind==='revoke')h.server.allowAgentReads=false;if(kind==='connection')h.server.sshTarget='changed';if(kind==='cancel')abort.abort();if(kind==='offline')throw Error('offline');});
  await assert.rejects(h.reads.read(target,abort.signal));assert.equal(h.calls.length,1);
 }
});
test('bounded event pages preserve sequences and never silently skip oversized events',async()=>{
 const h=fixture();h.enable();const first=await h.reads.read({...target,limit:1});assert.equal(first.nextAfterSeq,1);assert.equal(first.mayHaveMore,true);
 const second=await h.reads.read({...target,afterSeq:first.nextAfterSeq,limit:1});assert.equal(second.events[0].seq,2);
 h.events([{threadId:'thr_alpha',seq:1,data:{text:'x'.repeat(OUTPUT_LIMIT)}}]);await assert.rejects(h.reads.read(target),/One event exceeds/);
 h.events([{threadId:'thr_alpha',seq:1,data:{text:'a'.repeat(150000)}},{threadId:'thr_alpha',seq:2,data:{text:'b'.repeat(150000)}}]);
 const page=await h.reads.read(target);assert.equal(page.events.length,1);assert.equal(page.nextAfterSeq,1);assert.equal(page.mayHaveMore,true);assert.ok(Buffer.byteLength(JSON.stringify(page))<=OUTPUT_LIMIT);
 h.events([{threadId:'thr_other',seq:1}]);await assert.rejects(h.reads.read(target),/identity/);
});
test('list is project bounded and primary collisions fail closed',async()=>{
 const h=fixture();h.enable();const list=await h.reads.list({...scope,limit:1,archived:true});assert.equal(list.threads[0].id,'thr_alpha');assert.equal(list.nextOffset,1);assert.match(h.calls[0],/archived=true/);
 h.collision('thr_alpha');await assert.rejects(h.reads.list(scope));h.collision(null);
 h.detail({id:'thr_alpha',projectId:'proj_other'});await assert.rejects(h.reads.list(scope),/Invalid scoped/);
});
