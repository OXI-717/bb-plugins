import {test} from 'node:test';
import assert from 'node:assert/strict';
import {provisionProjectVault,storeCredential,serviceEnvironment,runProcess,readOperationBindings,executeOperationBindings,issueServiceAccounts,probeServiceScope,listVaultKeys,execWithKeys,runCommand,withTemplateFile,concealOutput,overviewVaults,runOwnedProcess,execResolved,runTidy,brokerRunner,commandPath,programAvailable} from './dist/test/core.js';
import {resolveRoute} from './dist/test/contract.js';
import {readFileSync} from 'node:fs';
// Item templates arrive on stdin on macOS and through a private file on Linux.
const templateOf=(args,input)=>{const path=args[args.indexOf('--template')+1];return JSON.parse(path==='/dev/stdin'?input:readFileSync(path,'utf8'));};
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
 const runner=async(bin,args,env,input)=>{calls.push({args,input});if(args[1]==='list')return '[]';if(args[1]==='template')return JSON.stringify({category:'LOGIN',fields:[{id:'username',label:'username',type:'STRING',purpose:'USERNAME'},{id:'password',label:'password',type:'CONCEALED',purpose:'PASSWORD'}]});if(args[1]==='create'){stored=templateOf(args,input);assert.equal(stored.fields[1].purpose,'PASSWORD');return JSON.stringify({id:'example-item'});}return JSON.stringify(stored);};
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

