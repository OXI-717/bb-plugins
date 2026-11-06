import { z } from 'zod';
import { ProxyAgent } from 'undici';
import type { PoolKvStorage } from './core-storage.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const egressProfileSchema = z.object({
  id, version: z.number().int().positive(), label: z.string().min(1).max(120),
  node: id, hostIds: z.array(id).min(1).max(32),
  transport: z.literal('ssh-connect'),
  // A fleet-owned SSH LocalForward. Never a credential-bearing public proxy.
  endpoint: z.string().url().refine(value => {
    const u = new URL(value);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && !!u.port &&
      !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash;
  }),
  dns: z.literal('remote'), ipv4: z.literal(true), ipv6: z.literal(false),
  failure: z.literal('closed'),
  expectedExit: z.array(z.ipv4()).min(1).max(16),
  assurance: z.literal('proxy-enforced'),
}).strict();
export type EgressProfile = z.infer<typeof egressProfileSchema>;
const refSchema = z.object({id, version:z.number().int().positive()}).strict();
export const egressStateSchema = z.object({schema:z.literal(1),profiles:z.array(egressProfileSchema).max(128),
  bindings:z.record(z.string().uuid(),refSchema),
  pins:z.record(z.string().max(2048),z.object({accountId:z.string().uuid(),ref:refSchema}).strict()).default({}),
  // Absence of a profile is also an immutable route decision. Keep it per
  // account so unassigned providers retain their existing selection policy.
  unassigned:z.record(z.string().max(2048),z.array(z.string().uuid()).min(1).max(128)).default({}),
}).strict();
export class EgressUnavailable extends Error {
  readonly code = 'POOL_EGRESS_UNAVAILABLE';
  constructor(){super('Assigned account egress unavailable; no fallback or replay.');}
}
export interface AccountRoute {
  assigned:boolean;
  profile:Readonly<EgressProfile>|null;
  fetch(ipv4:boolean):typeof fetch|undefined;
}

/** Server-owned selection, never read from client headers or model names. */
export class AccountEgress {
  private state:z.infer<typeof egressStateSchema> = {schema:1,profiles:[],bindings:{},pins:{},unassigned:{}};
  private readonly agents = new Map<string,ProxyAgent>();
  private readonly sessions = new Map<string,{accountId:string;route:AccountRoute}>();
  private mutation:Promise<unknown> = Promise.resolve();
  constructor(private readonly kv:PoolKvStorage,private readonly hostId:()=>Promise<string>,
    private readonly accountExists:(id:string)=>Promise<boolean>){}
  async initialize(){const stored=await this.kv.get('account-egress-v1');if(stored!==undefined)this.state=egressStateSchema.parse(stored);}
  snapshot(){return structuredClone(this.state);}
  private update(change:()=>Promise<void>){
    const next=this.mutation.then(change);this.mutation=next.catch(()=>undefined);return next;
  }
  configure(input:unknown){return this.update(async()=>{
    const profile=egressProfileSchema.parse(input);
    const old=this.state.profiles.find(p=>p.id===profile.id&&p.version===profile.version);
    if(old && JSON.stringify(old)!==JSON.stringify(profile))throw new Error('Egress versions are immutable.');
    if(old)return;
    const next=egressStateSchema.parse({...this.state,profiles:[...this.state.profiles,profile]});
    await this.kv.set('account-egress-v1',next);this.state=next;
  });}
  bind(accountId:string,ref:z.infer<typeof refSchema>|null){return this.update(async()=>{
    z.string().uuid().parse(accountId);
    if(!await this.accountExists(accountId))throw Error('Account unavailable or its native transport is not supported.');
    const bindings={...this.state.bindings};
    if(ref===null)delete bindings[accountId];else{
      const parsed=refSchema.parse(ref);
      if(!this.state.profiles.some(p=>p.id===parsed.id&&p.version===parsed.version))throw Error('Configure the egress version first.');
      bindings[accountId]=parsed;
    }
    const next=egressStateSchema.parse({...this.state,bindings});
    await this.kv.set('account-egress-v1',next);this.state=next;
  });}
  async acquire(accountId:string,sessionKey?:string|null):Promise<AccountRoute>{
    const old=sessionKey?this.sessions.get(sessionKey):undefined;
    if(old){if(old.accountId!==accountId || old.route.profile && !old.route.profile.hostIds.includes(await this.hostId()))throw new EgressUnavailable();return old.route;}
    const pin=sessionKey?this.state.pins[sessionKey]:undefined;
    if(pin && pin.accountId!==accountId)throw new EgressUnavailable();
    const previousUnassigned=sessionKey && this.state.unassigned[sessionKey]?.includes(accountId);
    const ref=pin?.ref??(previousUnassigned?undefined:this.state.bindings[accountId]);
    let route:AccountRoute={assigned:false,profile:null,fetch:()=>undefined};
    if(ref){
      const value=this.state.profiles.find(p=>p.id===ref.id&&p.version===ref.version);
      if(!value || !value.hostIds.includes(await this.hostId()))throw new EgressUnavailable();
      const profile=Object.freeze(structuredClone(value));
      const key=JSON.stringify(profile);
      let agent=this.agents.get(key);
      if(!agent){agent=new ProxyAgent({uri:profile.endpoint,allowH2:false});this.agents.set(key,agent);}
      const dispatcher=agent;
      const send:typeof fetch=async(input,init)=>{
        const url=new URL(input instanceof Request?input.url:String(input));
        if(!profile.hostIds.includes(await this.hostId()) || url.protocol!=='https:' || url.hostname.includes(':'))throw new EgressUnavailable();
        try{return await fetch(input,{...init,redirect:'error',dispatcher} as RequestInit);}
        catch{throw new EgressUnavailable();}
      };
      route={assigned:true,profile,fetch:()=>send};
    }
    // Pins survive settings edits. Bounded refusal does not evict warm sessions.
    // Providers outside central egress retain their policy even at capacity.
    if(sessionKey && (ref || await this.accountExists(accountId))){
      await this.update(async()=>{
        const prior=this.state.pins[sessionKey];
        if(prior && (prior.accountId!==accountId || prior.ref?.id!==ref?.id || prior.ref?.version!==ref?.version))throw new EgressUnavailable();
        const unassigned=this.state.unassigned[sessionKey]??[];
        if(!prior && (ref || !unassigned.includes(accountId))){
          const count=Object.keys(this.state.pins).length+Object.values(this.state.unassigned).reduce((n,accounts)=>n+accounts.length,0);
          if(count>=4096 || !ref && unassigned.length>=128)throw new EgressUnavailable();
          const next=ref
            ? {...this.state,pins:{...this.state.pins,[sessionKey]:{accountId,ref}}}
            : {...this.state,unassigned:{...this.state.unassigned,[sessionKey]:[...unassigned,accountId]}};
          await this.kv.set('account-egress-v1',next);this.state=next;
        }
        if(ref)this.sessions.set(sessionKey,{accountId,route});
      });
    }
    return route;
  }
  async close(){await Promise.all([...this.agents.values()].map(a=>a.destroy()));}
}
