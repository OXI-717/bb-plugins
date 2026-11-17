import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createAccountPoolPlugin } from './server.js';
import { egressProfileSchema } from './account-egress.js';
import { profileFingerprint } from './http-scope-acceptance.js';

it('requires a manage grant for acceptance/revocation and keeps production without a source closed',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'scope-management-'));
  const host=createFakePluginHost({pluginId:'fixture-pool',dataDir,sdk:{hosts:{list:async()=>[]},system:{config:async()=>({primaryHostId:'host-one'})}}});
  try {
    await createAccountPoolPlugin({now:()=>1000})(host.bb);
    const call=host.harness.behavior.callRpc;
    const key=(await fs.readFile(path.join(dataDir,'plugins','fixture-pool','secrets','accounts','management','operator.env'),'utf8')).trim().split('=')[1]!;
    const read=await call('management.unlock',{key,scope:'read',ttlSeconds:60}) as {token:string};
    const manage=await call('management.unlock',{key,scope:'manage',ttlSeconds:60}) as {token:string};
    const invoke=(method:string,input:unknown)=>call('management.call',{token:manage.token,method,input}) as Promise<{ok:true;result:any}>;
    const account=await invoke('account.add',{provider:'claude',source:{kind:'api-key',apiKey:'fixture-upstream'},label:'Fixture',priority:100});
    const profile=egressProfileSchema.parse({id:'corporate',version:1,label:'Fixture',transport:'http-connect',
      hostIds:['host-one'],endpoint:'http://proxy.example:18444/',secretRef:'11111111-1111-4111-8111-111111111111',failure:'closed'});
    await invoke('egress.configure',profile);
    const binding={accountId:account.result.id,hostId:'host-one',profile:{id:'corporate',version:1},profileFingerprint:profileFingerprint(profile)};
    const input={...binding,receiptDigest:'a'.repeat(64),configDigest:'b'.repeat(64),authGeneration:'auth-one',
      expectedExit:['192.0.2.1'],checkedAt:1000,expiresAt:60000};
    await expect(call('egress.scopeAccept',input)).rejects.toThrow('management is locked');
    expect(await call('management.call',{token:read.token,method:'egress.scopeAccept',input})).toEqual({ok:false,code:'pool-management-locked'});
    const accepted=await invoke('egress.scopeAccept',input);expect(accepted.result.active).toBe(false);
    const revoke={...binding,acceptanceId:accepted.result.acceptanceId};
    await expect(call('egress.scopeRevoke',revoke)).rejects.toThrow('management is locked');
    expect(await call('management.call',{token:read.token,method:'egress.scopeRevoke',input:revoke})).toEqual({ok:false,code:'pool-management-locked'});
    expect((await invoke('egress.scopeRevoke',revoke)).ok).toBe(true);
    expect((await call('egress.status',null) as {bindings:unknown}).bindings).toEqual({});
  } finally {await host.harness.lifecycle.dispose();await fs.rm(dataDir,{recursive:true,force:true});}
});
