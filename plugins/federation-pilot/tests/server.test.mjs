import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../server.ts';

function harness(store=new Map()){
 const remotes=[{serverId:'alpha',label:'Alpha',projectId:'proj_alpha',bridgeHostId:'host_bridge',sshTarget:'remote-alpha',remotePort:38886,allowWrites:true},{serverId:'beta',label:'Beta',projectId:'proj_beta',bridgeHostId:'host_bridge',sshTarget:'remote-beta',remotePort:38886,allowWrites:true}];
 const config={enabled:true,servers:JSON.stringify(remotes)};
 const calls=[],routes=new Map(),signals=new Map(),sockets=new Map(),tools=new Map();let dispose,cli;
 const primaryIds=new Set(),primaryErrors=new Map(),remoteIds={alpha:new Set(['proj_alpha','thr_alpha','env_alpha']),beta:new Set(['proj_beta','thr_beta'])};
 const failures=new Map(),moved=new Set();let generation=0;
 const get=async args=>{const id=Object.values(args)[0];if(primaryErrors.has(id))throw primaryErrors.get(id);if(primaryIds.has(id))return {id};throw Object.assign(Error('not found'),{status:404});};
 const bb={cli:{register:value=>cli=value},agents:{registerTool:value=>tools.set(value.name,value),configure:()=>{}},storage:{kv:{get:async key=>store.get(key),set:async(key,value)=>{store.set(key,value)}}},settings:{define:()=>({get:async()=>config})},sdk:Object.fromEntries(['threads','projects','hosts','environments'].map(k=>[k,{get}])),log:{warn:()=>{}},onDispose:fn=>dispose=fn,
  hosts:{experimental_client:()=>({experimental_onSignal:(k,fn)=>signals.set(k,fn),experimental_onWorkerExit:()=>{},call:async(method,input)=>{
   calls.push({method,...input});
   if(method==='imageUpload')return {status:201,contentType:'application/json',bodyBase64:Buffer.from(JSON.stringify({type:'localImage',sourceProjectId:input.projectId,path:'image.png',name:'image.png',mimeType:input.mimeType,sizeBytes:Buffer.from(input.bytesBase64,'base64').length})).toString('base64')};
   if(method!=='request')return {ok:true,id:input.id};const peer=input.sshTarget.split('-')[1];
   if(failures.has(peer))throw Error(failures.get(peer));let result,status=200;
   if(input.path==='/api/v1/sidebar-bootstrap')result={projects:[{id:`proj_${peer}`,name:peer,threads:moved.has(`thr_${peer}`)?[]:[{id:`thr_${peer}`,projectId:`proj_${peer}`,title:`generation ${generation}`}]}]};
   else if(input.method==='GET'&&input.path.startsWith('/api/v1/threads?'))result=[{id:`thr_${peer}`,projectId:`proj_${peer}`,title:'Saved thread'}];
   else if(input.method==='GET'&&input.path.includes('/events?'))result=[{threadId:`thr_${peer}`,seq:1,type:'user.message',data:{text:'Saved message'}}];
   else if(input.method==='POST'&&input.path==='/api/v1/threads'){result={id:`thr_new${peer}`,projectId:`proj_${peer}`};remoteIds[peer].add(result.id);}
   else if(input.method==='POST'){result={ok:true};}
   else {const id=input.path.split('/').at(-1);if(remoteIds[peer].has(id))result={id,projectId:moved.has(id)?"proj_outside":`proj_${peer}`};else {status=404;result={error:'not found'};}}
   return {status,bodyBase64:Buffer.from(JSON.stringify(result)).toString('base64'),contentType:'application/json'};
  }})},http:{route:(m,p,fn)=>routes.set(`${m} ${p}`,fn),experimental_websocket:(p,fn)=>sockets.set(p,fn)}};
 plugin(bb);
 async function request(path,body,method='POST'){
  const url=`http://primary.invalid${path}`;
  return routes.get(`${method} ${path}`)({req:{json:async()=>body,url,raw:new Request(url,{method,...(method==='POST'?{body:JSON.stringify(body),headers:{'content-type':'application/json'}}:{})})},json:(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}})});
 }
 return {config,calls,moved,primaryIds,primaryErrors,remoteIds,failures,signals,sockets,remotes,request,tools,cli,dispose:()=>dispose(),next:()=>generation++};
}
const send=(id='thr_alpha')=>({serverId:'alpha',method:'POST',path:`/api/v1/threads/${id}/send`,body:'{"input":"private text"}'});

