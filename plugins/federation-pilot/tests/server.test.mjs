import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../server.ts';

function harness(store=new Map()){
 const remotes=[{serverId:'alpha',label:'Alpha',projectId:'proj_alpha',bridgeHostId:'host_bridge',sshTarget:'remote-alpha',remotePort:38886,allowWrites:true},{serverId:'beta',label:'Beta',projectId:'proj_beta',bridgeHostId:'host_bridge',sshTarget:'remote-beta',remotePort:38886,allowWrites:true}];
 const config={enabled:true,servers:JSON.stringify(remotes)};
 const calls=[],routes=new Map(),signals=new Map(),sockets=new Map();let dispose;
 const primaryIds=new Set(),primaryErrors=new Map(),remoteIds={alpha:new Set(['proj_alpha','thr_alpha','env_alpha']),beta:new Set(['proj_beta','thr_beta'])};
 const failures=new Map(),moved=new Set();let generation=0;
 const get=async args=>{const id=Object.values(args)[0];if(primaryErrors.has(id))throw primaryErrors.get(id);if(primaryIds.has(id))return {id};throw Object.assign(Error('not found'),{status:404});};
 const bb={storage:{kv:{get:async key=>store.get(key),set:async(key,value)=>{store.set(key,value)}}},settings:{define:()=>({get:async()=>config})},sdk:Object.fromEntries(['threads','projects','hosts','environments'].map(k=>[k,{get}])),log:{warn:()=>{}},onDispose:fn=>dispose=fn,
  hosts:{experimental_client:()=>({experimental_onSignal:(k,fn)=>signals.set(k,fn),experimental_onWorkerExit:()=>{},call:async(method,input)=>{
   calls.push({method,...input});if(method!=='request')return {ok:true,id:input.id};const peer=input.sshTarget.split('-')[1];
   if(failures.has(peer))throw Error(failures.get(peer));let result,status=200;
   if(input.path==='/api/v1/sidebar-bootstrap')result={projects:[{id:`proj_${peer}`,name:peer,threads:moved.has(`thr_${peer}`)?[]:[{id:`thr_${peer}`,projectId:`proj_${peer}`,title:`generation ${generation}`}]}]};
   else if(input.method==='POST'&&input.path==='/api/v1/threads'){result={id:`thr_new${peer}`,projectId:`proj_${peer}`};remoteIds[peer].add(result.id);}
   else if(input.method==='POST'){result={ok:true};}
   else {const id=input.path.split('/').at(-1);if(remoteIds[peer].has(id))result={id,projectId:moved.has(id)?"proj_outside":`proj_${peer}`};else {status=404;result={error:'not found'};}}
   return {status,bodyBase64:Buffer.from(JSON.stringify(result)).toString('base64'),contentType:'application/json'};
  }})},http:{route:(m,p,fn)=>routes.set(`${m} ${p}`,fn),experimental_websocket:(p,fn)=>sockets.set(p,fn)}};
 plugin(bb);
 async function request(path,body,method='POST'){
  return routes.get(`${method} ${path}`)({req:{json:async()=>body},json:(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}})});
 }
 return {config,calls,moved,primaryIds,primaryErrors,remoteIds,failures,signals,sockets,remotes,request,dispose:()=>dispose(),next:()=>generation++};
}
const send=(id='thr_alpha')=>({serverId:'alpha',method:'POST',path:`/api/v1/threads/${id}/send`,body:'{"input":"private text"}'});

