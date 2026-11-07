import {test} from 'node:test';
import assert from 'node:assert/strict';
import {provisionProjectVault,storeCredential,serviceEnvironment,runProcess,readOperationBindings,executeOperationBindings} from './dist/test/core.js';
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
const desktopRoute = {...route, authentication:'desktop', accountId:'example-account', tokenEnvironment:undefined, requireApproval:true, operations:[{name:'example',argv:['example-command'],references:{EXAMPLE_PASSWORD:'op://example-vault/example-item/password'}}]};
test('remote resolution preserves exact secret bytes and passes only references in arguments',async()=>{
 const calls=[];
 const value=' synthetic-sensitive-value\n';
 const bindings=await readOperationBindings(async(binary,args)=>{calls.push(args);return value;},{},desktopRoute,'example');
 assert.deepEqual(bindings,{EXAMPLE_PASSWORD:value});
 assert.deepEqual(calls,[['read','--no-newline','op://example-vault/example-item/password']]);
 assert(!JSON.stringify(calls).includes(value));
 let execution;
 await executeOperationBindings(async(binary,args,env)=>{execution={binary,args,env};return 'synthetic-child-output';},{OP_SERVICE_ACCOUNT_TOKEN:'synthetic-other-token'},desktopRoute,'example',bindings);
 assert.equal(execution.binary,'example-command');
 assert.equal(execution.env.EXAMPLE_PASSWORD,value);
 assert(!('OP_SERVICE_ACCOUNT_TOKEN' in execution.env));
 assert(!JSON.stringify(execution.args).includes(value));
});
test('remote transfer rejects outside-vault references and missing or extra bindings before running a child',async()=>{
 let calls=0;const runner=async()=>{calls++;return '';};
 await assert.rejects(readOperationBindings(runner,{}, {...desktopRoute,operations:[{...desktopRoute.operations[0],references:{EXAMPLE_PASSWORD:'op://other-vault/example-item/password'}}]},'example'));
 await assert.rejects(executeOperationBindings(runner,{},desktopRoute,'example',{}));
 await assert.rejects(executeOperationBindings(runner,{},desktopRoute,'example',{EXAMPLE_PASSWORD:'synthetic',EXTRA:'synthetic'}));
 assert.equal(calls,0);
 assert.throws(()=>resolveRoute([{...route,credentialHostId:'other-host'}],route.projectId));
 assert.throws(()=>resolveRoute([{...desktopRoute,credentialHostId:'other-host',requireApproval:false}],route.projectId));
});

test('project vault provisioning verifies identity and safely recovers an uncertain create', async () => {
 const vault={id:'example-project-vault',name:'Example project',description:'Managed by Oxi Op for BB project target-project'};
 let exists=false,creates=0;
 const run=async (_binary,args)=>{
  if(args[1]==='list')return JSON.stringify(exists?[vault]:[]);
  if(args[1]==='create'){creates++;exists=true;throw new Error('uncertain response');}
  if(args[1]==='get')return JSON.stringify(vault);
  throw new Error('Unexpected operation');
 };
 await assert.rejects(provisionProjectVault(run,{},'target-project',vault.name));
 assert.deepEqual(await provisionProjectVault(run,{},'target-project',vault.name),{vaultId:vault.id,name:vault.name});
 assert.equal(creates,1);
 await assert.rejects(provisionProjectVault(run,{},'different-project',vault.name));
 assert.equal(creates,1);
});
test('a new project vault is independently read before returning its identity',async()=>{
 const calls=[];
 const run=async(_binary,args)=>{calls.push(args);return JSON.stringify(args[1]==='list'?[]:{id:'example-vault',name:'Example project',description:'Managed by Oxi Op for BB project target'});};
 assert.deepEqual(await provisionProjectVault(run,{},'target','Example project'),{vaultId:'example-vault',name:'Example project'});
 assert.deepEqual(calls.map(x=>x[1]),['list','create','get']);
 await assert.rejects(provisionProjectVault(async()=>JSON.stringify([{name:'Example project'},{name:'Example project'}]),{},'target','Example project'));
});

test('explicit existing project vault IDs are verified without creation or item reads',async()=>{
 const calls=[];
 const run=async(_binary,args)=>{calls.push(args);return JSON.stringify({id:'existing-vault',name:'Example Project'});};
 assert.deepEqual(await provisionProjectVault(run,{},'target','Example-Project',undefined,'existing-vault'),{vaultId:'existing-vault',name:'Example Project'});
 assert.deepEqual(calls,[['vault','get','existing-vault','--format=json']]);
 await assert.rejects(provisionProjectVault(run,{},'target','Other project',undefined,'existing-vault'));
 await assert.rejects(provisionProjectVault(run,{},'target','Example Project',undefined,'different-vault'));
});

// Real inherited pipes and a non-detached descendant exercise the credential
// operation tree; a mocked runner cannot expose an orphan or missing close.
for (const mode of ['abort', 'deadline']) test('ordinary operation collects descendants on '+mode, async t => {
 if (!['linux','darwin'].includes(process.platform)) return t.skip('POSIX host operations only');
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const realTimer=globalThis.setTimeout;
 const delay=ms=>new Promise(resolve=>realTimer(resolve,ms));
 const directory=await mkdtemp(join(tmpdir(),'oxi-op-lifetime-')),file=join(directory,'descendant.pid');
 const controller=new AbortController();let pid;
 const running=async()=>{
  try{process.kill(pid,0);}catch{return false;}
  if(process.platform==='linux'){
   try{if((await readFile('/proc/'+pid+'/stat','utf8')).split(' ')[2]==='Z')return false;}catch{return false;}
  }
  return true;
 };
 try{
  if(mode==='deadline')t.mock.timers.enable({apis:['setTimeout']});
  const source=`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(file)},String(child.pid));setInterval(()=>{},1000);`;
  const pending=runProcess(process.execPath,['-e',source],{},undefined,controller.signal).then(()=> 'fulfilled',()=> 'rejected');
  for(let i=0;i<200;i++){try{const raw=await readFile(file,'utf8');if(/^[1-9][0-9]*$/.test(raw)){pid=Number(raw);break;}}catch{}await delay(5);}
  assert(pid,'operation descendant startup');
  if(mode==='abort')controller.abort();else t.mock.timers.tick(90_000);
  assert.equal(await Promise.race([pending,delay(1500).then(()=> 'hung')]),'rejected','credential operation must settle after termination');
  for(let i=0;i<100&&await running();i++)await delay(5);
  assert.equal(await running(),false,'credential descendant must not keep running');
 }finally{
  if(pid){try{process.kill(pid,'SIGKILL');}catch{}}
  controller.abort();if(mode==='deadline')t.mock.timers.reset();
  await rm(directory,{recursive:true,force:true});
 }
});
