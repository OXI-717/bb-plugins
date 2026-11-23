import { expect, it } from 'vitest';
import { HttpScopeAcceptances, type HttpScopeAcceptance } from './http-scope-acceptance.js';
import type { PoolKvStorage } from './core-storage.js';

const accountId='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const input:HttpScopeAcceptance={accountId,hostId:'host-one',profile:{id:'corporate',version:1},
  profileFingerprint:'a'.repeat(64),receiptDigest:'b'.repeat(64),configDigest:'c'.repeat(64),
  authGeneration:'auth-one',expectedExit:['192.0.2.1'],checkedAt:1000,expiresAt:60000};
const live=()=>({...input,expectedExit:undefined,state:'connected',assurance:'vpn-enforced',
  dns:'remote',ipv6:'deny',tunnelLoss:'closed',noDirect:true,exitIp:'192.0.2.1',observedAt:1000,expiresAt:20000});
function evidence(){const {expectedExit,checkedAt,...result}=live();return result;}
function storage():PoolKvStorage {
  const map=new Map<string,unknown>();return {get:async k=>structuredClone(map.get(k)),
    set:async(k,v)=>{map.set(k,structuredClone(v));},delete:async k=>{map.delete(k);},list:async()=>[...map.keys()]};
}
it('a declaration without an independent enforcement source never activates, including after restart',async()=>{
  const kv=storage(),a=new HttpScopeAcceptances(kv,()=>1000);
  expect((await a.accept(input)).active).toBe(false);expect(a.allowed(input,1000)).toBe(false);
  const restarted=new HttpScopeAcceptances(kv,()=>1000);await restarted.initialize();
  expect(restarted.allowed(input,1000)).toBe(false);
});
it('allows a matching synthetic source, expires and revokes synchronously across warm lookups and restart',async()=>{
  const kv=storage(),a=new HttpScopeAcceptances(kv,()=>1000,evidence);
  const {acceptanceId,active}=await a.accept(input);expect(active).toBe(true);
  expect(a.allowed(input,999)).toBe(false);expect(a.allowed(input,20000)).toBe(false);
  expect(a.allowed(input,input.expiresAt)).toBe(false);
  await expect(a.revoke({...input,acceptanceId})).rejects.toThrow(); // strict binding only
  const {accountId,hostId,profile,profileFingerprint}=input;
  await a.revoke({accountId,hostId,profile,profileFingerprint,acceptanceId});
  expect(a.allowed(input,1000)).toBe(false);
  const restarted=new HttpScopeAcceptances(kv,()=>1000,evidence);await restarted.initialize();
  expect(restarted.allowed(input,1000)).toBe(false);
});
it.each([
  {accountId:other},{hostId:'host-two'},{profile:{id:'other',version:1}},
  {profile:{id:'corporate',version:2}},{profileFingerprint:'d'.repeat(64)},
  {receiptDigest:'d'.repeat(64)},{configDigest:'d'.repeat(64)},{authGeneration:'auth-two'},
  {state:'unknown'},{assurance:'invalid_evidence'},{dns:'local'},{ipv6:'allow'},
  {tunnelLoss:'open'},{noDirect:false},{exitIp:'192.0.2.2'},
  {observedAt:1001},{observedAt:0},{expiresAt:1000},{expiresAt:32000},
])('rejects a changed, stale or non-enforced source: %j',async change=>{
  let current:unknown=evidence();const a=new HttpScopeAcceptances(storage(),()=>1000,()=>current);
  expect((await a.accept(input)).active).toBe(true);
  current={...evidence(),...change};expect(a.allowed(input,1000)).toBe(false);
});
it('does not trust a caller binding, throwing source or malformed persisted state',async()=>{
  const a=new HttpScopeAcceptances(storage(),()=>1000,evidence);await a.accept(input);
  for(const change of [{accountId:other},{hostId:'host-two'},{profileFingerprint:'d'.repeat(64)}])
    expect(a.allowed({...input,...change},1000)).toBe(false);
  const broken=new HttpScopeAcceptances(storage(),()=>1000,()=>{throw Error('Unavailable');});
  expect((await broken.accept(input)).active).toBe(false);
  const kv=storage();await kv.set('account-egress-scope-v1',{schema:1,records:[{}]});
  await expect(new HttpScopeAcceptances(kv,()=>1000,evidence).initialize()).rejects.toThrow();
});
it('rejects future, expired and excessive acceptance lifetimes',async()=>{
  const a=new HttpScopeAcceptances(storage(),()=>1000,evidence);
  for(const change of [{checkedAt:1001},{expiresAt:1000},{expiresAt:902000}])
    await expect(a.accept({...input,...change})).rejects.toThrow();
});