function fakeAccount(options={}){
 const items=new Map(options.items??[]);const calls=[];let next=0;
 const vault={id:'automation-vault',name:'Example — Automation',description:'Managed by Oxi Op for BB project target'};
 const run=async(_b,args,_env,input)=>{
  calls.push({args,input});
  const [group,action]=args;
  if(group==='vault')return JSON.stringify(action==='list'?[]:vault);
  if(group==='service-account'){if(options.failCreate)throw new Error('synthetic provider failure');return 'synthetic-token-'+(++next)+'\n';}
  if(action==='list')return JSON.stringify([...items].map(([id,x])=>({id,title:x.title})));
  if(action==='template')return JSON.stringify({fields:[{id:'username',label:'username'},{id:'password',label:'password'}]});
  if(action==='create'){if(options.failBackup)throw new Error('synthetic backup failure');const t=templateOf(args,input);const id='item-'+items.size;items.set(id,{title:t.title,created_at:options.createdAt??new Date().toISOString(),fields:t.fields.map(f=>({label:f.label,value:f.value}))});return JSON.stringify({id});}
  if(action==='edit'){const it=items.get(args[2]);it.title=args[args.indexOf('--title')+1];return '{}';}
  if(action==='get')return JSON.stringify(items.get(args[2]));
  throw new Error('unexpected');
 };
 return {run,calls,items};
}
const accounts=[{profile:'routine',name:'Example pipeline reader',permissions:['read_items']},{profile:'intake',name:'Example secret intake',permissions:['read_items','write_items']}];
test('service accounts are issued once, scoped to one vault, backed up through stdin before use',async()=>{
 const f=fakeAccount();
 const result=await issueServiceAccounts(f.run,{},{projectId:'target',vaultName:'Example — Automation',backupVaultId:'backup-vault',expiresIn:'90d',accounts});
 assert.equal(result.vaultId,'automation-vault');
 assert.deepEqual(result.accounts.map(a=>[a.profile,a.token,a.recovered]),[['routine','synthetic-token-1',false],['intake','synthetic-token-2',false]]);
 const creates=f.calls.filter(c=>c.args[0]==='service-account').map(c=>c.args);
 assert.deepEqual(creates,[
  ['service-account','create','Example pipeline reader','--vault','automation-vault:read_items','--expires-in','90d','--raw'],
  ['service-account','create','Example secret intake','--vault','automation-vault:read_items,write_items','--expires-in','90d','--raw'],
 ]);
 assert(!creates.flat().some(a=>a.includes('can-create-vaults')||a.includes('share_items')));
 assert(!JSON.stringify(f.calls.map(c=>c.args)).includes('synthetic-token'));
 assert(f.calls.filter(c=>c.args[1]==='create'&&c.args[0]==='item').every(c=>c.args.includes('backup-vault')));
 assert.equal(f.items.size,2);
});
test('a retried issue recovers backed-up tokens instead of creating another service account',async()=>{
 const f=fakeAccount();
 await issueServiceAccounts(f.run,{},{projectId:'target',vaultName:'Example — Automation',backupVaultId:'backup-vault',expiresIn:'90d',accounts});
 const before=f.calls.filter(c=>c.args[0]==='service-account').length;
 const again=await issueServiceAccounts(f.run,{},{projectId:'target',vaultName:'Example — Automation',backupVaultId:'backup-vault',expiresIn:'90d',accounts});
 assert.equal(f.calls.filter(c=>c.args[0]==='service-account').length,before);
 assert.deepEqual(again.accounts.map(a=>[a.token,a.recovered]),[['synthetic-token-1',true],['synthetic-token-2',true]]);
});
test('issue failures never disclose provider output or tokens',async()=>{
 await assert.rejects(issueServiceAccounts(fakeAccount({failCreate:true}).run,{},{projectId:'target',vaultName:'Example — Automation',backupVaultId:'backup-vault',expiresIn:'90d',accounts}),e=>!e.message.includes('synthetic'));
 await assert.rejects(issueServiceAccounts(fakeAccount({failBackup:true}).run,{},{projectId:'target',vaultName:'Example — Automation',backupVaultId:'backup-vault',expiresIn:'90d',accounts}),e=>!e.message.includes('synthetic')&&e.message.includes('owner review'));
});
test('scope probe requires exactly one visible vault and reports a refused write',async()=>{
 const calls=[];
 const reader=async(_b,args)=>{calls.push(args);if(args[0]==='vault')return JSON.stringify([{id:'automation-vault'}]);if(args[1]==='list')return '[]';if(args[1]==='template')return JSON.stringify({fields:[{id:'username',label:'username'},{id:'password',label:'password'}]});throw new Error('denied');};
 assert.deepEqual(await probeServiceScope(reader,{},'automation-vault'),{vaultIds:['automation-vault'],writable:false,writeFailure:'create'});
 await assert.rejects(probeServiceScope(async()=>JSON.stringify([{id:'automation-vault'},{id:'other-vault'}]),{},'automation-vault'),/scope/);
 await assert.rejects(probeServiceScope(async(_b,args)=>{if(args[0]==='vault')return JSON.stringify([{id:'automation-vault'}]);throw new Error('offline');},{},'automation-vault'),/read/);
 const items=new Map();
 const writer=async(_b,args,_e,input)=>{if(args[0]==='vault')return JSON.stringify([{id:'automation-vault'}]);if(args[1]==='list')return JSON.stringify([...items].map(([id,x])=>({id,title:x.title})));if(args[1]==='template')return JSON.stringify({fields:[{id:'username',label:'username'},{id:'password',label:'password'}]});if(args[1]==='create'){const t=templateOf(args,input);items.set('probe',{title:t.title,fields:t.fields.map(f=>({label:f.label,value:f.value}))});return JSON.stringify({id:'probe'});}if(args[1]==='get')return JSON.stringify(items.get('probe'));if(args[1]==='delete'){items.delete(args[2]);return '';}throw new Error('unexpected');};
 assert.deepEqual(await probeServiceScope(writer,{},'automation-vault'),{vaultIds:['automation-vault'],writable:true});
 assert.equal(items.size,0);
});

