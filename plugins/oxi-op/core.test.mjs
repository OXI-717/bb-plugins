import {test} from 'node:test';
import assert from 'node:assert/strict';
import {storeCredential,serviceEnvironment,runProcess} from './dist/test/core.js';
import {resolveRoute} from './dist/test/contract.js';
const route={projectId:'example-project',hostId:'example-host',vaultId:'example-vault',tokenEnvironment:'EXAMPLE_TOKEN'};
test('unknown and duplicate projects fail closed',()=>{
 assert.throws(()=>resolveRoute([route],'other'));
 assert.throws(()=>resolveRoute([route,route],route.projectId));
 assert.throws(()=>resolveRoute([{...route,authentication:'desktop'}],route.projectId));
 assert.equal(resolveRoute([route],route.projectId).requireApproval,true);
});
test('missing profile explains same-project configuration without leaking other routes',()=>{
 const routes=[{...route,profile:'admin'},{...route,projectId:'other-project',profile:'other-private-profile'}];
 assert.throws(()=>resolveRoute(routes,route.projectId),e=>e.message.includes('"admin"') && !e.message.includes('other-private-profile') && e.message.includes('Do not use macOS Keychain'));
 assert.throws(()=>resolveRoute(routes,'unknown'),e=>e.message.includes('Configured profiles for this project: []') && !e.message.includes('"admin"'));
});
test('password is stdin only and separate get verifies it',async()=>{
 let stored;const calls=[];
 const runner=async(bin,args,env,input)=>{calls.push({args,input});if(args[1]==='list')return '[]';if(args[1]==='template')return JSON.stringify({category:'LOGIN',fields:[{id:'username',label:'username',type:'STRING',purpose:'USERNAME'},{id:'password',label:'password',type:'CONCEALED',purpose:'PASSWORD'}]});if(args[1]==='create'){stored=JSON.parse(input);assert.equal(stored.fields[1].purpose,'PASSWORD');return JSON.stringify({id:'example-item'});}return JSON.stringify(stored);};
 assert.equal((await storeCredential(runner,{},'example-vault','Example','user','synthetic-value')).verified,true);
 assert.equal(calls.length,4);assert(!JSON.stringify(calls.map(x=>x.args)).includes('synthetic-value'));assert(calls[3].args.includes('--reveal'));
});
test('retry recovers matching item without duplicate write',async()=>{
 const runner=async(_b,args)=>args[1]==='list'?JSON.stringify([{id:'example-item',title:'Example'}]):JSON.stringify({fields:[{label:'username',value:'user'},{label:'password',value:'synthetic'}]});
 assert.equal((await storeCredential(runner,{},'vault','Example','user','synthetic')).itemId,'example-item');
 await assert.rejects(storeCredential(runner,{},'vault','Example','user','different'),/differs/);
});
test('CLI errors cannot disclose sensitive output',async()=>{
 await assert.rejects(storeCredential(async()=>{throw Error('synthetic-sensitive-output');},{},'v','t','u','p'),e=>!e.message.includes('synthetic-sensitive-output'));
});
test('missing token cannot fall back to personal account',()=>{
 assert.throws(()=>serviceEnvironment(''));assert.equal(serviceEnvironment('synthetic').OP_BIOMETRIC_UNLOCK_ENABLED,'false');
});
test('cancelled process never starts',async()=>{
 const controller=new AbortController();controller.abort();await assert.rejects(runProcess('/not-a-command',[],{},undefined,controller.signal),/cancelled/);
});