test('actual server handler blocks primary collisions and SDK failure before transmitting body',async()=>{
 const h=harness();try{
  for(const [id,error]of [['thr_private',null],['thr_error',Error('SDK offline')]]){
   if(error)h.primaryErrors.set(id,error);else h.primaryIds.add(id);
   const r=await h.request('/proxy',send(id));assert.equal(r.status,error?503:409);assert.ok(!h.calls.some(c=>c.body===send(id).body));
  }
 }finally{await h.dispose();}
});
test('actual handler refuses other-remote collision or uncertain ownership, but permits a verified send',async()=>{
 const h=harness();try{
  h.remoteIds.beta.add('thr_alpha');assert.equal((await h.request('/proxy',send())).status,503);assert.ok(!h.calls.some(c=>c.body));
  h.remoteIds.beta.delete('thr_alpha');h.failures.set('beta','offline');assert.equal((await h.request('/proxy',send())).status,503);assert.ok(!h.calls.some(c=>c.body));
  h.failures.clear();assert.equal((await h.request('/proxy',send())).status,200);assert.equal(h.calls.filter(c=>c.body).length,1);assert.equal(h.calls.find(c=>c.body).sshTarget,'remote-alpha');
 }finally{await h.dispose();}
});
test('fresh list is never stale and a created thread can be subscribed immediately',async()=>{
 const h=harness();try{
  const envelope={serverId:'alpha',method:'GET',path:'/api/v1/sidebar-bootstrap',body:null};const first=await(await h.request('/proxy',envelope)).json();h.next();const next=await(await h.request('/proxy',envelope)).json();assert.notEqual(first.projects[0].threads[0].title,next.projects[0].threads[0].title);
  const created=await h.request('/proxy',{serverId:'alpha',method:'POST',path:'/api/v1/threads',body:'{"projectId":"proj_alpha"}'});assert.equal(created.status,200);
  const ws={readyState:1,sent:[],send(s){this.sent.push(JSON.parse(s))},close(){this.readyState=3}};
  const handlers=h.sockets.get('/remote-ws')({url:new URL('http://primary.invalid/remote-ws?serverId=alpha')});await handlers.onOpen(ws);
  await handlers.onMessage(ws,JSON.stringify({type:'subscribe',target:{kind:'thread-detail',threadId:'thr_newalpha'}}));assert.ok(h.calls.some(c=>c.method==='send'&&JSON.parse(c.data).target?.threadId==='thr_newalpha'));
  const conn=h.calls.find(c=>c.method==='connect');h.signals.get('frame')({hostId:'host_bridge',payload:{id:conn.id,data:JSON.stringify({type:'changed',entity:'thread',id:'thr_private',metadata:{projectId:'proj_alpha'}})}});
  assert.equal(ws.sent.at(-1).entity,'project');assert.equal(ws.sent.at(-1).id,'proj_alpha');await handlers.onClose();
 }finally{await h.dispose();}
});
test('configuration endpoint omits credentials and removed remote is rejected',async()=>{
 const h=harness();try{const c=await(await h.request('/config',null,'GET')).json();assert.equal(c.servers.length,2);assert.ok(!JSON.stringify(c).includes('sshTarget'));h.config.servers='[]';assert.equal((await h.request('/proxy',send())).status,503);assert.equal(h.calls.length,0);}finally{await h.dispose();}
});
test('verified remote requests survive neighboring outage; new IDs remain fail closed',async()=>{
 const h=harness();try{
  assert.equal((await h.request('/proxy',send())).status,200);h.failures.set('beta','offline');h.calls.length=0;
  assert.equal((await h.request('/proxy',send())).status,200);assert.ok(!h.calls.some(c=>c.sshTarget==='remote-beta'));
  h.calls.length=0;assert.equal((await h.request('/proxy',send('thr_unknown'))).status,503);assert.ok(!h.calls.some(c=>c.body));
  h.primaryIds.add('thr_alpha');h.calls.length=0;assert.equal((await h.request('/proxy',send())).status,409);assert.ok(!h.calls.some(c=>c.body),'primary ownership remains checked even when remote owner cached');
 }finally{await h.dispose();}
});
test('verified owners survive restart and label/write settings without contacting offline neighbors',async()=>{
 const store=new Map();const first=harness(store);
 try{assert.equal((await first.request('/proxy',send())).status,200);}finally{await first.dispose();}
 const second=harness(store);try{
  second.failures.set('beta','offline');second.remotes[0].label='Renamed';second.config.servers=JSON.stringify(second.remotes);
  assert.equal((await second.request('/proxy',send())).status,200);assert.ok(!second.calls.some(c=>c.sshTarget==='remote-beta'));
  second.remotes[0].allowWrites=false;second.config.servers=JSON.stringify(second.remotes);second.calls.length=0;
  assert.equal((await second.request('/proxy',send())).status,403);assert.ok(!second.calls.some(c=>c.sshTarget==='remote-beta'));
 }finally{await second.dispose();}
});

test('thread moved outside configured project loses authorization after fresh inventory',async()=>{
 const h=harness();try{
  assert.equal((await h.request('/proxy',send())).status,200);
  h.moved.add('thr_alpha');
  assert.equal((await h.request('/proxy',{serverId:'alpha',method:'GET',path:'/api/v1/sidebar-bootstrap',body:null})).status,200);
  h.calls.length=0;const response=await h.request('/proxy',send());
  assert.equal(response.status,503);assert.ok(!h.calls.some(c=>c.body),'moved thread never receives the send body');
 }finally{await h.dispose();}
});
