import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {handoffBeginSchema,handoffTargetSchema,handoffAttachmentSchema,handoffResultSchema} from './handoff-contract.ts';
import {handoffBytes} from './handoff-upload.ts';
import type {RemoteConfig} from './configuration.ts';

type Target=z.infer<typeof handoffTargetSchema>;
type Begin=z.infer<typeof handoffBeginSchema>;
type Attachment=z.infer<typeof handoffAttachmentSchema>;
type Result=z.infer<typeof handoffResultSchema>;
type RecordState={input:Begin,fingerprint:string,createdAt:number,result:Result,attachments:Attachment[]};
type Reply={status:number,bodyBase64:string};
export type HandoffDeps={
 configurations:()=>Promise<{enabled:boolean,servers:RemoteConfig[]}>,
 selected:(id:string)=>Promise<RemoteConfig>,exclusive:(c:RemoteConfig,ids:string[])=>Promise<void>,
 get:(c:RemoteConfig,path:string)=>Promise<any>,
 upload:(c:RemoteConfig,input:any)=>Promise<Reply>,
 create:(c:RemoteConfig,body:string)=>Promise<Reply>,
 load:(id:string)=>Promise<RecordState|null|undefined>,save:(id:string,value:RecordState)=>Promise<void>,
};
export function createHandoffs(d:HandoffDeps){
 const busy=new Set<string>();
 const fingerprint=(c:RemoteConfig)=>JSON.stringify(c);
 const parseReply=(r:Reply)=>{if(r.status<200||r.status>=300)throw Error(`Remote API ${r.status}`);return JSON.parse(Buffer.from(r.bodyBase64,'base64').toString('utf8'));};
 async function authorize(target:Target){
  const c=await d.selected(target.serverId);
  if(!c.allowWrites||c.projectId!==target.projectId)throw Error('Remote handoff is not permitted for this project');
  await d.exclusive(c,[target.projectId,target.hostId,target.environmentId]);
  const env=await d.get(c,`/api/v1/environments/${target.environmentId}`);
  if(env.id!==target.environmentId||env.projectId!==target.projectId||env.hostId!==target.hostId||env.status!=='ready')throw Error('Remote environment changed or is not ready');
  const host=await d.get(c,`/api/v1/hosts/${target.hostId}`);
  if(host.id!==target.hostId||host.status!=='connected')throw Error('Remote machine is not connected');
  if(fingerprint(await d.selected(c.serverId))!==fingerprint(c))throw Error('Federation configuration changed');
  return c;
 }
 async function current(record:RecordState){
  if(Date.now()-record.createdAt>60*60*1000)throw Error('Transfer expired; inspect its status before preparing another');
  const c=await authorize(record.input);
  if(fingerprint(c)!==record.fingerprint)throw Error('Transfer destination or permissions changed');
  return c;
 }
 async function read(operationId:string){
  if(!z.string().uuid().safeParse(operationId).success)throw Error('Invalid transfer ID');
  const row=await d.load(operationId);if(!row)throw Error('Unknown transfer');return row;
 }
 async function locked<T>(id:string,fn:()=>Promise<T>):Promise<T>{
  if(busy.has(id))throw Error('Transfer already in progress');
  busy.add(id);try{return await fn();}finally{busy.delete(id);}
 }
 async function options(raw:Target&{providerId?:string}){
  const target=handoffTargetSchema.parse({serverId:raw.serverId,projectId:raw.projectId,hostId:raw.hostId,environmentId:raw.environmentId});
  const c=await authorize(target),query=new URLSearchParams({environmentId:target.environmentId});
  const providers=await d.get(c,`/api/v1/system/providers?${query}`);
  let models:any[]=[];
  if(raw.providerId){
   if(!Array.isArray(providers)||!providers.some(p=>p.id===raw.providerId&&p.available===true))throw Error('Remote provider unavailable');
   query.set('providerId',raw.providerId);
   models=(await d.get(c,`/api/v1/system/execution-options?${query}`)).models;
  }
  if(fingerprint(await authorize(target))!==fingerprint(c))throw Error('Federation configuration changed');
  return {providers,models};
 }
 return {
  async targets(){
   const all=await d.configurations();if(!all.enabled)return [];
   return Promise.all(all.servers.map(async c=>{
    const row={serverId:c.serverId,label:c.label,projectId:c.projectId,available:false,targets:[] as Array<{hostId:string,hostName:string,environmentId:string,path:string|null}>};
    if(!c.allowWrites)return row;
    try{
     await d.exclusive(c,[c.projectId]);
     const [hosts,envs]=await Promise.all([d.get(c,'/api/v1/hosts'),d.get(c,`/api/v1/environments?projectId=${c.projectId}`)]);
     for(const env of envs){
      if(!/^env_[a-z0-9]+$/.test(env.id)||!/^host_[a-z0-9]+$/.test(env.hostId)||env.projectId!==c.projectId||env.status!=='ready')continue;
      const host=hosts.find((h:any)=>h.id===env.hostId&&h.status==='connected');if(!host)continue;
      await d.exclusive(c,[env.id,host.id]);
      row.targets.push({hostId:host.id,hostName:typeof host.name==='string'?host.name:host.id,environmentId:env.id,path:typeof env.path==='string'?env.path:null});
     }
     if(fingerprint(await d.selected(c.serverId))!==fingerprint(c))throw Error('Federation configuration changed');
     row.available=true;
    }catch{row.targets=[];}
    return row;
   }));
  },
  options,
  async begin(raw:unknown){
   const input=handoffBeginSchema.parse(raw),c=await authorize(input),catalog=await options(input);
   const model=catalog.models.find(m=>m.model===input.model);
   if(!model||input.reasoningLevel&&!model.supportedReasoningEfforts?.some((e:any)=>e.reasoningEffort===input.reasoningLevel))throw Error('Remote model or effort unavailable');
   if(fingerprint(await authorize(input))!==fingerprint(c))throw Error('Federation configuration changed');
   const operationId=randomUUID(),result:Result={operationId,state:'prepared',serverId:input.serverId,projectId:input.projectId,hostId:input.hostId,environmentId:input.environmentId,threadId:null,uploaded:0};
   await d.save(operationId,{input,fingerprint:fingerprint(c),createdAt:Date.now(),result,attachments:[]});return result;
  },
  async upload({operationId,index,bytesBase64}:{operationId:string,index:number,bytesBase64:string}){
   return locked(operationId,async()=>{
    const row=await read(operationId);
    if(!['prepared','ready'].includes(row.result.state)||index!==row.attachments.length)throw Error('Transfer cannot repeat or skip an upload; inspect status');
    const file=row.input.files[index];if(!file)throw Error('File index outside manifest');
    const input={...file,projectId:row.input.projectId,bytesBase64};handoffBytes(input);
    const c=await current(row);
    row.result.state='uploading';await d.save(operationId,row);
    try{
     const uploaded=handoffAttachmentSchema.parse(parseReply(await d.upload(c,input)));
     if(uploaded.sourceProjectId!==row.input.projectId||uploaded.sizeBytes!==file.sizeBytes||uploaded.mimeType!==file.mimeType||uploaded.type!==(file.mimeType.startsWith('image/')?'localImage':'localFile'))throw Error('Invalid uploaded attachment metadata');
     await current(row);row.attachments.push(uploaded);row.result.uploaded=row.attachments.length;row.result.state='ready';await d.save(operationId,row);return row.result;
    }catch(e){row.result.state='uncertain';await d.save(operationId,row);throw e;}
   });
  },
  async commit({operationId}:{operationId:string}){
   return locked(operationId,async()=>{
    const row=await read(operationId);
    if(row.result.state==='complete')return row.result;
    if(row.result.state!=='ready'||row.attachments.length!==row.input.files.length)throw Error('Transfer is incomplete or its outcome is uncertain; creation will not be repeated');
    const c=await current(row),input=row.input;
    const body=JSON.stringify({projectId:input.projectId,providerId:input.providerId,model:input.model,
     ...(input.reasoningLevel?{reasoningLevel:input.reasoningLevel}:{}),origin:'sdk',title:input.title,
     environment:{type:'reuse',environmentId:input.environmentId},
     input:[{type:'text',text:input.prompt},...row.attachments],
     executionInputSources:{providerId:'explicit',model:'explicit',...(input.reasoningLevel?{reasoningLevel:'explicit'}:{})},
    });
    row.result.state='creating';await d.save(operationId,row);
    try{
     const thread=parseReply(await d.create(c,body));
     if(!/^thr_[a-z0-9]+$/.test(thread.id)||thread.projectId!==input.projectId||thread.environmentId!==input.environmentId)throw Error('Invalid created thread identity; inspect remote server');
     // Preserve the known remote ID even if a later ownership/config check fails.
     row.result.threadId=thread.id;await d.save(operationId,row);
     await d.exclusive(c,[thread.id]);await current(row);
     row.result.state='complete';await d.save(operationId,row);return row.result;
    }catch(e){row.result.state='uncertain';await d.save(operationId,row);throw e;}
   });
  },
  async status({operationId}:{operationId:string}){return (await read(operationId)).result;},
 };
}
