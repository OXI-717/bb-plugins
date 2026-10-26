import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { providerSchema } from './contracts.js';
export const MAX_ROWS=2048, TTL_MS=86400000, MAX_BYTES=2*1024*1024;
const number=z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const binding=(prefix:string)=>z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{6,32}$`)).nullable();
export const observationSchema=z.object({
 at:z.number().int().nonnegative(),requestId:z.string().uuid(),attempt:z.number().int().min(0).max(100000),
 event:z.enum(['request','attempt','upstream','local-held','hold','result','stream-end']),provider:providerSchema,
 accountId:z.string().uuid().nullable(),clientHash:z.string().regex(/^[a-f0-9]{24}$/).nullable(),projectId:binding('proj'),threadId:binding('thr'),
 model:z.enum(['gpt-6-astra','gpt-6.1-sol','gpt-6-sol','gpt-5.4','gpt-5.3-codex','claude-opus-4-6','claude-sonnet-4-6']).nullable(),
 modelFamily:z.enum(['fable','sonnet','opus','haiku','other']),status:z.number().int().min(100).max(599).nullable(),
 durationMs:number,inFlight:z.number().int().nonnegative(),accountInFlight:z.number().int().nonnegative(),retryAfterMs:number,retryAfterSupplied:z.boolean().nullable(),quotaEvidence:z.boolean().nullable(),
 holdSource:z.enum(['upstream429','upstream403','existing-hold']).nullable(),heldUntil:number,
 outcome:z.enum(['returned','error','canceled','complete','failed-over']).nullable(),
 failover:z.enum(['none','succeeded','failed']).nullable(),
 errorClass:z.enum(['upstream429','local-held','upstream403-hold','stream-error','request-error','canceled']).nullable(),
}).strip();
export type Observation=z.infer<typeof observationSchema>;
export type Trace=Pick<Observation,'requestId'|'provider'|'clientHash'|'projectId'|'threadId'|'model'|'modelFamily'>;
export function newTrace(provider:Observation['provider'],host:string,project:string|null,thread:string|null,model:unknown,family:Observation['modelFamily']):Trace {
 const parsed=observationSchema.shape.model.safeParse(model);
 return {requestId:randomUUID(),provider,clientHash:createHash('sha256').update(host).digest('hex').slice(0,24),
 projectId:binding('proj').safeParse(project).success?project:null,threadId:binding('thr').safeParse(thread).success?thread:null,
 model:parsed.success?parsed.data:null,modelFamily:family};
}
/** No disk I/O in record(): one bounded async snapshot at a time, outside forwarding. */
export class RequestJournal {
 private rows:Observation[]=[];
 private evicted=0;private failures=0;private dirty=false;private closed=false;
 private timer:ReturnType<typeof setTimeout>|null=null;private writing:Promise<void>|null=null;
 constructor(private readonly file:string,private readonly now=Date.now){}
 async initialize():Promise<void>{
  try {
   await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
   await fs.chmod(path.dirname(this.file),0o700);
   const stat=await fs.stat(this.file).catch(()=>null);
   if(stat!==null){
    if(stat.size>MAX_BYTES)throw Error('oversized journal');
    this.rows=z.object({rows:z.array(observationSchema).max(MAX_ROWS)}).parse(JSON.parse(await fs.readFile(this.file,'utf8'))).rows;
   }
  }catch{this.failures++;}
  this.prune();this.schedule();
 }
 record(input:unknown):void{
  try{
   const parsed=observationSchema.safeParse(input);if(!parsed.success||this.closed)return;
   this.prune();if(this.rows.length>=MAX_ROWS){this.rows.shift();this.evicted++;}
   this.rows.push(parsed.data);this.dirty=true;this.schedule();
  }catch{this.failures++;}
 }
 snapshot(){
  this.prune();const now=this.now();
  const minutes=new Map<number,{at:number;logicalRequests:number;attempts:number;upstream429:number;localHeld429:number;upstream403Holds:number}>();
  for(const r of this.rows){
   if(r.at<now-3600000)continue;
   const at=Math.floor(r.at/60000)*60000;
   const b=minutes.get(at)??{at,logicalRequests:0,attempts:0,upstream429:0,localHeld429:0,upstream403Holds:0};
   if(r.event==='request')b.logicalRequests++;if(r.event==='attempt')b.attempts++;
   if(r.event==='upstream'&&r.status===429)b.upstream429++;if(r.event==='local-held'&&r.status===429)b.localHeld429++;
   if(r.event==='hold'&&r.holdSource==='upstream403')b.upstream403Holds++;
   minutes.set(at,b);
  }
  return{schema:'bb-account-pool/request-observations/1',coverage:'retained-events-only',maxRows:MAX_ROWS,retentionMs:TTL_MS,
   evictedSinceStart:this.evicted,storageFailuresSinceStart:this.failures,oldestAt:this.rows[0]?.at??null,truncated:this.evicted>0||this.rows.length===MAX_ROWS,
   observedAt:now,minutes:[...minutes.values()].sort((a,b)=>a.at-b.at),rows:[...this.rows]};
 }
 private prune():void{
  const now=this.now(),retained=this.rows.filter(r=>r.at>=now-TTL_MS&&r.at<=now);
  if(retained.length!==this.rows.length){this.evicted+=this.rows.length-retained.length;this.rows=retained;this.dirty=true;}
 }
 private schedule():void{
  if(this.timer!==null||this.closed)return;
  this.timer=setTimeout(()=>{this.timer=null;void this.flush().finally(()=>this.schedule());},1000);this.timer.unref();
 }
 async flush():Promise<void>{
  if(this.writing!==null)return this.writing;this.prune();if(!this.dirty)return;this.dirty=false;
  this.writing=(async()=>{try{
   const text=JSON.stringify({rows:this.rows});if(Buffer.byteLength(text)>MAX_BYTES)throw Error('oversized journal');
   await fs.writeFile(this.file+'.tmp',text,{mode:0o600});await fs.chmod(this.file+'.tmp',0o600);await fs.rename(this.file+'.tmp',this.file);
  }catch{this.failures++;}})();
  try{await this.writing;}finally{this.writing=null;}
 }
 async close():Promise<void>{this.closed=true;if(this.timer!==null)clearTimeout(this.timer);await this.writing;await this.flush();}
}
