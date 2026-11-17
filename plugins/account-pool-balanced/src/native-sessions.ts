import {type NativeProbeInput,type NativeProbeLaunch,type NativeProbeResult,nativeProbeResultSchema} from './native-probe-wire.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import {accountProjectsSchema, type AccountProjects} from './contracts.js';
import {projectTier} from './project-policy.js';
import {nativeAccountRoutingSchema, nativeAccountUpdateSchema, type NativeAccountUpdate, nativeProjectsSchema, summarizeNativeAccounts} from './native-accounts.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const nativeExecutionSchema=z.object({
  runtimeId:id, gatewayId:id, runtimeSha256:z.string().regex(/^[a-f0-9]{64}$/),
  profile:z.object({id,version:z.number().int().positive()}).strict(),
}).strict();
export const nativeExecutorSchema = z.object({
  id, accountId: id, hostId: id,
  label:z.string().trim().min(1).max(120).optional(),
  // These are server-authenticated callers, never a host/project header.
  callerIds: z.array(id).min(1).max(16),
  catalogCallerIds: z.array(id).max(16).default([]),
  projectIds: z.array(id).min(1).max(32),
  projects: nativeProjectsSchema.optional(),
  autopilotAllowed: z.boolean().default(false),
  enabled: z.boolean().default(false),
  execution:nativeExecutionSchema.optional(),
  unlock:z.object({profile:id,operation:z.literal('prepared-native-keyring-unlock')}).strict().optional(),
}).strict();
type Executor = z.infer<typeof nativeExecutorSchema>;
export interface NativeCaller { hostId: string; projectId: string | null; threadId?: string; purpose?: 'autopilot' }
interface NativeReply {
  diagnostic?:NativeProbeInput&{sessionId:string;reservationId:string};
  released?:boolean;leaseId?:string;state?:'queued'|'active';ttlMs?:number;heartbeatMs?:number;accountId?:string;hostId?:string;
  binding?:z.infer<typeof nativeExecutionSchema>&{schema:'bb-account-pool/native-execution/1';leaseId:string;sessionId:string;executorId:string;accountId:string;hostId:string;kind:'task'|'catalog'|'diagnostic';caller:NativeCaller};
  unlock?:{mode:'automatic';state:string;requestId?:string;deadline?:number};
  requestId?:string;deadline?:number;stopped?:boolean;
}
function sameCaller(a:NativeCaller,b:NativeCaller){return a.hostId===b.hostId&&a.projectId===b.projectId&&a.threadId===b.threadId&&a.purpose===b.purpose;}
const leaseSchema = z.object({
  id: z.string().uuid(), sessionId: z.string().uuid(), executor: nativeExecutorSchema,
  kind: z.enum(['task','catalog','diagnostic']).default('task'),
  caller: z.object({hostId:id,projectId:id.nullable(),threadId:id.optional(),purpose:z.literal('autopilot').optional()}).strict(),
  state: z.enum(['queued','active','uncertain']), deadline: z.number(), createdAt: z.number(),
  unlock:z.object({requestId:z.string().uuid(),deadline:z.number(),state:z.enum(['issued','consumed','completed','uncertain'])}).strict().optional(),
}).strict();
type Lease = z.infer<typeof leaseSchema>;
const eventSchema = z.object({at:z.number(),event:z.enum(['queued','active','uncertain','released','cancelled','attested-stopped']),executorId:id,accountId:id,hostId:id,projectId:id.nullable()});
const stateSchema = z.object({
  managed:z.boolean(), executors:z.array(nativeExecutorSchema).max(32),
  preferredExecutors:z.record(id,id).refine(value=>Object.keys(value).length<=32).default({}),
  accountRouting:z.record(id,nativeAccountRoutingSchema).refine(value=>Object.keys(value).length<=32).default({}),
  leases:z.array(leaseSchema).max(128), events:z.array(eventSchema).max(256),
}).strict();
type State = z.infer<typeof stateSchema>;
interface Storage {get<T>(key:string):Promise<T|null|undefined>;set(key:string,value:unknown):Promise<void>}
const KEY='native-agy-sessions-v1';
export const NATIVE_LEASE_MS=30_000;
export const nativeRequestSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('acquire'),executorId:id,sessionId:z.string().uuid(),kind:z.enum(['task','catalog','diagnostic']).default('task')}).strict(),
  z.object({action:z.literal('poll'),leaseId:z.string().uuid()}).strict(),
  z.object({action:z.literal('unlock-start'),leaseId:z.string().uuid()}).strict(),
  z.object({action:z.literal('unlock-cancel'),leaseId:z.string().uuid()}).strict(),
  z.object({action:z.literal('release'),leaseId:z.string().uuid(),stopped:z.literal(true).optional(),completed:z.literal(true).optional()}).strict()
    .refine(value=>(value.stopped===true)!==(value.completed===true)),
]);
export class NativeSessionError extends Error {constructor(readonly status:number,readonly code:string){super(code);}}

