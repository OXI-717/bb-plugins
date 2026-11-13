import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { AccountEgress, EgressUnavailable } from './account-egress.js';
import { ProxySecrets } from './proxy-secrets.js';
import { clientRouteAllowed } from './client-scope.js';
import { profileFingerprint, type HttpScopeAcceptance } from './http-scope-acceptance.js';
import type { PoolKvStorage } from './core-storage.js';

it('binds the actual dispatcher to acceptance and rechecks after asynchronous host validation',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'http-scope-route-'));
  const values=new Map<string,unknown>();
  const kv:PoolKvStorage={get:async k=>structuredClone(values.get(k)),set:async(k,v)=>{values.set(k,structuredClone(v));},
    delete:async k=>{values.delete(k);},list:async()=>[...values.keys()]};
  const accountId='11111111-1111-4111-8111-111111111111', secretRef='22222222-2222-4222-8222-222222222222';
  const secrets=new ProxySecrets(directory);await secrets.write(secretRef,'http://proxy.example:18444/');
  let enforced=true,invalidateDuringHostRead=false,currentHost='host-one';
  const egress=new AccountEgress(kv,async()=>{if(invalidateDuringHostRead)enforced=false;return currentHost;},async()=>true,secrets,()=>1000,
    a=>{const {expectedExit,checkedAt,...bound}=a;return {...bound,state:enforced?'connected':'unknown',assurance:'vpn-enforced',
      dns:'remote',ipv6:'deny',tunnelLoss:'closed',noDirect:true,exitIp:expectedExit[0],observedAt:1000,expiresAt:2000};});
  const send=vi.fn<typeof fetch>(async()=>Response.json({ok:true}));vi.stubGlobal('fetch',send);
  try {
    await egress.initialize();await egress.configure({id:'corporate',version:1,label:'Fixture',hostIds:['host-one','host-two'],
      transport:'http-connect',endpoint:'http://proxy.example:18444/',secretRef,failure:'closed'});
    await egress.bind(accountId,{id:'corporate',version:1});
    const route=await egress.acquire(accountId,'session'),profile=route.profile!;
    const scope={schema:'bb-account-pool/client-account-scope/1' as const,accountIds:[accountId],egress:{id:profile.id,version:profile.version}};
    const assertAllowed=()=>{if(!clientRouteAllowed(route,scope,accountId,1000))throw new EgressUnavailable();};
    expect(clientRouteAllowed(route,scope,accountId,1000)).toBe(false);
    const input:HttpScopeAcceptance={accountId,hostId:'host-one',profile:{id:profile.id,version:profile.version},
      profileFingerprint:profileFingerprint(profile),receiptDigest:'a'.repeat(64),configDigest:'b'.repeat(64),
      authGeneration:'auth-one',expectedExit:['192.0.2.1'],checkedAt:1000,expiresAt:60000};
    const accepted=await egress.acceptScope(input);expect(accepted.active).toBe(true);
    expect((await route.fetch(true,send=>{assertAllowed();return send();})!('https://origin.example/')).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][1]).toMatchObject({redirect:'error'});
    expect((send.mock.calls[0][1] as any).dispatcher).toBeDefined();send.mockClear();
    invalidateDuringHostRead=true;
    await expect(route.fetch(true,send=>{assertAllowed();return send();})!('https://origin.example/')).rejects.toBeInstanceOf(EgressUnavailable);
    expect(send).not.toHaveBeenCalled();invalidateDuringHostRead=false;enforced=true;
    currentHost='host-two'; // Even a second allowed host is not the accepted pool host.
    await expect(route.fetch(true,send=>{assertAllowed();return send();})!('https://origin.example/')).rejects.toBeInstanceOf(EgressUnavailable);
    expect(send).not.toHaveBeenCalled();currentHost='host-one';
    const {accountId:a,hostId,profile:ref,profileFingerprint:fingerprint}=input;
    await egress.revokeScope({accountId:a,hostId,profile:ref,profileFingerprint:fingerprint,acceptanceId:accepted.acceptanceId});
    expect(clientRouteAllowed(route,scope,accountId,1000)).toBe(false);
    expect((await egress.acquire(accountId,'session')).profile).toEqual(profile);
  } finally {vi.unstubAllGlobals();await egress.close();await fs.rm(directory,{recursive:true,force:true});}
});
