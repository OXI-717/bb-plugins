import {z} from 'zod';
import {expect,it} from 'vitest';
import {AccountEgress} from './account-egress.js';
import {parseProxyUrl} from './proxy-secrets.js';
// Frozen schema from account-pool-balanced/v0.4.88 for rollback acceptance.
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const sshProfileSchema = z.object({
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
const httpProfileSchema = z.object({
  id, version:z.number().int().positive(),label:z.string().min(1).max(120),
  hostIds:z.array(id).min(1).max(32),transport:z.literal('http-connect'),
  endpoint:z.string().max(2048).refine(value=>{try{const u=parseProxyUrl(value);return !u.username&&!u.password;}catch{return false;}}),
  secretRef:z.string().uuid(), failure:z.literal('closed'),
}).strict();
const egressProfileSchema=z.discriminatedUnion('transport',[sshProfileSchema,httpProfileSchema]);
const accountProxyInputSchema=z.object({accountId:z.string().uuid(),url:z.string().min(1).max(4096)}).strict();
type EgressProfile = z.infer<typeof egressProfileSchema>;
const refSchema = z.object({id, version:z.number().int().positive()}).strict();
const egressStateSchema = z.object({schema:z.literal(1),profiles:z.array(egressProfileSchema).max(128),
  bindings:z.record(z.string().uuid(),refSchema),
  pins:z.record(z.string().max(2048),z.object({accountId:z.string().uuid(),ref:refSchema}).strict()).default({}),
  // Absence of a profile is also an immutable route decision. Keep it per
  // account so unassigned providers retain their existing selection policy.
  unassigned:z.record(z.string().max(2048),z.array(z.string().uuid()).min(1).max(128)).default({}),
  assignmentBlocked:z.boolean().default(false),
}).strict();

it('accepts newly persisted decisions with the 0.4.88 schema',async()=>{
 const records=new Map<string,unknown>();
 const kv={get:async(k:string)=>records.get(k),set:async(k:string,v:unknown)=>{records.set(k,v);},delete:async(k:string)=>{records.delete(k);},list:async()=>[...records.keys()]};
 const e=new AccountEgress(kv,async()=>'fixture-host',async()=>true);
 await e.acquire('11111111-1111-4111-8111-111111111111','conversation');
 await e.configure({id:'fixture-proxy',version:1,label:'Fixture',hostIds:['fixture-host'],transport:'http-connect',endpoint:'http://proxy.example.test:8080/',secretRef:'22222222-2222-4222-8222-222222222222',failure:'closed'});
 // Persisted profile/binding shapes also remain accepted by the old parser.
 await e.bind('11111111-1111-4111-8111-111111111111',{id:'fixture-proxy',version:1});
 const state=records.get('account-egress-v1') as any;
 state.pins.home={accountId:'11111111-1111-4111-8111-111111111111',ref:{id:'fixture-proxy',version:1}};
 expect(egressStateSchema.parse(records.get('account-egress-v1'))).toEqual(records.get('account-egress-v1'));
 await e.close();
});