/** Admission for official processes, not an OAuth or model proxy.
 * Expiry never frees an active slot: a disconnected process could still run.
 * Only acknowledged termination or explicit operator attestation releases it.
 */
export class NativeSessions {
  private state:State={managed:false,executors:[],leases:[],events:[],preferredExecutors:{},accountRouting:{}};
  private diagnostics=new Map<string,{input:NativeProbeInput;caller:NativeCaller;deadline:number;reservationId:string;sessionId?:string;finished?:boolean}>();
  private tail:Promise<unknown>=Promise.resolve();
  private failed=false;
  private unlockJobs=new Map<string,{abort:AbortController;done:Promise<void>}>();
  constructor(private storage:Storage,private now=Date.now,private admit: (hostId:string,caller:NativeCaller)=>Promise<void>=async()=>{},
    private validateExecution:(executor:Executor)=>void=executor=>{if(executor.execution)throw new NativeSessionError(503,'native-execution-unprepared');},
    private launchUnlock:(requestId:string,signal:AbortSignal)=>Promise<void>=async()=>{throw new NativeSessionError(503,'native-unlock-unavailable');}){}
  async initialize(){
    const stored=await this.storage.get(KEY);
    this.state=stored==null?this.state:stateSchema.parse(stored);
    // A plugin restart does not establish termination of remote children.
    for(const lease of this.state.leases)if(lease.state==='active')this.uncertain(lease);
    this.sweep();
    await this.storage.set(KEY,this.state);
  }
  managed(){return this.state.managed;}
  private async serial<T>(fn:()=>T|Promise<T>):Promise<T>{
    const run=this.tail.then(async()=>{
      if(this.failed)throw new NativeSessionError(503,'native-storage-unavailable');
      this.sweep();
      const result=await fn();
      try{await this.storage.set(KEY,structuredClone(this.state));}
      catch{this.failed=true;throw new NativeSessionError(503,'native-storage-unavailable');}
      return result;
    });
    this.tail=run.catch(()=>{});return run;
  }
  private event(lease:Lease,event:z.infer<typeof eventSchema>['event']){
    const now=this.now();
    this.state.events=this.state.events.filter(e=>e.at>now-14*86400000).slice(-255);
    this.state.events.push({at:now,event,executorId:lease.executor.id,accountId:lease.executor.accountId,hostId:lease.executor.hostId,projectId:lease.caller.projectId});
  }
  private uncertain(lease:Lease){lease.state='uncertain';this.event(lease,'uncertain');}
  private sweep(){
    const now=this.now();
    for(const lease of this.state.leases)if(lease.state==='active'&&lease.deadline<=now)this.uncertain(lease);
    this.state.leases=this.state.leases.filter(l=>l.state!=='queued'||l.deadline>now);
    this.state.events=this.state.events.filter(e=>e.at>now-14*86400000);
  }
  private allowed(executor:Executor,caller:NativeCaller,kind:'task'|'catalog'|'diagnostic'='task'){
    return (kind==='diagnostic'||executor.enabled)&&caller.projectId!==null&&(executor.projects ? (!executor.projects.onlySelected || executor.projects.rules.length === 0 || executor.projects.rules.some(rule => rule.projectId === caller.projectId)) : executor.projectIds.includes(caller.projectId))&&
      (kind==='catalog'?executor.catalogCallerIds:executor.callerIds).includes(caller.hostId)&&(!caller.purpose||executor.autopilotAllowed);
  }
  async available(caller:NativeCaller){return this.serial(()=>this.state.managed&&this.state.executors.some(e=>this.allowed(e,caller)));}
  async executorFor(caller:NativeCaller){return this.serial(()=>{
    const matches=this.state.executors.filter(e=>this.allowed(e,caller));
    return this.choose(matches,caller.projectId);
  });}
  async catalogExecutorFor(hostId:string){return this.serial(()=>{
    const matches=this.state.executors.filter(e=>e.enabled&&e.hostId===hostId&&e.catalogCallerIds.length>0);
    return this.choose(matches);
  });}
  private routing(executor:Executor) {
    return Object.hasOwn(this.state.accountRouting,executor.accountId)?this.state.accountRouting[executor.accountId]:{role:'primary' as const,priority:this.state.preferredExecutors[executor.hostId]===executor.id?0:10};
  }
  private choose(matches:Executor[],projectId:string|null=null){
    if(Object.keys(this.state.accountRouting).length && matches.length){
      const tier=(e:Executor)=>projectTier({...e,...this.routing(e)},projectId)??Infinity;
      const ordered=[...matches].sort((a,b)=>tier(a)-tier(b)||this.routing(a).priority-this.routing(b).priority);
      const best=ordered.filter(e=>tier(e)===tier(ordered[0])&&this.routing(e).priority===this.routing(ordered[0]).priority);
      if(best.length===1)return best[0].id;
      const preferred=best.filter(e=>this.state.preferredExecutors[e.hostId]===e.id);
      return preferred.length===1?preferred[0].id:null;
    }
    if(matches.length===1)return matches[0].id;
    const preferred=matches.filter(e=>this.state.preferredExecutors[e.hostId]===e.id);
    return preferred.length===1?preferred[0].id:null;
  }
  private selectionRevision(){return createHash('sha256').update(JSON.stringify([this.state.executors,this.state.preferredExecutors,this.state.accountRouting])).digest('hex');}
  async prefer(executorId:string,expectedRevision:string){return this.serial(()=>{
    if(this.selectionRevision()!==expectedRevision)throw new NativeSessionError(409,'native-selection-changed');
    const executor=this.state.executors.find(e=>e.id===executorId&&e.enabled);
    if(!executor)throw new NativeSessionError(404,'native-executor-not-found');
    this.state.preferredExecutors=Object.fromEntries(Object.entries(this.state.preferredExecutors)
      .filter(([hostId,id])=>this.state.executors.some(e=>e.id===id&&e.hostId===hostId)));
    this.state.preferredExecutors={...this.state.preferredExecutors,[executor.hostId]:executor.id};
    if(Object.keys(this.state.accountRouting).length){
      const priority=Math.max(-10000,Math.min(...this.state.executors.map(e=>this.routing(e).priority))-1);
      this.state.accountRouting={...this.state.accountRouting,[executor.accountId]:{...this.routing(executor),priority}};
    }
    return null;
  });}
  async configure(value:unknown){const executor=nativeExecutorSchema.parse(value);return this.serial(()=>{
    if(executor.unlock&&!executor.execution)throw new NativeSessionError(400,'native-unlock-unprepared');
    this.validateExecution(executor);
    const existing=this.state.executors.findIndex(e=>e.id===executor.id);
    if(this.state.leases.some(l=>l.executor.id===executor.id))throw new NativeSessionError(409,'native-executor-busy');
    if(existing<0){if(this.state.executors.length>=32)throw new NativeSessionError(409,'native-executor-limit');this.state.executors.push(executor);}
    else this.state.executors[existing]=executor;
    return executor;
  });}
  async setManaged(managed:boolean){return this.serial(()=>{this.state.managed=managed;return {managed};});}
  async setProjects(accountId:string, projects:AccountProjects, expectedRevision:string){
    const parsed=nativeProjectsSchema.parse(projects);
    if(parsed.rules.some(r=>r.role!=='inherit'))throw new NativeSessionError(400,'native-use-account-settings');
    return this.serial(()=>{
      const account=summarizeNativeAccounts(this.state).accounts.find(a=>a.accountId===accountId);
      if(!account)throw new NativeSessionError(404,'native-account-not-found');
      if(account.projectsRevision!==expectedRevision)throw new NativeSessionError(409,'native-projects-changed');
      if(this.state.leases.some(l=>l.executor.accountId===accountId))throw new NativeSessionError(409,'native-executor-busy');
      const next=this.state.executors.map(e=>e.accountId===accountId?{...e,projects:structuredClone(parsed)}:e);
      const scope=(e:Executor)=>e.projects ? (!e.projects.onlySelected||e.projects.rules.length===0?null:e.projects.rules.map(r=>r.projectId)) : e.projectIds;
      if(!Object.keys(this.state.accountRouting).length)for(let i=0;i<next.length;i++)for(let j=i+1;j<next.length;j++){
        const a=next[i],b=next[j];
        if(!a.enabled||!b.enabled||(a.accountId!==accountId&&b.accountId!==accountId))continue;
        if(!a.callerIds.some(id=>b.callerIds.includes(id))&&!a.catalogCallerIds.some(id=>b.catalogCallerIds.includes(id)))continue;
        const as=scope(a),bs=scope(b);
        if(as===null||bs===null||as.some(id=>bs.includes(id))){
          const preferred=next.find(e=>e.id===this.state.preferredExecutors[a.hostId]);
          if(a.hostId!==b.hostId||!preferred?.enabled||preferred.hostId!==a.hostId)throw new NativeSessionError(409,'native-projects-ambiguous');
          const ps=scope(preferred), overlap=as===null?bs:bs===null?as:as.filter(id=>bs.includes(id));
          if((overlap===null&&ps!==null)||(overlap!==null&&ps!==null&&overlap.some(id=>!ps.includes(id)))
            ||a.callerIds.some(id=>b.callerIds.includes(id)&&!preferred.callerIds.includes(id))
            ||a.catalogCallerIds.some(id=>b.catalogCallerIds.includes(id)&&!preferred.catalogCallerIds.includes(id))
            ||a.autopilotAllowed&&b.autopilotAllowed&&!preferred.autopilotAllowed)throw new NativeSessionError(409,'native-projects-ambiguous');
        }
      }
      this.state.executors=next;
      return null;
    });
  }
  async updateAccount(value:NativeAccountUpdate){
    const input=nativeAccountUpdateSchema.parse(value);
    return this.serial(()=>{
      if(input.expectedRevision!==this.selectionRevision())throw new NativeSessionError(409,'native-selection-changed');
      const group=this.state.executors.filter(e=>e.accountId===input.accountId);
      if(!group.length)throw new NativeSessionError(404,'native-account-not-found');
      if(input.executor&&!group.some(e=>e.id===input.executor!.id))throw new NativeSessionError(403,'native-executor-denied');
      if((input.projects||input.executor)&&this.state.leases.some(l=>l.executor.accountId===input.accountId))throw new NativeSessionError(409,'native-executor-busy');
      const previous=this.routing(group.find(e=>this.state.preferredExecutors[e.hostId]===e.id)??group[0]);
      const routing={...previous,role:input.role??previous.role,priority:input.priority??previous.priority,...(input.label?{label:input.label}:{})};
      const next=this.state.executors.map(e=>e.accountId!==input.accountId?e:{...e,
        ...(input.projects?{projects:structuredClone(input.projects)}:{}),
        ...(input.executor?.id===e.id?{
          ...(input.executor.enabled!==undefined?{enabled:input.executor.enabled}:{}),
          ...(input.executor.autopilotAllowed!==undefined?{autopilotAllowed:input.executor.autopilotAllowed}:{}),
        }:{}),
      });
      this.state.accountRouting={...this.state.accountRouting,[input.accountId]:routing};
      this.state.executors=next;
      return null;
    });
  }
  async accounts(){return this.serial(()=>({...summarizeNativeAccounts(this.state),selectionRevision:this.selectionRevision()}));}
  async snapshot(){return this.serial(()=>({managed:this.state.managed,preferredExecutors:this.state.preferredExecutors,executors:this.state.executors,
    leases:this.state.leases.map(({id,executor,caller,kind,state,deadline,createdAt})=>({id,executorId:executor.id,accountId:executor.accountId,hostId:executor.hostId,projectId:caller.projectId,kind,state,deadline,createdAt})),
    events:this.state.events,budget:'unknown' as const}));}
  async attestStopped(leaseId:string){return this.serial(()=>{
    const lease=this.state.leases.find(l=>l.id===leaseId);
    if(!lease||lease.state!=='uncertain')throw new NativeSessionError(409,'native-not-uncertain');
    this.event(lease,'attested-stopped');this.state.leases=this.state.leases.filter(l=>l!==lease);return {released:true};
  });}
  admissionCheck: () => void = () => {};
  async request(caller:NativeCaller,raw:unknown,diagnosticToken?:string):Promise<NativeReply>{const input=nativeRequestSchema.parse(raw);
    if(input.action!=='release'&&input.action!=='unlock-cancel')this.admissionCheck();
    if(diagnosticToken&&(input.action==='unlock-start'||input.action==='unlock-cancel'))throw new NativeSessionError(403,'native-diagnostic-only');
    if(input.action==='unlock-start')return this.startUnlock(caller,input.leaseId);
    if(input.action==='unlock-cancel')return this.cancelUnlock(caller,input.leaseId);
    const diagnostic=input.action==='acquire'?input.kind==='diagnostic':('leaseId' in input&&this.state.leases.some(l=>l.id===input.leaseId&&l.kind==='diagnostic'));
    const reservation=diagnosticToken?this.diagnostics.get(createHash('sha256').update(diagnosticToken).digest('hex')):undefined;
    if(diagnostic&&(!reservation||!sameCaller(reservation.caller,caller)||
      (input.action!=='release'&&reservation.deadline<=this.now())))throw new NativeSessionError(403,'native-diagnostic-denied');
    if(diagnostic&&'leaseId' in input&&this.owned(caller,input.leaseId).sessionId!==reservation?.sessionId)throw new NativeSessionError(403,'native-diagnostic-denied');
    if(reservation&&!diagnostic)throw new NativeSessionError(403,'native-diagnostic-only');
    let checkedHost:string|undefined;
    if(input.action!=='release'){
      if(!this.state.managed)throw new NativeSessionError(503,'native-not-managed');
      const previous=input.action==='poll'?this.owned(caller,input.leaseId):undefined;
      const executor=input.action==='acquire'?this.state.executors.find(e=>e.id===input.executorId):previous!.executor;
      if(!executor||!this.allowed(executor,caller,input.action==='acquire'?input.kind:previous!.kind))throw new NativeSessionError(403,'native-executor-denied');
      checkedHost=executor.hostId;
      // Do network I/O outside the serialization lane, then repeat policy below.
      await this.admit(checkedHost,caller);
    }
    return this.serial(()=>{
    if(input.action==='release'){
      const lease=this.owned(caller,input.leaseId);
      if(lease.unlock&&lease.unlock.state!=='completed')throw new NativeSessionError(409,'native-unlock-stop-unconfirmed');
      if(lease.state==='uncertain'&&!input.stopped)throw new NativeSessionError(409,'native-stop-unconfirmed');
      this.event(lease,lease.state==='queued'?'cancelled':'released');
      this.state.leases=this.state.leases.filter(l=>l!==lease);
      if(reservation?.finished&&diagnosticToken)this.diagnostics.delete(createHash('sha256').update(diagnosticToken).digest('hex'));
      return {released:true};
    }
    this.admissionCheck();
    if(!this.state.managed)throw new NativeSessionError(503,'native-not-managed');
    let lease:Lease;
    if(input.action==='acquire'){
      const executor=this.state.executors.find(e=>e.id===input.executorId);
      if(!executor||!this.allowed(executor,caller,input.kind))throw new NativeSessionError(403,'native-executor-denied');
      if(input.kind==='diagnostic'){
        if(reservation&&reservation.deadline<=this.now())throw new NativeSessionError(403,'native-diagnostic-expired');
        if(!reservation||reservation.sessionId||executor.id!==reservation.input.executorId||executor.accountId!==reservation.input.accountId||executor.hostId!==reservation.input.hostId)
          throw new NativeSessionError(403,'native-diagnostic-consumed');
        if(this.state.leases.some(l=>l.executor.accountId===executor.accountId))throw new NativeSessionError(409,'native-diagnostic-busy');
        reservation.sessionId=input.sessionId;
      }
      // Idempotent acquisition prevents losing a slot on an uncertain response.
      const existing=this.state.leases.find(l=>l.sessionId===input.sessionId&&sameCaller(l.caller,caller));
      if(existing&&(existing.executor.id!==executor.id||existing.kind!==input.kind))throw new NativeSessionError(409,'native-session-bound');
      if(existing)lease=existing;
      else{
        if(this.state.leases.length>=128)throw new NativeSessionError(429,'native-queue-full');
        const now=this.now();
        lease={id:randomUUID(),sessionId:input.sessionId,executor:structuredClone(executor),caller:structuredClone(caller),kind:input.kind,state:'queued',createdAt:now,deadline:now+NATIVE_LEASE_MS};
        this.state.leases.push(lease);this.event(lease,'queued');
      }
    }else lease=this.owned(caller,input.leaseId);
    if(lease.kind==='diagnostic'&&lease.sessionId!==reservation?.sessionId)throw new NativeSessionError(403,'native-diagnostic-denied');
    if(lease.state==='uncertain')throw new NativeSessionError(409,'native-stop-unconfirmed');
    const executor=this.state.executors.find(e=>e.id===lease.executor.id);
    if(!executor||executor.hostId!==checkedHost||!this.allowed(executor,caller,lease.kind))throw new NativeSessionError(403,'native-executor-denied');
    this.validateExecution(lease.executor);
    if(JSON.stringify(executor)!==JSON.stringify(lease.executor))throw new NativeSessionError(409,'native-executor-changed');
    const same=this.state.leases.filter(l=>l.executor.accountId===lease.executor.accountId);
    // One common account lane across all machines and purposes. Never preempt.
    if(lease.state==='queued'&&!same.some(l=>l.state!=='queued')&&same.find(l=>l.state==='queued')===lease){lease.state='active';this.event(lease,'active');}
    lease.deadline=this.now()+NATIVE_LEASE_MS;
    return {...(lease.kind==='diagnostic'?{diagnostic:{...reservation!.input,reservationId:reservation!.reservationId,sessionId:lease.sessionId}}:{}),leaseId:lease.id,state:lease.state,ttlMs:NATIVE_LEASE_MS,heartbeatMs:5000,accountId:lease.executor.accountId,hostId:lease.executor.hostId,
      ...(lease.executor.unlock?{unlock:{mode:'automatic' as const,state:lease.unlock?.state??'idle',...(lease.unlock?{requestId:lease.unlock.requestId,deadline:lease.unlock.deadline}:{})}}:{}),
      ...(lease.executor.execution?{binding:{schema:'bb-account-pool/native-execution/1' as const,
        leaseId:lease.id,sessionId:lease.sessionId,executorId:lease.executor.id,accountId:lease.executor.accountId,
        hostId:lease.executor.hostId,kind:lease.kind,caller:structuredClone(lease.caller),...structuredClone(lease.executor.execution)}}:{})};
  });}
  private currentUnlock(requestId:string){
    const lease=this.state.leases.find(l=>l.unlock?.requestId===requestId);
    const executor=lease&&this.state.executors.find(e=>e.id===lease.executor.id);
    if(!this.state.managed||!lease||lease.state!=='active'||lease.kind!=='task'||!lease.executor.execution||!lease.executor.unlock||
      !executor||!this.allowed(executor,lease.caller)||JSON.stringify(executor)!==JSON.stringify(lease.executor)||lease.unlock!.deadline<=this.now())
      throw new NativeSessionError(403,'native-unlock-denied');
    this.validateExecution(executor);return lease;
  }
  private async startUnlock(caller:NativeCaller,leaseId:string){
    await this.request(caller,{action:'poll',leaseId}); // Same admission/Guard checks, no new authority.
    const issued=await this.serial(()=>{
      this.admissionCheck();
      const lease=this.owned(caller,leaseId);
      if(!this.state.managed||lease.state!=='active'||lease.kind!=='task'||!lease.executor.execution||!lease.executor.unlock)
        throw new NativeSessionError(403,'native-unlock-denied');
      const executor=this.state.executors.find(e=>e.id===lease.executor.id);
      if(!executor||!this.allowed(executor,caller)||JSON.stringify(executor)!==JSON.stringify(lease.executor))
        throw new NativeSessionError(403,'native-unlock-denied');
      this.validateExecution(executor);
      if(lease.unlock)throw new NativeSessionError(409,'native-unlock-already-issued');
      lease.unlock={requestId:randomUUID(),deadline:Math.min(lease.deadline,this.now()+25_000),state:'issued'};
      return structuredClone(lease.unlock);
    });
    const abort=new AbortController();
    const timer=setTimeout(()=>abort.abort(),Math.max(1,issued.deadline-this.now()));
    const done=(async()=>{
      let completed=false;
      try{
        this.admissionCheck();
        await Promise.race([this.launchUnlock(issued.requestId,abort.signal),new Promise<never>((_,reject)=>{
          abort.signal.addEventListener('abort',()=>reject(new Error('native-unlock-cancelled')),{once:true});
        })]);completed=!abort.signal.aborted;
      }catch{/* No raw operation errors or credentials enter storage. */}
      finally{
        clearTimeout(timer);
        await this.serial(()=>{
          const lease=this.state.leases.find(l=>l.id===leaseId);
          if(!lease?.unlock)return;
          if(completed&&lease.state==='active'&&lease.unlock.state==='consumed'&&lease.unlock.deadline>this.now())lease.unlock.state='completed';
          else{lease.unlock.state='uncertain';if(lease.state!=='uncertain')this.uncertain(lease);}
        });
        this.unlockJobs.delete(leaseId);
      }
    })();
    this.unlockJobs.set(leaseId,{abort,done});void done.catch(()=>{});
    return {requestId:issued.requestId,deadline:issued.deadline};
  }
  /** Called only through the verified Oxi Op plugin RPC; locators are not authorization. */
  async claimUnlock(requestId:string){
    const before=this.currentUnlock(requestId);await this.admit(before.executor.hostId,before.caller);
    return this.serial(()=>{
      this.admissionCheck();
      const lease=this.currentUnlock(requestId);
      if(lease.unlock!.state!=='issued')throw new NativeSessionError(409,'native-unlock-consumed');
      lease.unlock!.state='consumed';
      return {requestId,deadline:lease.unlock!.deadline,profile:lease.executor.unlock!.profile,operation:lease.executor.unlock!.operation,
        binding:{schema:'bb-account-pool/native-execution/1' as const,leaseId:lease.id,sessionId:lease.sessionId,
          executorId:lease.executor.id,accountId:lease.executor.accountId,hostId:lease.executor.hostId,kind:'task' as const,
          caller:structuredClone(lease.caller),...structuredClone(lease.executor.execution!)}};
    });
  }
  private async cancelUnlock(caller:NativeCaller,leaseId:string){
    this.owned(caller,leaseId);
    const job=this.unlockJobs.get(leaseId);job?.abort.abort();
    if(job)await this.waitJobs([job.done]);
    return this.serial(()=>({stopped:this.owned(caller,leaseId).unlock?.state==='completed'}));
  }
  async preflight(input:NativeProbeInput,host:()=>Promise<{protocol:number}>){
    // Wait for pending transactions, then copy without sweep or storage writes.
    // Expired/queued/uncertain leases remain blockers until normal recovery.
    const state=await this.tail.then(()=>{
      if(this.failed)throw new NativeSessionError(503,'native-storage-unavailable');
      return structuredClone(this.state);
    });
    const target=state.executors.find(e=>e.id===input.executorId);
    const caller={hostId:input.hostId,projectId:input.projectId};
    const checks={managed:state.managed,target:!!target&&target.accountId===input.accountId&&target.hostId===input.hostId,
      policy:!!target&&this.allowed(target,caller,'diagnostic'),idle:!state.leases.some(l=>l.executor.accountId===input.accountId),
      maintenance:true,network:false,protocol:false,runtime:false};
    if(target){try{this.validateDiagnosticRuntime(target);checks.runtime=true;}catch{}}
    try{this.admissionCheck();}catch{checks.maintenance=false;}
    if(checks.target&&checks.policy&&checks.maintenance){try{await this.admit(input.hostId,caller);checks.network=true;}catch{}}
    if(checks.target){try{checks.protocol=(await host()).protocol===1;}catch{}}
    return {status:Object.values(checks).every(Boolean)?'ready':'blocked',providerInference:false,checks,
      preferredExecutors:state.preferredExecutors,target:input,
      leases:state.leases.filter(l=>l.executor.accountId===input.accountId).map(l=>({state:l.state,expired:l.deadline<=this.now()}))};
  }
  private validateDiagnosticRuntime(executor:Executor){
    if(executor.execution||executor.unlock)throw new NativeSessionError(503,'native-diagnostic-runtime-unavailable');
    this.validateExecution(executor);
  }
  async probe(input:NativeProbeInput,capable:()=>Promise<boolean>,launch:(request:NativeProbeLaunch)=>Promise<NativeProbeResult>):Promise<NativeProbeResult>{
    const result=(status:NativeProbeResult['status']):NativeProbeResult=>({...input,status,verified:false,observedAt:this.now(),catalog:[]});
    const caller:NativeCaller={hostId:input.hostId,projectId:input.projectId};
    const check=()=>{
      this.admissionCheck();
      const executor=this.state.executors.find(e=>e.id===input.executorId);
      if(!this.state.managed||!executor||executor.accountId!==input.accountId||executor.hostId!==input.hostId||!this.allowed(executor,caller,'diagnostic'))throw new NativeSessionError(403,'native-diagnostic-denied');
      // This implementation supports the fixed Linux host profile only. Prepared
      // Secret Service bindings must never be silently downgraded to this path.
      this.validateDiagnosticRuntime(executor);
      if(this.state.leases.some(l=>l.executor.accountId===input.accountId))throw new NativeSessionError(409,'native-diagnostic-busy');
    };
    if(this.diagnostics.size>=32)return result('not-started');
    try{await this.serial(check);}catch(error){if(error instanceof NativeSessionError&&error.code==='native-diagnostic-runtime-unavailable')return result('runtime-unavailable');throw error;}
    await this.admit(input.hostId,caller);
    if(!await capable())return result('runtime-unavailable');
    const token=randomBytes(32).toString('base64url'),key=createHash('sha256').update(token).digest('hex');
    const deadline=this.now()+120_000,reservationId=randomUUID();
    await this.serial(()=>{check();this.diagnostics.set(key,{input:structuredClone(input),caller,deadline,reservationId});});
    try{
      const response=nativeProbeResultSchema.parse(await launch({...input,protocol:1,token,reservationId,deadline}));
      if(['accountId','executorId','hostId','projectId','model'].some(k=>response[k as keyof NativeProbeResult]!==input[k as keyof NativeProbeInput]))throw Error('native-diagnostic-binding-changed');
      if(response.observedAt<deadline-120_000||response.observedAt>this.now()+5000)throw Error('native-diagnostic-stale');
      const reservation=this.diagnostics.get(key);
      if(!reservation?.sessionId)return result('not-started');
      if(this.state.leases.some(l=>l.sessionId===reservation.sessionId))return result('stop-unconfirmed');
      return response;
    }catch{return result(this.diagnostics.get(key)?.sessionId?'stop-unconfirmed':'not-started');}
    finally{
      // Retain authority solely to permit cleanup of an uncertain own lease;
      // an expired reservation cannot acquire, poll or start another process.
      const r=this.diagnostics.get(key);
      if(!r?.sessionId||!this.state.leases.some(l=>l.sessionId===r.sessionId))this.diagnostics.delete(key);
      else r.finished=true;
    }
  }
  diagnosticCaller(token:string){const r=this.diagnostics.get(createHash('sha256').update(token).digest('hex'));return r?.caller??null;}
  async close(){
    const jobs=[...this.unlockJobs.values()];for(const job of jobs)job.abort.abort();
    await this.waitJobs(jobs.map(j=>j.done));
  }
  private async waitJobs(jobs:Promise<void>[]){
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([Promise.allSettled(jobs),new Promise(resolve=>{timer=setTimeout(resolve,3000);})]);}
    finally{clearTimeout(timer);}
  }
  private owned(caller:NativeCaller,leaseId:string){
    const lease=this.state.leases.find(l=>l.id===leaseId);
    if(!lease||!sameCaller(lease.caller,caller))throw new NativeSessionError(403,'native-lease-denied');
    return lease;
  }
}

