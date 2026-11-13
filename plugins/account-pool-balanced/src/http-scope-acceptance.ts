import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolKvStorage } from './core-storage.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const time = z.number().int().nonnegative();
const ref = z.object({id:name, version:z.number().int().positive()}).strict();
const binding = z.object({
  accountId:z.string().uuid(), hostId:name, profile:ref, profileFingerprint:digest,
}).strict();
export const httpScopeAcceptInputSchema = binding.extend({
  receiptDigest:digest, configDigest:digest, authGeneration:name,
  expectedExit:z.array(z.ipv4()).min(1).max(16).transform(v=>[...new Set(v)].sort()),
  checkedAt:time, expiresAt:time,
}).strict().refine(v=>v.expiresAt>v.checkedAt && v.expiresAt-v.checkedAt<=900_000,
  'Acceptance must expire within fifteen minutes');
export const httpScopeRevokeInputSchema = binding.extend({acceptanceId:z.string().uuid()}).strict();
const recordSchema = z.object({
  acceptanceId:z.string().uuid(), input:httpScopeAcceptInputSchema, revoked:z.boolean(),
}).strict();
export type HttpScopeAcceptance = z.infer<typeof httpScopeAcceptInputSchema>;
// Code-owned live enforcement capability. Operator receipt/config/readiness is not this source.
export type HttpScopeEnforcementSource = ((acceptance:Readonly<HttpScopeAcceptance>)=>unknown) & {
  prepare?:(acceptance:Readonly<HttpScopeAcceptance>)=>Promise<void>;
};
const enforcementSchema = binding.extend({
  state:z.literal('connected'), assurance:z.literal('vpn-enforced'),
  receiptDigest:digest, configDigest:digest, authGeneration:name,
  dns:z.literal('remote'), ipv6:z.literal('deny'), tunnelLoss:z.literal('closed'),
  noDirect:z.literal(true), exitIp:z.ipv4(), observedAt:time, expiresAt:time,
}).strict();
const storageSchema = z.object({schema:z.literal(1),records:z.array(recordSchema).max(128)}).strict();
const key = (v:z.infer<typeof binding>)=>JSON.stringify([v.accountId,v.hostId,v.profile.id,v.profile.version]);
export const profileFingerprint = (profile:unknown)=>createHash('sha256').update(JSON.stringify(profile)).digest('hex');

/** Bounded declarations plus a separate synchronous enforcement source; deny without both. */
export class HttpScopeAcceptances {
  private records = new Map<string,z.infer<typeof recordSchema>>();
  private writes:Promise<unknown> = Promise.resolve();
  constructor(private readonly kv:PoolKvStorage, private readonly now:()=>number,
    private readonly enforcement?:HttpScopeEnforcementSource) {}
  async initialize() {
    const stored=await this.kv.get('account-egress-scope-v1');
    if(stored===undefined)return;
    const parsed=storageSchema.parse(stored), records=new Map<string,z.infer<typeof recordSchema>>();
    for(const r of parsed.records){if(records.has(key(r.input)))throw Error('Duplicate scope acceptance');records.set(key(r.input),r);}
    this.records=records;
  }
  private write<T>(change:()=>Promise<T>):Promise<T> {
    const next=this.writes.then(change);this.writes=next.catch(()=>undefined);return next;
  }
  private persist(records:typeof this.records) {
    return this.kv.set('account-egress-scope-v1',{schema:1,records:[...records.values()]});
  }
  accept(value:unknown) {return this.write(async()=>{
    const input=httpScopeAcceptInputSchema.parse(value), now=this.now();
    if(!Number.isFinite(now)||input.checkedAt>now||now>=input.expiresAt)throw Error('Acceptance is not current');
    const next=new Map(this.records), acceptanceId=randomUUID();
    if(!next.has(key(input))&&next.size>=128)throw Error('Scope acceptance capacity reached');
    next.set(key(input),{acceptanceId,input,revoked:false});
    await this.persist(next);this.records=next;
    // A saved declaration never installs an enforcement source or proves VPN.
    try {await this.enforcement?.prepare?.(structuredClone(input));}catch{/* stored declaration remains denied */}
    return {acceptanceId,active:this.allowed(input,this.now())};
  });}
  revoke(value:unknown) {return this.write(async()=>{
    const input=httpScopeRevokeInputSchema.parse(value), record=this.records.get(key(input));
    if(!record||record.acceptanceId!==input.acceptanceId||record.input.profileFingerprint!==input.profileFingerprint)
      throw Error('Scope acceptance changed or unavailable');
    const next=new Map(this.records);next.set(key(input),{...record,revoked:true});
    // Refusal takes effect before durable I/O; a failed write cannot reopen this process.
    this.records=next;await this.persist(next);
  });}
  async prepare(value:z.infer<typeof binding>):Promise<void> {
    const record=this.records.get(key(value));
    if(record&&!record.revoked&&record.input.profileFingerprint===value.profileFingerprint)
      await this.enforcement?.prepare?.(structuredClone(record.input));
  }
  allowed(value:z.infer<typeof binding>, now:number):boolean {
    try {
      const record=this.records.get(key(value)), a=record?.input;
      if(!record||record.revoked||!a||!Number.isFinite(now)||now<a.checkedAt||now>=a.expiresAt||
        a.profileFingerprint!==value.profileFingerprint||!this.enforcement)return false;
      const parsed=enforcementSchema.safeParse(this.enforcement(structuredClone(a)));
      if(!parsed.success)return false;
      const live=parsed.data;
      return key(live)===key(a)&&live.profileFingerprint===a.profileFingerprint&&
        live.receiptDigest===a.receiptDigest&&live.configDigest===a.configDigest&&live.authGeneration===a.authGeneration&&
        live.observedAt>=a.checkedAt&&live.observedAt<=now&&now<live.expiresAt&&
        live.expiresAt-live.observedAt<=30_000&&now-live.observedAt<=30_000&&a.expectedExit.includes(live.exitIp);
    } catch {return false;}
  }
}
