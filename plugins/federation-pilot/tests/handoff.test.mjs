import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHandoffs} from '../handoff-service.ts';
import {handoffBytes,handoffHostPayload,uploadHandoffFile} from '../handoff-upload.ts';
import {handoffBeginSchema} from '../handoff-contract.ts';

const bytes=Buffer.from('# Synthetic conversation\n');
const file={name:'conversation.md',mimeType:'text/markdown',sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
const target={serverId:'alpha',projectId:'proj_alpha',hostId:'host_alpha',environmentId:'env_alpha'};
const begin={...target,providerId:'codex',model:'model-example',title:'Synthetic handoff',prompt:'Continue the attached synthetic example.',files:[file]};
const reply=data=>({status:200,bodyBase64:Buffer.from(JSON.stringify(data)).toString('base64')});
test('host RPC connection fields are removed before strict file validation and multipart upload',async()=>{
 const rpcInput={...file,projectId:'proj_alpha',bytesBase64:bytes.toString('base64'),sshTarget:'remote-alpha',port:38886};
 // Regression control: passing the complete host RPC input directly used to fail.
 assert.throws(()=>handoffBytes(rpcInput),/Unrecognized keys/);
 const payload=handoffHostPayload(rpcInput);assert.equal('sshTarget' in payload,false);assert.equal('port' in payload,false);
 assert.throws(()=>handoffHostPayload({...rpcInput,path:'/send'}),/Unrecognized key/);
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,init)=>{
  calls++;assert.equal(url,'http://127.0.0.1:39001/api/v1/projects/proj_alpha/attachments');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
  const uploaded=init.body.get('file');assert.equal(uploaded.name,'conversation.md');assert.equal(uploaded.type,'text/markdown');assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()),bytes);
  return new Response(JSON.stringify({type:'localFile',sourceProjectId:'proj_alpha',path:'conversation-123-abc.md',name:file.name,mimeType:file.mimeType,sizeBytes:bytes.length}),{status:201,headers:{'content-type':'application/json'}});
 };
 try{const response=await uploadHandoffFile(39001,payload,new AbortController().signal);assert.equal(response.status,201);assert.equal(JSON.parse(Buffer.from(response.bodyBase64,'base64')).sourceProjectId,'proj_alpha');assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
function harness(store=new Map()){
 const config={...target,label:'Alpha',sshTarget:'remote-alpha',remotePort:38886,bridgeHostId:'host_bridge',allowWrites:true,allowAgentReads:false,enabled:true};
 const env={id:target.environmentId,hostId:target.hostId,projectId:target.projectId,status:'ready',path:'/workspace/example'};
 const host={id:target.hostId,name:'Remote machine',status:'connected'};
 const calls=[],primary=new Set();let failCreate=false,onUpload=()=>{},onCreate=()=>{};
 const deps={
  configurations:async()=>({enabled:true,servers:[config]}),selected:async id=>{assert.equal(id,'alpha');return {...config};},
  exclusive:async(c,ids)=>{for(const id of ids)if(primary.has(id))throw Error('Primary collision');},
  get:async(c,path)=>{
   if(path.startsWith('/api/v1/system/providers?'))return [{id:'codex',displayName:'Codex',available:true}];
   if(path.startsWith('/api/v1/system/execution-options?'))return {models:[{model:'model-example',displayName:'Example',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Medium'}]}]};
   if(path==='/api/v1/hosts')return [host];if(path.startsWith('/api/v1/environments?'))return [env];
   if(path==='/api/v1/hosts/host_alpha')return host;if(path==='/api/v1/environments/env_alpha')return env;throw Error('Unexpected GET');
  },
  upload:async(c,input)=>{calls.push({kind:'upload',c,input});onUpload();return reply({type:'localFile',sourceProjectId:input.projectId,path:'conversation-123-abc.md',name:input.name,mimeType:input.mimeType,sizeBytes:input.sizeBytes});},
  create:async(c,body)=>{calls.push({kind:'create',c,body:JSON.parse(body)});onCreate();if(failCreate)throw Error('Connection lost after submission');return reply({id:'thr_created',projectId:'proj_alpha',environmentId:'env_alpha'});},
  load:async id=>structuredClone(store.get(id)),save:async(id,row)=>{store.set(id,structuredClone(row));},
 };
 return {service:createHandoffs(deps),deps,store,config,env,host,calls,primary,setFail:()=>failCreate=true,onUpload:fn=>onUpload=fn,onCreate:fn=>onCreate=fn};
}
async function ready(h){const op=await h.service.begin(begin);await h.service.upload({operationId:op.operationId,index:0,bytesBase64:bytes.toString('base64')});return op;}
test('targets use native host status and only connected ready project environments',async()=>{
 const h=harness();assert.equal((await h.service.targets())[0].targets.length,1);h.env.projectId='proj_elsewhere';assert.equal((await h.service.targets())[0].targets.length,0);
 h.env.projectId='proj_alpha';h.host.status='disconnected';assert.equal((await h.service.targets())[0].targets.length,0);
});
test('explicit target receives files and one creation, without primary identifiers or reverse callback',async()=>{
 const h=harness(),op=await ready(h);const result=await h.service.commit(op);
 assert.equal(result.state,'complete');assert.equal(result.threadId,'thr_created');assert.equal(result.serverId,'alpha');
 const sent=h.calls.find(c=>c.kind==='create');assert.equal(sent.c.serverId,'alpha');assert.deepEqual(sent.body.environment,{type:'reuse',environmentId:'env_alpha'});
 assert.equal(sent.body.projectId,'proj_alpha');assert.equal(sent.body.providerId,'codex');assert.equal(sent.body.parentThreadId,undefined);assert.equal(sent.body.sourceThreadId,undefined);
 assert.equal(sent.body.input[1].sourceProjectId,'proj_alpha');await h.service.commit(op);assert.equal(h.calls.filter(c=>c.kind==='create').length,1);
});
test('local collision and revoked permission block bytes before upload',async()=>{
 for(const kind of ['primary','permission','membership']){
  const h=harness(),op=await h.service.begin(begin);
  if(kind==='primary')h.primary.add('host_alpha');if(kind==='permission')h.config.allowWrites=false;if(kind==='membership')h.env.projectId='proj_elsewhere';
  await assert.rejects(()=>h.service.upload({operationId:op.operationId,index:0,bytesBase64:bytes.toString('base64')}));assert.equal(h.calls.length,0);
 }
});
test('changed SSH destination invalidates prepared operation without bytes sent',async()=>{
 const h=harness(),op=await h.service.begin(begin);h.config.sshTarget='replacement';
 await assert.rejects(()=>h.service.upload({operationId:op.operationId,index:0,bytesBase64:bytes.toString('base64')}),/destination/);assert.equal(h.calls.length,0);
});
test('upload interruption or changed membership becomes uncertain and is never retried',async()=>{
 const h=harness(),op=await h.service.begin(begin);h.onUpload(()=>h.env.projectId='proj_elsewhere');
 const input={operationId:op.operationId,index:0,bytesBase64:bytes.toString('base64')};
 await assert.rejects(()=>h.service.upload(input));await assert.rejects(()=>h.service.upload(input));assert.equal(h.calls.length,1);assert.equal((await h.service.status(op)).state,'uncertain');
});
test('ambiguous create cannot be repeated, including after worker reload',async()=>{
 const h=harness(),op=await ready(h);h.setFail();await assert.rejects(()=>h.service.commit(op));
 const restarted=createHandoffs(h.deps);await assert.rejects(()=>restarted.commit(op),/uncertain/);assert.equal(h.calls.filter(c=>c.kind==='create').length,1);
});
test('returned ID is retained when a post-creation collision is detected',async()=>{
 const h=harness(),op=await ready(h);h.onCreate(()=>h.primary.add('thr_created'));await assert.rejects(()=>h.service.commit(op));
 assert.deepEqual({...await h.service.status(op),operationId:'masked'}, {...op,operationId:'masked',state:'uncertain',threadId:'thr_created',uploaded:1});
});
test('concurrent commit cannot start two models',async()=>{
 const h=harness(),op=await ready(h);const settled=await Promise.allSettled([h.service.commit(op),h.service.commit(op)]);
 assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);assert.equal(h.calls.filter(c=>c.kind==='create').length,1);
});
test('manifest cannot carry traversal, arbitrary RPC paths, oversized bytes or alternate project',()=>{
 assert.equal(handoffBeginSchema.safeParse({...begin,path:'/send'}).success,false);
 assert.equal(handoffBeginSchema.safeParse({...begin,projectId:'proj_personal'}).success,false);
 assert.equal(handoffBeginSchema.safeParse({...begin,files:[{...file,name:'../private.md'}]}).success,false);
 assert.throws(()=>handoffBytes({...file,projectId:'proj_alpha',bytesBase64:Buffer.from('other bytes').toString('base64')}),/integrity/);
 assert.throws(()=>handoffBytes({...file,name:'file.html',projectId:'proj_alpha',bytesBase64:bytes.toString('base64')}),/extension/);
});