export async function nativeHttp(request:Request,sessions:NativeSessions,authenticate:(token:string|null)=>Promise<NativeCaller|null>){
  try{
    const bearer=request.headers.get('authorization');
    const token=bearer?.startsWith('Bearer ')?bearer.slice(7):null;
    const diagnosticCaller=token?sessions.diagnosticCaller(token):null;
    const caller=diagnosticCaller??await authenticate(token);
    if(!caller)return Response.json({error:'native-unauthorized'},{status:401});
    // Stream-bound input, independent of Content-Length and chunking.
    const reader=request.body?.getReader();let body='';let length=0;
    if(!reader)throw new NativeSessionError(400,'native-invalid-request');
    const chunks:Uint8Array[]=[];
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([(async()=>{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;
      if(length>4096)throw new NativeSessionError(413,'native-request-too-large');chunks.push(part.value);
    }})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new NativeSessionError(408,'native-request-timeout')),2000);})]);
    }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
    body=Buffer.concat(chunks).toString('utf8');
    return Response.json(await sessions.request(caller,JSON.parse(body),diagnosticCaller?token!:undefined));
  }catch(error){
    const known=error instanceof NativeSessionError;
    return Response.json({error:known?error.code:'native-invalid-request'},{status:known?error.status:400});
  }
}