test('registered image route uses the selected bridge and actual primary/neighbor ownership gates',async()=>{
 const h=harness();
 const bytes=Buffer.alloc(24);bytes.set([137,80,78,71,13,10,26,10]);
 const input={serverId:'alpha',projectId:'proj_alpha',filename:'image.png',mimeType:'image/png',bytesBase64:bytes.toString('base64')};
 try {
  h.primaryIds.add('proj_alpha');assert.equal((await h.request('/image-upload',input)).status,409);
  h.primaryIds.delete('proj_alpha');h.remoteIds.beta.add('proj_alpha');assert.equal((await h.request('/image-upload',input)).status,503);
  h.remoteIds.beta.delete('proj_alpha');h.failures.set('beta','offline');assert.equal((await h.request('/image-upload',input)).status,503);
  assert.equal(h.calls.filter(c=>c.method==='imageUpload').length,0);
  h.failures.clear();assert.equal((await h.request('/image-upload',input)).status,201);
  const uploads=h.calls.filter(c=>c.method==='imageUpload');assert.equal(uploads.length,1);assert.equal(uploads[0].sshTarget,'remote-alpha');assert.equal(uploads[0].projectId,'proj_alpha');
 }finally{await h.dispose();}
});

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

test('registered agent CLI and tools use explicit read permission and GETs only',async()=>{
 const h=harness(),ctx={signal:new AbortController().signal,threadId:'thr_local',projectId:'proj_local'};
 try{
  const tool=h.tools.get('federation_read_thread');assert.ok(tool);assert.equal(h.tools.has('federation_send'),false);
  assert.equal((await tool.execute({serverId:'alpha',projectId:'proj_alpha',threadId:'thr_alpha'},ctx)).isError,true);assert.equal(h.calls.length,0);
  h.remotes[0].allowAgentReads=true;h.remotes[0].allowWrites=false;h.config.servers=JSON.stringify(h.remotes);
  const result=JSON.parse(await tool.execute({serverId:'alpha',projectId:'proj_alpha',threadId:'thr_alpha'},ctx));assert.equal(result.source.serverId,'alpha');assert.equal(result.events[0].data.text,'Saved message');
  const cli=await h.cli.run(['list','--server-id','alpha','--project-id','proj_alpha','--json'],ctx);assert.equal(cli.exitCode,0);assert.equal(JSON.parse(cli.stdout).threads[0].id,'thr_alpha');
  const read=await h.cli.run(['read','--server-id','alpha','--project-id','proj_alpha','--thread-id','thr_alpha','--json'],ctx);assert.equal(read.exitCode,0);assert.equal(JSON.parse(read.stdout).events[0].seq,1);
  const invalid=await h.cli.run(['read','--server-id','alpha','--project-id','proj_alpha','--thread-id','thr_alpha','--limit','101'],ctx);assert.notEqual(invalid.exitCode,0);
  assert.ok(h.calls.every(c=>c.method==='GET'&&c.body===null));
  h.calls.length=0;h.primaryIds.add('thr_alpha');assert.equal((await tool.execute({serverId:'alpha',projectId:'proj_alpha',threadId:'thr_alpha'},ctx)).isError,true);assert.ok(!h.calls.some(c=>c.path.includes('/events')));
 }finally{await h.dispose();}
});
