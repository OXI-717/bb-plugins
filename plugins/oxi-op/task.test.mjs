import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {system} from './test/native-task-host.mjs';
const caller={hostId:'example-client',projectId:'example-project'};
const executor={id:'example-executor',hostId:'example-host',accountId:'example-account',callerIds:[caller.hostId],projectIds:[caller.projectId],enabled:true,
 execution:{runtimeId:'example-runtime',gatewayId:'example-gateway',runtimeSha256:'a'.repeat(64),profile:{id:'example-exit',version:2}},
 unlock:{profile:'example-unlock',operation:'prepared-native-keyring-unlock'}};
const route={projectId:caller.projectId,profile:executor.unlock.profile,hostId:executor.hostId,vaultId:'example-vault',opBinary:'/usr/bin/op',
 authentication:'service-account',tokenSetting:'projectServiceAccounts',requireApproval:false,
 operations:[{name:executor.unlock.operation,argv:['/usr/bin/python3','-I','/opt/example/native_unlock.py','--automatic'],references:{}}]};
async function setup(t,alter={},host=async()=>({completed:true})){
 const s=await system({...route,...alter},'synthetic-operation-context',{host});t.after(()=>s.close());
 await s.sessions.configure(executor);await s.sessions.setManaged(true);
 const lease=await s.sessions.request(caller,{action:'acquire',executorId:executor.id,sessionId:randomUUID()});return {...s,lease};
}
const start=s=>s.sessions.request(caller,{action:'unlock-start',leaseId:s.lease.leaseId});
test('actual SDK attribution refuses client/foreign plugin and strict extra fields before consume',async t=>{
 const s=await setup(t);
 for(const options of [{},{experimental_caller:{kind:'plugin',pluginId:'foreign'}}])
  await assert.rejects(s.op.harness.behavior.callRpc('runPreparedTask',{requestId:randomUUID()},options));
 await assert.rejects(s.pool.harness.behavior.callRpc('claimNativeUnlock',{requestId:randomUUID()}));
 await assert.rejects(s.op.harness.behavior.callRpc('runPreparedTask',{requestId:randomUUID(),profile:'foreign'},{experimental_caller:{kind:'plugin',pluginId:'account-pool-balanced'}}));
 assert.equal(s.op.harness.inspection.experimental_hostRpcCalls.length,0);
});
test('actual Pooler -> OP server -> host dispatch consumes before the host, with no thread invention',async t=>{
 let s,calls=0;
 s=await setup(t,{},async(method,input)=>{
  calls++;assert.equal(method,'runPrepared');assert.deepEqual(input.assignment.binding,s.lease.binding);
  assert.equal(input.assignment.profile,route.profile);assert.equal(input.serviceAccountToken,'synthetic-operation-context');
  const stored=await s.pool.bb.storage.kv.get('native-agy-sessions-v1');assert.equal(stored.leases[0].unlock.state,'consumed');
  assert.equal(input.assignment.binding.caller.threadId,undefined);return {completed:true};
 });
 await start(s);await setImmediate();assert.equal(calls,1);
 assert.equal((await s.sessions.request(caller,{action:'poll',leaseId:s.lease.leaseId})).unlock.state,'completed');
 assert.equal(s.op.harness.inspection.pendingInteractions.length,0);
});
for(const [name,change] of Object.entries({approval:{requireApproval:true},host:{hostId:'foreign'},missingOperation:{operations:[]},
 references:{operations:[{...route.operations[0],references:{PASSWORD:'op://example-vault/example/password'}}]},missingProject:{projectId:'foreign'},missingProfile:{profile:'foreign'}})){
 test('explicit '+name+' mismatch consumes once, refuses before host and keeps slot uncertain',async t=>{
  const s=await setup(t,change);await start(s);await setImmediate();
  assert.equal(s.op.harness.inspection.experimental_hostRpcCalls.length,0);
  assert.equal((await s.sessions.snapshot()).leases[0].state,'uncertain');
  await assert.rejects(start(s));await assert.rejects(s.sessions.request(caller,{action:'release',leaseId:s.lease.leaseId,stopped:true}));
 });
}