test('agent commands get only requested keys, never the service token, and output is concealed',async()=>{
 const reads=[];
 const run=async(_b,args,env)=>{reads.push(args);assert.equal(env.OP_SERVICE_ACCOUNT_TOKEN,'synthetic-token');return 'synthetic-key-value';};
 let childEnv,childArgs;
 const command=async(bin,args,env,cwd,timeout)=>{childEnv=env;childArgs=[bin,...args,cwd,timeout];return {exitCode:0,output:'start synthetic-key-value end',truncated:false};};
 const result=await execWithKeys(run,command,{OP_SERVICE_ACCOUNT_TOKEN:'synthetic-token'},'automation-vault',['deploy','--check'],{API_KEY:{item:'Example API',field:'credential'}},'/work/project',5000);
 assert.deepEqual(reads,[['read','--no-newline','op://automation-vault/Example API/credential']]);
 assert.equal(childEnv.API_KEY,'synthetic-key-value');
 assert(!Object.keys(childEnv).some(k=>k.startsWith('OP_')));
 assert.deepEqual(childArgs,['deploy','--check','/work/project',5000]);
 assert.equal(result.output,'start <concealed> end');
 await assert.rejects(execWithKeys(run,command,{},'v',['x'],{OP_SERVICE_ACCOUNT_TOKEN:{item:'a',field:'b'}},undefined,1000));
 await assert.rejects(execWithKeys(run,command,{},'v',['x'],{K:{item:'../other',field:'b'}},undefined,1000));
 await assert.rejects(execWithKeys(async()=>{throw new Error('synthetic-provider-detail');},command,{},'v',['x'],{K:{item:'a',field:'b'}},undefined,1000),e=>!e.message.includes('synthetic-provider-detail'));
});
test('a real child process receives the key and the returned output conceals it',async()=>{
 const result=await execWithKeys(async()=>'synthetic-live-value',runCommand,{OP_SERVICE_ACCOUNT_TOKEN:'synthetic-token'},'v',[process.execPath,'-e','console.log(process.env.K, typeof process.env.OP_SERVICE_ACCOUNT_TOKEN); process.exit(3)'],{K:{item:'a',field:'b'}},undefined,10000);
 assert.equal(result.exitCode,3);
 assert.equal(result.output.trim(),'<concealed> undefined');
});
test('key listing returns titles and field labels only',async()=>{
 const run=async(_b,args)=>args[1]==='list'?JSON.stringify([{id:'i1',title:'Example API'}]):JSON.stringify({fields:[{label:'credential',value:'synthetic-hidden'},{label:'notesPlain',value:''}]});
 const result=await listVaultKeys(run,{},'automation-vault');
 assert.deepEqual(result,{items:[{item:'Example API',fields:['credential','notesPlain']}]});
 assert(!JSON.stringify(result).includes('synthetic-hidden'));
});
test('on Linux the item template goes through a private file that is removed afterwards',async()=>{
 const {statSync,existsSync,readFileSync}=await import('node:fs');
 let seen;
 const result=await withTemplateFile('{"title":"synthetic"}','linux',async(path,input)=>{
  assert.equal(input,undefined);assert.notEqual(path,'/dev/stdin');
  assert.equal(statSync(path).mode&0o777,0o600);assert.equal(statSync(path.replace(/\/item\.json$/,'')).mode&0o777,0o700);
  assert.equal(readFileSync(path,'utf8'),'{"title":"synthetic"}');seen=path;return 'created';
 });
 assert.equal(result,'created');assert(!existsSync(seen));
 await assert.rejects(withTemplateFile('{}','linux',async path=>{seen=path;throw new Error('synthetic failure');}));
 assert(!existsSync(seen));
 assert.deepEqual(await withTemplateFile('{"a":1}','darwin',async(path,input)=>[path,input]),['/dev/stdin',{a:1}]);
});
test('a Linux store never passes the password in arguments',async()=>{
 const calls=[];let stored;
 const runner=async(_b,args,_e,input)=>{calls.push(args);if(args[1]==='list')return '[]';if(args[1]==='template')return JSON.stringify({fields:[{id:'username',label:'username'},{id:'password',label:'password'}]});if(args[1]==='create'){assert.equal(input,undefined);const {readFileSync}=await import('node:fs');stored=JSON.parse(readFileSync(args[args.indexOf('--template')+1],'utf8'));return JSON.stringify({id:'item'});}return JSON.stringify({fields:stored.fields.map(f=>({label:f.label,value:f.value}))});};
 assert.equal((await storeCredential(runner,{},'vault','Example','user','synthetic-linux-value',undefined,'linux')).verified,true);
 assert(!JSON.stringify(calls).includes('synthetic-linux-value'));
});
test('an agent command timeout ends descendants that hold keys',async t=>{
 if(!['linux','darwin'].includes(process.platform))return t.skip('POSIX only');
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const directory=await mkdtemp(join(tmpdir(),'oxi-op-agent-'));const file=join(directory,'pid');
 const source=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(file)},String(c.pid));setInterval(()=>{},1000);`;
 let pid;
 try{
  const result=await execWithKeys(async()=>'synthetic-key',runCommand,{},'v',[process.execPath,'-e',source],{K:{item:'a',field:'b'}},undefined,700);
  assert.equal(result.timedOut,true);
  pid=Number(await readFile(file,'utf8'));
  const running=async()=>{try{process.kill(pid,0);}catch{return false;}if(process.platform==='linux'){try{if((await readFile('/proc/'+pid+'/stat','utf8')).split(' ')[2]==='Z')return false;}catch{return false;}}return true;};
  let alive=true;for(let i=0;i<100&&(alive=await running());i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(alive,false,'descendant with the key must not survive');
 }finally{if(pid){try{process.kill(pid,'SIGKILL');}catch{}}await rm(directory,{recursive:true,force:true});}
});
test('accounts never expire by default and a reissue always sets aside existing backups',async()=>{
 const f=fakeAccount();
 await issueServiceAccounts(f.run,{},{projectId:'target',vaultName:'Example — Automation',backupVaultId:'backup-vault',accounts});
 assert(f.calls.filter(c=>c.args[0]==='service-account').every(c=>!c.args.includes('--expires-in')));
 const limited=fakeAccount();
 await issueServiceAccounts(limited.run,{},{projectId:'target',vaultName:'Example — Automation',backupVaultId:'backup-vault',expiresIn:'90d',accounts});
 assert(limited.calls.filter(c=>c.args[0]==='service-account').every(c=>c.args.join(' ').includes('--expires-in 90d')));
 assert.deepEqual((await issueServiceAccounts(f.run,{},{projectId:'target',vaultName:'Example — Automation',backupVaultId:'backup-vault',accounts})).accounts.map(a=>a.recovered),[true,true]);
 const reissue={projectId:'target',vaultName:'Example — Automation',backupVaultId:'backup-vault',replaceExisting:true,accounts};
 const before=f.calls.length;
 const replaced=await issueServiceAccounts(f.run,{},reissue,undefined,new Date('2026-11-08T12:00:00.000Z'));
 assert.deepEqual(replaced.accounts.map(a=>a.recovered),[false,false]);
 assert(!f.calls.slice(before).some(c=>c.args.includes('--reveal')&&c.args[1]==='get'&&c.args[2]!==undefined&&[...f.items.keys()].slice(0,2).includes(c.args[2])),'a reissue does not read the old tokens');
 const again=await issueServiceAccounts(f.run,{},reissue,undefined,new Date('2026-11-08T12:00:05.000Z'));
 assert.deepEqual(again.accounts.map(a=>a.recovered),[false,false],'a retried reissue never brings back an earlier token');
 assert.equal([...f.items.values()].filter(x=>/\(replaced 2026-11-08T12:00:0[05]Z\)$/.test(x.title)).length,4);
 assert.equal(f.calls.filter(c=>c.args[0]==='service-account').length,6);
});test('a leader that exits while an escaped descendant holds output does not hang the call',async t=>{
 if(!['linux','darwin'].includes(process.platform))return t.skip('POSIX only');
 const source="const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{detached:true,stdio:['ignore','inherit','inherit']}).unref();";
 const started=Date.now();
 const result=await runCommand(process.execPath,['-e',source],{},undefined,20000);
 assert.deepEqual([result.exitCode,result.escapedProcess,result.timedOut],[0,true,false]);
 assert(Date.now()-started<2500);
 const begun=Date.now();
 await assert.rejects(runProcess(process.execPath,['-e',source],{}),/cleanup-unconfirmed/);
 assert(Date.now()-begun<2500);
});
test('multibyte titles survive pipe chunk boundaries',async()=>{
 const text='Oxi Op service account — Пример '.repeat(5000);
 const out=await runProcess(process.execPath,['-e',"process.stdout.write('Oxi Op service account — Пример '.repeat(5000))"],{});
 assert.equal(out,text);
});
test('a value cut at the end of stopped output is concealed',()=>{
 const value='SYNTHETICVALUE1234567890';
 const r=concealOutput('progress line\nkey='+value.slice(0,9),[value],true);
 assert(!r.output.includes(value.slice(0,9)));assert(r.output.endsWith('<concealed>'));
});
test('key listing stops reading after the first failure',async()=>{
 let gets=0;
 const items=Array.from({length:40},(_,i)=>({id:'i'+i,title:'t'+i}));
 const run=async(_b,args)=>{if(args[1]==='list')return JSON.stringify(items);const n=++gets;await new Promise(r=>setTimeout(r,2));if(n===2)throw new Error('rate limited');return JSON.stringify({fields:[]});};
 await assert.rejects(listVaultKeys(run,{},'v'));
 await new Promise(r=>setTimeout(r,50));
 assert(gets<=6,'workers kept reading: '+gets);
});
test('codes survive a wrapping transport message',async()=>{
 const {errorCode,CodedError}=await import('./dist/test/errors.js');
 assert.equal(errorCode(new Error('Host call failed: '+new CodedError('backup-list-failed','x').message)),'backup-list-failed');
 assert.equal(errorCode(new Error('plain')),undefined);
});
test('a write probe whose create succeeded but read-back failed is inconclusive, not a denial',async()=>{
 const run=async(_b,args,_e,input)=>{if(args[0]==='vault')return JSON.stringify([{id:'automation-vault'}]);if(args[1]==='list')return '[]';if(args[1]==='template')return JSON.stringify({fields:[{id:'username',label:'username'},{id:'password',label:'password'}]});if(args[1]==='create')return JSON.stringify({id:'probe'});throw new Error('transient read failure');};
 await assert.rejects(probeServiceScope(run,{},'automation-vault'),e=>e.message.includes('[probe-inconclusive]'));
});
test('the overview never lists items of vaults that are neither routed nor marked',async()=>{
 const listed=[];
 const run=async(_b,args)=>{
  if(args[0]==='vault'&&args[1]==='list')return JSON.stringify([{id:'routed',name:'Routed'},{id:'marked',name:'Marked'},{id:'private',name:'Private'}]);
  if(args[0]==='vault'&&args[1]==='get')return JSON.stringify({description:args[2]==='marked'?'Managed by Oxi Op for BB project p-x':'Personal things'});
  if(args[0]==='item'&&args[1]==='list'){listed.push(args[3]);return JSON.stringify([{title:'T',category:'LOGIN',created_at:'c',updated_at:'u'}]);}
  if(args.includes('--reveal'))throw new Error('values must never be read');
  throw new Error('unexpected '+args.join(' '));
 };
 const result=await overviewVaults(run,{},new Set(['routed']));
 assert.deepEqual(listed,['routed','marked']);
 assert.deepEqual(result.vaults.map(v=>[v.name,v.service,v.marker??null,v.items?.length??null]),[['Routed',true,null,1],['Marked',true,'p-x',1],['Private',false,null,null]]);
});
test('an overview of a large vault keeps the full count and marks the cut',async()=>{
 const items=Array.from({length:501},(_,i)=>({title:'t'+i,category:'LOGIN',created_at:'c',updated_at:'u'}));
 const run=async(_b,args)=>args[1]==='list'&&args[0]==='vault'?JSON.stringify([{id:'routed',name:'Routed'}]):args[1]==='get'?JSON.stringify({description:''}):JSON.stringify(items);
 const result=await overviewVaults(run,{},new Set(['routed']));
 assert.deepEqual([result.vaults[0].itemTotal,result.vaults[0].itemsTruncated,result.vaults[0].items.length,result.vaultsTruncated],[501,true,500,false]);
});
test('one unreadable vault or an empty listing does not stop the overview',async()=>{
 const run=async(_b,args)=>{
  if(args[0]==='vault'&&args[1]==='list')return JSON.stringify([{id:'a',name:'A'},{id:'b',name:'B'},{id:'c',name:'C'}]);
  if(args[0]==='vault'&&args[1]==='get'){if(args[2]==='b')throw new Error('process exit 1; output suppressed');return JSON.stringify({description:''});}
  if(args[1]==='list')return args[3]==='a'?'':JSON.stringify([{title:'T'}]);
  throw new Error('unexpected');
 };
 const result=await overviewVaults(run,{},new Set(['a','b','c']));
 assert.deepEqual(result.vaults.map(v=>[v.name,v.error??null,v.itemTotal??null]),[['A',null,0],['B','vault-get-exit-1',null],['C',null,1]]);
});
test('desktop op calls share the host session; other processes get their own',async t=>{
 if(!['linux','darwin'].includes(process.platform))return t.skip('POSIX only');
 const probe="process.stdout.write(String(require('node:child_process').execSync('ps -o pgid= -p '+process.pid).toString().trim()===require('node:child_process').execSync('ps -o pgid= -p '+process.ppid).toString().trim()))";
 const shared=await runProcess(process.execPath,['-e',probe],{OP_BIOMETRIC_UNLOCK_ENABLED:'true',PATH:process.env.PATH});
 const own=await runProcess(process.execPath,['-e',probe],{OP_BIOMETRIC_UNLOCK_ENABLED:'false',PATH:process.env.PATH});
 const ownedDesktop=await runOwnedProcess(process.execPath,['-e',probe],{OP_BIOMETRIC_UNLOCK_ENABLED:'true',PATH:process.env.PATH});
 assert.deepEqual([shared,own,ownedDesktop],['true','false','false'],'a command run through op run keeps its own group even with desktop unlock');
});
test('cancelling a desktop op run ends the command it launched',async t=>{
 if(!['linux','darwin'].includes(process.platform))return t.skip('POSIX only');
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'oxi-op-run-'));const file=join(dir,'pid');
 const source=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(file)},String(c.pid));setInterval(()=>{},1000);`;
 const controller=new AbortController();let pid;
 try{
  const pending=runOwnedProcess(process.execPath,['-e',source],{OP_BIOMETRIC_UNLOCK_ENABLED:'true',PATH:process.env.PATH},undefined,controller.signal).catch(()=>'rejected');
  for(let i=0;i<200&&!pid;i++){try{pid=Number(await readFile(file,'utf8'))||undefined;}catch{}await new Promise(r=>setTimeout(r,5));}
  assert(pid);controller.abort();assert.equal(await pending,'rejected');
  const running=async()=>{try{process.kill(pid,0);}catch{return false;}if(process.platform==='linux'){try{if((await readFile('/proc/'+pid+'/stat','utf8')).split(' ')[2]==='Z')return false;}catch{return false;}}return true;};
  let alive=true;for(let i=0;i<100&&(alive=await running());i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(alive,false);
 }finally{if(pid){try{process.kill(pid,'SIGKILL');}catch{}}await rm(dir,{recursive:true,force:true});}
});
test('a resolved critical value reaches only the command and is concealed in its output',async()=>{
 const r=await execResolved(runCommand,[process.execPath,'-e','console.log(process.env.SSHPASS, typeof process.env.OP_SERVICE_ACCOUNT_TOKEN)'],{SSHPASS:'synthetic-root-value'},undefined,10000);
 assert.equal(r.output.trim(),'<concealed> undefined');
 await assert.rejects(execResolved(runCommand,['true'],{OP_X:'v'},undefined,1000));
});
test('tidy compares by hash, stops when values differ, and deletes only an empty vault',async()=>{
 const vaults={va:[{id:'i1',title:'Root A',fields:[{purpose:'USERNAME',value:'root'},{purpose:'PASSWORD',value:'synthetic-same'}]}],vb:[{id:'i2',title:'Root B',fields:[{purpose:'USERNAME',value:'root'},{purpose:'PASSWORD',value:'synthetic-same'}]}],vc:[{id:'i3',title:'Other',fields:[{purpose:'PASSWORD',value:'synthetic-other'}]}]};
 const calls=[];
 const run=async(_b,args)=>{calls.push(args);
  if(args[0]==='item'&&args[1]==='list'){const v=args[args.indexOf('--vault')+1];return JSON.stringify((vaults[v]??[]).map(x=>({id:x.id,title:x.title})));}
  if(args[0]==='item'&&args[1]==='get'){const v=args[args.indexOf('--vault')+1];return JSON.stringify(vaults[v].find(x=>x.id===args[2]));}
  if(args[0]==='item'&&args[1]==='move'){const from=args[args.indexOf('--current-vault')+1],to=args[args.indexOf('--destination-vault')+1];const it=vaults[from].find(x=>x.id===args[2]);vaults[from]=vaults[from].filter(x=>x!==it);(vaults[to]??=[]).push({...it,id:it.id+'m'});return '';}
  if(args[0]==='item'&&args[1]==='delete'){const v=args[args.indexOf('--vault')+1];vaults[v]=vaults[v].filter(x=>x.id!==args[2]);return '';}
  if(args[0]==='vault'&&args[1]==='delete'){delete vaults[args[2]];return '';}
  if(args[0]==='vault'&&args[1]==='list')return JSON.stringify(Object.keys(vaults).map(id=>({id})));
  throw new Error('unexpected');};
 const id=x=>x.padEnd(26,'a');
 for(const k of ['va','vb','vc']){vaults[id(k)]=vaults[k];delete vaults[k];}
 const differ=await runTidy(run,{},[{kind:'same',a:{vaultId:id('va'),item:'Root A'},b:{vaultId:id('vc'),item:'Other'}},{kind:'delete-vault',vaultId:id('va')}]);
 assert.deepEqual(differ.results.map(r=>[r.kind,r.ok,r.code??null]),[['same',false,'values-differ']]);
 assert(!JSON.stringify(differ).includes('synthetic'));
 const plan=[{kind:'same',a:{vaultId:id('va'),item:'Root A'},b:{vaultId:id('vb'),item:'Root B'}},{kind:'move',vaultId:id('va'),item:'Root A',toVaultId:id('vb')},{kind:'archive',vaultId:id('vb'),item:'Root A'},{kind:'delete-vault',vaultId:id('va')}];
 const done=await runTidy(run,{},plan);
 assert.deepEqual(done.results.map(r=>[r.kind,r.ok]),[['same',true],['move',true],['archive',true],['delete-vault',true]]);
 assert.equal(vaults[id('va')],undefined);assert.deepEqual(vaults[id('vb')].map(x=>x.title),['Root B']);
 vaults[id('vd')]=[{id:'z',title:'Keep'}];
 const refused=await runTidy(run,{},[{kind:'delete-vault',vaultId:id('vd')}]);
 assert.deepEqual(refused.results[0],{kind:'delete-vault',ok:false,code:'vault-not-empty'});
});
test('the broker service runs allowed op calls, refuses others and passes input',async t=>{
 if(!['linux','darwin'].includes(process.platform))return t.skip('POSIX only');
 const {mkdtemp,writeFile,chmod,rm,stat}=await import('node:fs/promises');const {join}=await import('node:path');const {spawn}=await import('node:child_process');
 const dir=await mkdtemp('/tmp/oxop-');const sock=join(dir,'s','broker.sock');const fake=join(dir,'op');
 await writeFile(fake,'#!/bin/sh\nfor a in "$@"; do [ "$a" = "fail" ] && exit 5; done\nprintf "%s|" "$@"; printf "stdin=%s" "$(cat)"; printf " bio=%s tok=%s" "$OP_BIOMETRIC_UNLOCK_ENABLED" "${OP_SERVICE_ACCOUNT_TOKEN:-none}"\n');await chmod(fake,0o755);
 const broker=spawn('python3',[new URL('./broker/op_broker.py',import.meta.url).pathname,'--op',fake,'--socket',sock],{stdio:'ignore',env:{...process.env,OP_SERVICE_ACCOUNT_TOKEN:'synthetic-leak'}});
 try{
  for(let i=0;i<100;i++){try{await stat(sock);break;}catch{await new Promise(r=>setTimeout(r,50));}}
  assert.equal((await stat(sock)).mode&0o777,0o600);assert.equal((await stat(join(dir,'s'))).mode&0o777,0o700);
  const run=brokerRunner(sock);
  const out=await run('op',['--account','A','item','get','x','--format=json'],{},'hello');
  assert.equal(out,'--account|A|item|get|x|--format=json|stdin=hello bio=true tok=none');
  await assert.rejects(run('op',['--account','A','run','--','sh'],{}),e=>e.message.includes('[broker-refused]'));
  await assert.rejects(run('op',['item','list'],{}),e=>e.message.includes('[broker-refused]'));
  await assert.rejects(run('op',['--account','A','fail'],{}),e=>e.message.includes('[broker-refused]'));
  await assert.rejects(run('op',['--account','A','item','list','fail'],{}),e=>e.message.includes('[op-exit]')&&e.message.includes('process exit 5'));
 }finally{broker.kill('SIGTERM');await new Promise(r=>setTimeout(r,200));await rm(dir,{recursive:true,force:true});}
 await assert.rejects(brokerRunner(sock)('op',['--account','A','whoami'],{}),e=>e.message.includes('[broker-unavailable]'));
});
test('agent commands find programs like a login shell and report a missing one by code',async()=>{
 assert(commandPath('/usr/bin:/bin').split(':').includes('/opt/homebrew/bin'));
 assert.equal(commandPath('/a:/opt/homebrew/bin').split(':').filter(x=>x==='/opt/homebrew/bin').length,1);
 assert.equal(await programAvailable('sh'),true);assert.equal(await programAvailable('definitely-not-a-program-xyz'),false);
 await assert.rejects(runCommand('definitely-not-a-program-xyz',[],{PATH:'/usr/bin'},undefined,1000),e=>e.message.includes('[command-not-found]'));
});
test('cancelling a broker call stops the running op before it can finish a change',async t=>{
 if(!['linux','darwin'].includes(process.platform))return t.skip('POSIX only');
 const {mkdtemp,writeFile,chmod,rm,stat,access}=await import('node:fs/promises');const {join}=await import('node:path');const {spawn}=await import('node:child_process');
 const dir=await mkdtemp('/tmp/oxop-');const sock=join(dir,'s','b.sock');const fake=join(dir,'op');const mark=join(dir,'changed');
 await writeFile(fake,'#!/bin/sh\nsleep 1.5\ntouch '+mark+'\necho done\n');await chmod(fake,0o755);
 const broker=spawn('python3',[new URL('./broker/op_broker.py',import.meta.url).pathname,'--op',fake,'--socket',sock],{stdio:'ignore'});
 try{
  for(let i=0;i<100;i++){try{await stat(sock);break;}catch{await new Promise(r=>setTimeout(r,50));}}
  const controller=new AbortController();
  const pending=brokerRunner(sock)('op',['--account','A','vault','delete','v'],{},undefined,controller.signal).catch(e=>e.message);
  await new Promise(r=>setTimeout(r,300));controller.abort();
  assert((await pending).includes('[cancelled]'));
  await new Promise(r=>setTimeout(r,2000));
  await assert.rejects(access(mark),'the cancelled command must not complete its change');
  assert.equal(await brokerRunner(sock)('op',['--account','A','whoami'],{}),'done\n','the broker keeps serving after a cancellation');
 }finally{broker.kill('SIGTERM');await new Promise(r=>setTimeout(r,200));await rm(dir,{recursive:true,force:true});}
});
