import {randomUUID,createHash} from 'node:crypto';
import type {BbPluginApi,ExperimentalPluginWebSocket} from '@get-bb/plugin-sdk';
import {hostContract,hostSignals,requestSchema} from './contract.ts';
import {classifyRequest,routingIds,type Inventory} from './policy.ts';
import {parseServers,publicServer,type RemoteConfig} from './configuration.ts';
import {assertExclusive,entityPath,PrimaryCollisionError} from './ownership.ts';
import {createAgentReads,registerAgentReads} from './agent-read.ts';
import {registerImageRoutes} from './image-routes.ts';
import {handoffRpc} from './handoff-contract.ts';
import {createHandoffs} from './handoff-service.ts';

export default function plugin(bb:BbPluginApi){
 const settings=bb.settings.define({
  enabled:{type:'boolean',label:'Enable federation',default:false},
  servers:{type:'string',label:'Servers (JSON array; see plugin README)',default:''},
  // Preserve existing installations. A nonempty servers array takes precedence.
  label:{type:'string',label:'Legacy server label',default:'Remote BB'},
  projectId:{type:'string',label:'Legacy remote project ID',default:''},
  bridgeHostId:{type:'string',label:'Legacy bridge machine ID',default:''},
  sshTarget:{type:'string',label:'Legacy SSH target',default:''},
  remotePort:{type:'number',label:'Legacy remote API port',default:38886},
  allowWrites:{type:'boolean',label:'Legacy remote writes',default:false},
  allowAgentReads:{type:'boolean',label:'Legacy agent list/read permission',default:false},
 });
 const host=bb.hosts.experimental_client({contract:hostContract,experimental_signals:hostSignals});
 type Snapshot={key:string,at:number,inventory:Inventory,project:any};
 type Client={socket:ExperimentalPluginWebSocket,config:RemoteConfig,ready:boolean,closed:boolean,queue:string[],lastSeen:number};
 const caches=new Map<string,Snapshot>(),loading=new Map<string,Promise<Snapshot>>(),clients=new Map<string,Client>();
 const verifiedOwners=new Map<string,string>();let verifiedTopology='';
 const absentPrimary=new Set<string>();
 const failures:Array<{at:number,serverId:string,method:string,path:string,error:string}>=[];
 async function configurations(){const s=await settings.get();return {enabled:s.enabled,servers:parseServers(s.servers,s)};}
 async function selected(serverId:string){const all=await configurations();if(!all.enabled)throw Error('Federation disabled');const c=all.servers.find(c=>c.serverId===serverId);if(!c)throw Error('Unknown or disabled remote');return c;}
 const keyOf=(c:RemoteConfig)=>JSON.stringify(c);
 async function upstream(c:RemoteConfig,method:string,path:string,body:string|null=null){return host.call('request',{sshTarget:c.sshTarget,port:c.remotePort,...requestSchema.parse({method,path,body})},{hostId:c.bridgeHostId});}
 async function json(c:RemoteConfig,path:string){const r=await upstream(c,'GET',path);if(r.status>=300)throw Error(`Remote API ${r.status}: GET ${path}`);return JSON.parse(Buffer.from(r.bodyBase64,'base64').toString('utf8'));}
 async function primaryExists(id:string){
  try{
   if(id.startsWith('thr_'))await bb.sdk.threads.get({threadId:id});
   else if(id.startsWith('proj_'))await bb.sdk.projects.get({projectId:id});
   else if(id.startsWith('host_'))await bb.sdk.hosts.get({hostId:id});
   else if(id.startsWith('env_'))await bb.sdk.environments.get({environmentId:id});
   else throw Error('Invalid entity ID');
   return true;
  }catch(e){if((e as {status?:number})?.status===404)return false;throw e;}
 }
 async function exclusive(c:RemoteConfig,ids:string[],checkPeers=true){
  const all=await configurations(),topology=createHash('sha256').update(JSON.stringify(all.servers.map(({serverId,projectId,bridgeHostId,sshTarget,remotePort})=>({serverId,projectId,bridgeHostId,sshTarget,remotePort})).sort((a,b)=>a.serverId.localeCompare(b.serverId)))).digest('hex');
  if(topology!==verifiedTopology){verifiedOwners.clear();verifiedTopology=topology;}
  for(const id of new Set(ids)){
   // Primary is checked on every addressed operation, even after remote ownership is cached.
   if(await primaryExists(id))throw new PrimaryCollisionError(id);
   const saved=await bb.storage.kv.get<{topology:string,serverId:string}>(`owner:${id}`);
   if(saved?.topology===topology&&!verifiedOwners.has(id))verifiedOwners.set(id,saved.serverId);
   const known=verifiedOwners.get(id);if(known&&known!==c.serverId)throw Error(`Identifier collision between remotes: ${id}`);
   if(!checkPeers||known===c.serverId)continue;
   await assertExclusive([id],async()=>false,all.servers.filter(other=>other.serverId!==c.serverId).map(other=>async entityId=>{
    const r=await upstream(other,'GET',entityPath(entityId));if(r.status===404)return false;if(r.status>=200&&r.status<300)return true;throw Error(`Cannot verify new ownership on ${other.serverId}`);
   }));
   // Recheck after async work: concurrent requests must not claim the same ID.
   const concurrent=verifiedOwners.get(id);if(concurrent&&concurrent!==c.serverId)throw Error('Concurrent ownership collision');
   if(verifiedTopology!==topology)throw Error('Configuration changed during ownership check');
   verifiedOwners.set(id,c.serverId);
   await bb.storage.kv.set(`owner:${id}`,{topology,serverId:c.serverId});
  }
 }
 async function isPrimaryForInventory(id:string){
  if(!/^(thr|proj|host|env)_[a-z0-9]+$/.test(id))throw Error('Invalid remote entity ID');
  if(absentPrimary.has(id))return false;
  const exists=await primaryExists(id);if(!exists)absentPrimary.add(id);return exists;
 }
 async function inventory(c:RemoteConfig,fresh=false):Promise<Snapshot>{
  const key=keyOf(c),cached=caches.get(c.serverId);
  if(!fresh&&cached?.key===key&&Date.now()-cached.at<10000)return cached;
  // A fresh list request never joins an older in-flight read.
  if(!fresh&&loading.has(key))return loading.get(key)!;
  const task=(async()=>{
   const data=await json(c,'/api/v1/sidebar-bootstrap');let project=data.projects?.find((p:any)=>p.id===c.projectId);if(!project)throw Error('Remote project not found');
   if(await isPrimaryForInventory(c.projectId))throw Error('Remote project exists on primary');
   const threads=[];for(const t of project.threads??[]){
    let local=false;for(const id of [t.id,t.projectId,t.environmentId,t.environmentHostId].filter(Boolean))if(await isPrimaryForInventory(id)){local=true;break;}
    if(!local)threads.push(t);
   }
   const sources=[];for(const source of project.sources??[])if(!source.hostId||!await isPrimaryForInventory(source.hostId))sources.push(source);
   project={...project,threads,sources};
   const i:Inventory={projectId:c.projectId,threads:new Set(),hosts:new Set(),environments:new Set()};
   for(const source of project.sources??[])if(source.hostId)i.hosts.add(source.hostId);
   for(const t of project.threads??[]){i.threads.add(t.id);if(t.environmentId)i.environments.add(t.environmentId);if(t.environmentHostId)i.hosts.add(t.environmentHostId);}
   const result={key,at:Date.now(),inventory:i,project};caches.set(c.serverId,result);return result;
  })();loading.set(key,task);try{return await task;}finally{if(loading.get(key)===task)loading.delete(key);}
 }
 async function verifyUnknown(c:RemoteConfig,i:Inventory,ids:string[]){
  await exclusive(c,ids);
  for(const id of ids){
   if(id.startsWith('thr_')&&!i.threads.has(id)){const t=await json(c,entityPath(id));if(t.id!==id||t.projectId!==c.projectId)throw Error('Thread outside configured project');i.threads.add(id);if(t.environmentId)i.environments.add(t.environmentId);}
   if(id.startsWith('env_')&&!i.environments.has(id)){const e=await json(c,entityPath(id));if(e.id!==id||e.projectId!==c.projectId)throw Error('Environment outside configured project');i.environments.add(id);if(e.hostId)i.hosts.add(e.hostId);}
  }
 }
 registerAgentReads(bb,createAgentReads({configurations,exclusive,get:json}));
 const handoffs=createHandoffs({configurations,selected,exclusive,get:json,
  upload:(c,input)=>host.call('handoffUpload',{...input,sshTarget:c.sshTarget,port:c.remotePort},{hostId:c.bridgeHostId}),
  create:(c,body)=>upstream(c,'POST','/api/v1/threads',body),
  load:id=>bb.storage.kv.get(`handoff:${id}`),save:(id,value)=>bb.storage.kv.set(`handoff:${id}`,value),
 });
 bb.rpc.register(handoffRpc,{
  handoffTargets:()=>handoffs.targets(),handoffOptions:input=>handoffs.options(input),
  handoffBegin:input=>handoffs.begin(input),handoffUpload:input=>handoffs.upload(input),
  handoffCommit:input=>handoffs.commit(input),handoffStatus:input=>handoffs.status(input),
 });
 registerImageRoutes(bb,{selected,exclusive,
  upload:(c,input)=>host.call('imageUpload',{...input,sshTarget:c.sshTarget,port:c.remotePort},{hostId:c.bridgeHostId}),
  get:(c,path)=>upstream(c,'GET',path),
 });
 bb.http.route('GET','/config',async ctx=>{try{const c=await configurations();return ctx.json({enabled:c.enabled,servers:c.servers.map(publicServer)});}catch{return ctx.json({enabled:false,servers:[],error:'Invalid server settings'},400);}});
 bb.http.route('GET','/diagnostics',ctx=>ctx.json({failures}));
 bb.http.route('GET','/check',async ctx=>{
  const cfg=await configurations();const rows=await Promise.all(cfg.servers.map(async c=>{try{const d=await inventory(c,true);return {serverId:c.serverId,ok:true,projectId:c.projectId,threads:d.inventory.threads.size};}catch(e){return {serverId:c.serverId,ok:false,error:String(e)};}}));
  return ctx.json({ok:rows.length>0&&rows.every(r=>r.ok),servers:rows});
 });
 bb.http.route('POST','/proxy',async ctx=>{
  const d={at:Date.now(),serverId:'',method:'',path:'',error:''};
  try{
   const raw=await ctx.req.json();const {serverId='default',...envelope}=raw;d.serverId=serverId;
   const parsed=requestSchema.safeParse(envelope);if(!parsed.success||typeof serverId!=='string')return ctx.json({error:{message:'Invalid federation request'}},400);
   const c=await selected(serverId);const {method,path,body}=parsed.data;d.method=method;d.path=path;
   let object:unknown=null;if(body!==null){try{object=JSON.parse(body);}catch{return ctx.json({error:{message:'Only JSON is supported'}},415);}}
   const data=await inventory(c,method==='GET'&&['/api/v1/sidebar-bootstrap','/api/v1/projects'].includes(path.split('?')[0]));const i=data.inventory;
   await verifyUnknown(c,i,routingIds(path,object));
   const verdict=classifyRequest(method,path,object,i,c.allowWrites);if(!verdict.ok)return ctx.json({error:{code:'federation_scope',message:verdict.reason}},403);
   const url=new URL(path,'http://remote.invalid');
   if(method==='GET'){
    if(url.pathname==='/api/v1/sidebar-bootstrap')return ctx.json({sections:[],projects:[data.project],personalProject:null});
    if(url.pathname==='/api/v1/projects')return ctx.json([data.project]);
    if(url.pathname==='/api/v1/hosts')return ctx.json((await json(c,path)).filter((h:any)=>i.hosts.has(h.id)));
    if(['/api/v1/threads','/api/v1/environments'].includes(url.pathname)){url.searchParams.set('projectId',c.projectId);return ctx.json((await json(c,url.pathname+url.search)).filter((e:any)=>e.projectId===c.projectId));}
   }
   const r=await upstream(c,method,path,body);
   if(method!=='GET'&&method!=='HEAD')data.at=0;
   if(method==='POST'&&url.pathname==='/api/v1/threads'&&r.status<300){const created=JSON.parse(Buffer.from(r.bodyBase64,'base64').toString());if(created.projectId!==c.projectId||typeof created.id!=='string')throw Error('Invalid created thread');await exclusive(c,[created.id]);i.threads.add(created.id);if(created.environmentId)i.environments.add(created.environmentId);}
   return new Response([204,205,304].includes(r.status)?null:Buffer.from(r.bodyBase64,'base64'),{status:r.status,headers:{'content-type':r.contentType,'cache-control':'no-store'}});
  }catch(e){if(e instanceof PrimaryCollisionError){const response=ctx.json({error:{code:'federation_primary_owner',message:e.message}},409);response.headers.set('x-bb-federation-primary',e.id);return response;}d.error=String(e).slice(0,500);failures.push(d);if(failures.length>30)failures.shift();bb.log.warn(`Federation request failed (${d.serverId}): ${d.error}`);return ctx.json({error:{code:'federation_unavailable',message:String(e)}},503);}
 });
 host.experimental_onSignal('frame',({hostId,payload})=>{
  const client=clients.get(payload.id);if(!client||client.config.bridgeHostId!==hostId||client.closed)return;
  let m:any;try{m=JSON.parse(payload.data);}catch{return;}client.lastSeen=Date.now();if(m.type!=='changed')return;
  const cached=caches.get(client.config.serverId),i=cached?.inventory;if(!i)return;
  // Unknown IDs never gain ownership from a signal. Refresh the verified project list instead.
  if(m.entity==='thread'&&!i.threads.has(m.id)){
   if(m.metadata?.projectId===i.projectId&&client.socket.readyState===1){cached!.at=0;client.socket.send(JSON.stringify({type:'changed',entity:'project',id:i.projectId,changes:['threads-changed']}));}return;
  }
  const allowed=m.entity==='project'&&m.id===i.projectId||m.entity==='thread'&&i.threads.has(m.id)||m.entity==='environment'&&i.environments.has(m.id)||m.entity==='host'&&i.hosts.has(m.id);
  if(allowed&&client.socket.readyState===1){cached!.at=0;client.socket.send(payload.data);}
 });
 host.experimental_onSignal('closed',({hostId,payload})=>{const c=clients.get(payload.id);if(c&&c.config.bridgeHostId===hostId&&!c.closed)c.socket.close(4001,'Remote unavailable');});
 host.experimental_onWorkerExit(({hostId})=>{for(const c of clients.values())if(c.config.bridgeHostId===hostId)c.socket.close(4001,'Bridge unavailable');});
 const heartbeat=setInterval(()=>{for(const [id,c]of clients){if(!c.ready||c.closed)continue;if(Date.now()-c.lastSeen>45000){c.socket.close(4001,'Remote heartbeat timed out');continue;}
  void selected(c.config.serverId).then(current=>{if(keyOf(current)!==keyOf(c.config))throw Error('Configuration changed');return host.call('send',{id,data:'{"type":"ping"}'},{hostId:c.config.bridgeHostId,timeoutMs:5000});}).then(r=>{if(!r.ok)c.socket.close(4001,'Bridge unavailable');}).catch(()=>c.socket.close(4001,'Bridge unavailable'));
 }},20000);
 async function closeClient(id:string){const c=clients.get(id);if(!c)return;c.closed=true;clients.delete(id);await host.call('disconnect',{id},{hostId:c.config.bridgeHostId}).catch(()=>{});}
 bb.http.experimental_websocket('/remote-ws',context=>{
  const id=randomUUID(),serverId=context.url.searchParams.get('serverId')??'default';let ended=false;const early:string[]=[];
  async function forward(data:string){
   const c=clients.get(id);if(!c||c.closed)return;let m:any;try{m=JSON.parse(data);}catch{return;}
   if(!['subscribe','unsubscribe','ping'].includes(m.type))return;
   if(m.type!=='ping'){
    const t=m.target,i=caches.get(serverId)?.inventory;if(!i||!t)return;
    if(t.kind==='thread-detail'&&!i.threads.has(t.threadId)){if(!/^thr_[a-z0-9]+$/.test(t.threadId??''))return;await verifyUnknown(c.config,i,[t.threadId]);}
    const valid=['thread-list','project-list','host-list','environment-list'].includes(t.kind)||t.kind==='thread-detail'&&i.threads.has(t.threadId)||t.kind==='project-detail'&&t.projectId===i.projectId||t.kind==='environment-detail'&&i.environments.has(t.environmentId)||t.kind==='host-detail'&&i.hosts.has(t.hostId);if(!valid)return;
   }
   if(!c.ready){if(c.queue.length<128)c.queue.push(data);return;}
   const result=await host.call('send',{id,data},{hostId:c.config.bridgeHostId});if(!result.ok)throw Error('Remote disconnected');
  }
  return {
   async onOpen(socket){try{const config=await selected(serverId);await inventory(config);if(ended||socket.readyState!==1)return;const c:Client={socket,config,ready:false,closed:false,queue:[],lastSeen:Date.now()};clients.set(id,c);
    for(const data of early.splice(0))await forward(data);await host.call('connect',{id,sshTarget:config.sshTarget,port:config.remotePort},{hostId:config.bridgeHostId});
    if(c.closed||ended||socket.readyState!==1){await host.call('disconnect',{id},{hostId:config.bridgeHostId});await closeClient(id);return;}
    c.ready=true;socket.send('{"type":"fedprobe-remote-ready"}');for(const data of c.queue.splice(0))await forward(data);
   }catch{socket.close(4001,'Remote unavailable');await closeClient(id);}},
   async onMessage(socket,raw){if(ended)return;const data=typeof raw==='string'?raw:new TextDecoder().decode(raw);if(data.length>65536)return;if(!clients.has(id)){if(early.length<128)early.push(data);return;}try{await forward(data);}catch{socket.close(4001,'Remote unavailable');await closeClient(id);}},
   async onClose(){ended=true;early.length=0;await closeClient(id);},
  };
 });
 bb.onDispose(async()=>{clearInterval(heartbeat);for(const [id,c]of clients){c.socket.close(1001,'Federation disabled');await closeClient(id);}});
}
