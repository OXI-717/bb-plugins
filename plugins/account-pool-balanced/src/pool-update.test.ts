import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {mkdtemp,mkdir,writeFile,rm,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,it,expect,vi} from 'vitest';
import {PoolUpdate} from './pool-update.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();});
async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'pool-update-'));
  cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const checkout=path.join(root,'checkout'), dataDir=path.join(root,'state');
  const pluginRoot=path.join(checkout,'plugins','pool');
  await mkdir(pluginRoot,{recursive:true});await mkdir(path.join(checkout,'scripts'));
  for(const name of ['upgrade-pool.sh','upgrade_pool.py','pool_session_pause.py','upgrade_pool_sandbox.py'])
    await writeFile(path.join(checkout,'scripts',name),'# synthetic updater; never executed\n');
  await writeFile(path.join(checkout,'scripts','upgrade-pool.sh'),'# synthetic updater\nexec python3 "$(dirname "$0")/upgrade_pool.py" "$@"\n');
  await writeFile(path.join(checkout,'scripts','upgrade_pool.py'),'# synthetic updater\nfrom pool_session_pause import result\nprint(result)\n');
  await writeFile(path.join(checkout,'scripts','pool_session_pause.py'),'# synthetic updater\nresult = "MODULES_OK"\n');
  let terminal={id:'terminal-one',status:'running',exitCode:null as number|null};
  const create=vi.fn(async(_input:unknown)=>terminal);
  const host=createFakePluginHost({pluginId:'account-pool',dataDir,sdk:{
    system:{config:async()=>({primaryHostId:'host-one'})},
    plugins:{list:async()=>({plugins:[{id:'account-pool',enabled:true,rootDir:pluginRoot},{id:'pool-maintenance',enabled:true}]})},
    terminals:{create,get:async()=>terminal,list:async()=>({sessions:[]})},
  }});
  cleanup.push(()=>host.harness.lifecycle.dispose());
  return {host,create,pluginRoot,checkout,dataDir,controller:new PoolUpdate(host.bb),exit:(exitCode:number)=>{terminal={...terminal,status:'exited',exitCode};}};
}
it('starts exactly one BB-owned machine terminal and follows it across plugin reload',async()=>{
  const f=await fixture();
  const [first,second]=await Promise.all([f.controller.start(),f.controller.start()]);
  expect(first).toEqual(second);expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.create.mock.calls[0]?.[0]).toMatchObject({scope:{kind:'host_path',hostId:'host-one',cwd:path.join(f.dataDir,'plugins','account-pool','updates',first!.operationId)},start:{mode:'command',command:expect.stringContaining('--pause-sessions')}});
  const reloaded=new PoolUpdate(f.host.bb);
  expect(await reloaded.start()).toEqual(first);expect(f.create).toHaveBeenCalledTimes(1);
  f.exit(0);expect(await reloaded.status()).toMatchObject({state:'succeeded',terminalId:'terminal-one'});
});
it('retains an ambiguous creation receipt and never dispatches another updater',async()=>{
  const f=await fixture();
  f.create.mockRejectedValueOnce(Error('lost reply'));
  await expect(f.controller.start()).rejects.toThrow('outcome is unknown');
  expect(await new PoolUpdate(f.host.bb).start()).toMatchObject({state:'unknown',terminalId:null});
  expect(f.create).toHaveBeenCalledTimes(1);
});
it('does not report a failed updater as success',async()=>{
  const f=await fixture();await f.controller.start();f.exit(1);
  expect(await f.controller.status()).toMatchObject({state:'failed'});
});

it('retains executable inputs and a usable cwd after BB removes the old source checkout',async()=>{
  const f=await fixture();const operation=await f.controller.start();
  const cwd=path.join(f.dataDir,'plugins','account-pool','updates',operation!.operationId);
  const input=f.create.mock.calls[0]![0] as {scope:{cwd:string};start:{command:string}};
  await rm(f.checkout,{recursive:true,force:true});
  const result=await promisify(execFile)('/bin/bash',[path.join(input.scope.cwd,'upgrade-pool.sh'),'--pause-sessions'],{cwd:input.scope.cwd,timeout:5000});
  expect(result.stdout.trim()).toBe('MODULES_OK');
  expect(input.scope.cwd).toBe(cwd);expect(input.start.command).toContain(path.join(cwd,'upgrade-pool.sh'));
  expect(input.start.command).not.toContain(f.checkout);
  for(const name of ['upgrade-pool.sh','upgrade_pool.py','pool_session_pause.py','upgrade_pool_sandbox.py']){
    expect(await readFile(path.join(cwd,name),'utf8')).toContain('synthetic updater');
    expect((await stat(path.join(cwd,name))).mode&0o777).toBe(0o600);
  }
});
