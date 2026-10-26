import test from 'node:test';
import assert from 'node:assert/strict';
import {createFederation} from '../federation-core.mjs';
import {createEnv,PRIMARY_BOOTSTRAP} from './fake-env.mjs';
const peers=[{serverId:'alpha',projectId:'proj_alpha',label:'Alpha',allowWrites:true},{serverId:'beta',projectId:'proj_beta',label:'Beta',allowWrites:true}];
function setup(){
 const remotes=Object.fromEntries(peers.map(p=>[p.serverId,{
  'GET /api/v1/sidebar-bootstrap':{projects:[{id:p.projectId,name:p.label,threads:[{id:`thr_${p.serverId}`,projectId:p.projectId,environmentId:`env_${p.serverId}`}]}]},
  [`POST /api/v1/threads/thr_${p.serverId}/send`]:{ok:true},
  'POST /api/v1/threads':{id:`thr_new${p.serverId}`,projectId:p.projectId},
 }]));
 const e=createEnv({primary:{'GET /api/v1/sidebar-bootstrap':PRIMARY_BOOTSTRAP},remotes});
 const rows=new Map();const f=createFederation({win:e.win,config:{servers:peers},pluginId:'federation-pilot',setRowStatus:(id,s)=>s===null?rows.delete(id):rows.set(id,s)});
 return {e,f,remotes,rows};
}
test('two remote projects, native create and send route to exactly their owners',async()=>{
 const {e,f}=setup();const boot=await(await e.win.fetch('/api/v1/sidebar-bootstrap')).json();assert.deepEqual(boot.projects.map(p=>p.id),['proj_local01','proj_alpha','proj_beta']);
 for(const peer of peers){
  e.calls.length=0;
  const r=await e.win.fetch('/api/v1/threads',{method:'POST',body:JSON.stringify({projectId:peer.projectId,environment:{environmentId:`env_${peer.serverId}`}})});
  assert.equal(r.status,200);assert.equal(e.calls.length,1);assert.equal(e.calls[0].serverId,peer.serverId);
  assert.equal(f.isRemote(`thr_new${peer.serverId}`),true);
  e.calls.length=0;await e.win.fetch(`/api/v1/threads/thr_${peer.serverId}/send`,{method:'POST',body:'{"input":"hello"}'});
  assert.equal(e.calls.length,1);assert.equal(e.calls[0].serverId,peer.serverId);
 }
 e.calls.length=0;assert.equal((await e.win.fetch('/api/v1/threads',{method:'POST',body:JSON.stringify({projectId:'proj_alpha',environment:{environmentId:'env_beta'}})})).status,409);assert.equal(e.calls.length,0);f.dispose();
});
test('one failed list/channel leaves other remote and primary alive; retries and disposal are independent',async()=>{
 const {e,f,remotes,rows}=setup();await e.win.fetch('/api/v1/sidebar-bootstrap');
 const socket=new e.win.WebSocket('ws://primary.invalid/ws');const [primary,a,b]=e.FakeWS.all;
 for(const ws of [primary,a,b])ws.serverOpen();a.serverSend({type:'fedprobe-remote-ready'});b.serverSend({type:'fedprobe-remote-ready'});
 socket.send(JSON.stringify({type:'subscribe',target:{kind:'thread-list'}}));
 socket.send(JSON.stringify({type:'subscribe',target:{kind:'thread-detail',threadId:'thr_beta'}}));
 assert.equal(a.sent.length,1);assert.equal(b.sent.length,2);assert.equal(primary.sent.length,1);
 a.close(4001);assert.equal(rows.get('thr_alpha').tone,'error');assert.equal(rows.get('thr_beta').tone,'default');assert.equal(primary.readyState,1);assert.equal(b.readyState,1);
 remotes.alpha['GET /api/v1/sidebar-bootstrap']=()=>{throw Error('offline')};const result=await(await e.win.fetch('/api/v1/sidebar-bootstrap')).json();assert.equal(result.projects.length,3);
 f.dispose();assert.equal(e.timers.size,0);assert.ok(e.FakeWS.all.every(s=>s.readyState===3));
});
test('arbitrary tool arguments and fabricated events cannot claim private or neighboring threads',async()=>{
 const {e,f,remotes}=setup();await e.win.fetch('/api/v1/sidebar-bootstrap');
 remotes.alpha['GET /api/v1/threads/thr_alpha/timeline']={rows:[{toolArgs:{threadId:'thr_private',id:'thr_beta'},payload:{id:'thr_hidden'}}]};
 await e.win.fetch('/api/v1/threads/thr_alpha/timeline');assert.equal(f.isRemote('thr_private'),false);assert.equal(f.isRemote('thr_hidden'),false);assert.deepEqual(f.conflicts(),[]);
 const socket=new e.win.WebSocket('ws://primary.invalid/ws');const a=e.FakeWS.all[1];a.serverSend({type:'changed',entity:'thread',id:'thr_private',metadata:{projectId:'proj_alpha'}});assert.equal(f.isRemote('thr_private'),false);
 e.calls.length=0;await e.win.fetch('/api/v1/threads/thr_private/send',{method:'POST',body:'{"input":"private"}'});assert.equal(e.calls[0].to,'primary');socket.close();f.dispose();
});
test('duplicate remote identifiers refuse operations rather than selecting a winner',async()=>{
 const {e,f,remotes}=setup();remotes.beta['GET /api/v1/sidebar-bootstrap'].projects[0].threads.push({id:'thr_alpha',projectId:'proj_beta'});await e.win.fetch('/api/v1/sidebar-bootstrap');e.calls.length=0;
 assert.equal((await e.win.fetch('/api/v1/threads/thr_alpha/send',{method:'POST',body:'{}'})).status,409);assert.equal(e.calls.length,0);f.dispose();
});
test('SPA navigation to an older remote thread routes within the explicit remote project',async()=>{
 const {e,f}=setup();await e.win.fetch('/api/v1/sidebar-bootstrap');e.win.location.href='http://primary.invalid/projects/proj_beta/threads/thr_archived';e.calls.length=0;
 await e.win.fetch('/api/v1/threads/thr_archived');assert.equal(e.calls[0].serverId,'beta');assert.equal(e.calls[0].to,'bridge');f.dispose();
});
test('primary host wins over a remote row claim, including when learned later',async()=>{
 const {e,f,remotes}=setup();remotes.alpha['GET /api/v1/sidebar-bootstrap'].projects[0].threads[0].environmentHostId='host_private';
 await e.win.fetch('/api/v1/sidebar-bootstrap');assert.equal(f.isRemote('host_private'),true);
 // A later primary list proves the owner; remove remote claim and keep local operations working.
 const original=e.win.fetch;
 // Another bootstrap exposes a primary thread host through a typed resource.
 PRIMARY_BOOTSTRAP.projects[0].threads[0].environmentHostId='host_private';
 try{await e.win.fetch('/api/v1/sidebar-bootstrap');assert.equal(f.isRemote('host_private'),false);assert.deepEqual(f.conflicts(),[]);e.calls.length=0;assert.equal((await e.win.fetch('/api/v1/hosts/host_private')).status,200);assert.equal(e.calls[0].to,'primary');}
 finally{delete PRIMARY_BOOTSTRAP.projects[0].threads[0].environmentHostId;f.dispose();}
});
test('trusted primary-collision marker clears a tentative route without replaying the send',async()=>{
 const e=createEnv();const native=e.win.fetch;
 e.win.location.href='http://primary.invalid/projects/proj_alpha/threads/thr_private';
 let bridge=0;
 e.win.fetch=async(input,init)=>String(input).endsWith('/proxy')?(bridge++,new Response('{}',{status:409,headers:{'x-bb-federation-primary':'thr_private','content-type':'application/json'}})):native(input,init);
 const f=createFederation({win:e.win,config:{servers:peers},pluginId:'federation-pilot'});
 assert.equal((await e.win.fetch('/api/v1/threads/thr_private/send',{method:'POST',body:'{}'})).status,409);assert.equal(bridge,1);assert.equal(e.primaryCalls().length,0);assert.equal(f.isRemote('thr_private'),false);
 await e.win.fetch('/api/v1/threads/thr_private');assert.equal(e.primaryCalls().length,1);assert.equal(bridge,1);f.dispose();
});
