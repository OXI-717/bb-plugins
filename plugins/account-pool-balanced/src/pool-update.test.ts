import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,it,expect,vi} from 'vitest';
import {PoolUpdate} from './pool-update.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();});
async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'pool-update-'));
  cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const pluginRoot=path.join(root,'plugins','pool');
  await mkdir(pluginRoot,{recursive:true});await mkdir(path.join(root,'scripts'));
  await writeFile(path.join(root,'scripts','upgrade-pool.sh'),'# synthetic updater; never executed\n');
  let terminal={id:'terminal-one',status:'running',exitCode:null as number|null};
  const create=vi.fn(async(_input:unknown)=>terminal);
  const host=createFakePluginHost({pluginId:'account-pool',sdk:{
    system:{config:async()=>({primaryHostId:'host-one'})},
    plugins:{list:async()=>({plugins:[{id:'account-pool',enabled:true,rootDir:pluginRoot},{id:'pool-maintenance',enabled:true}]})},
    terminals:{create,get:async()=>terminal,list:async()=>({sessions:[]})},
  }});
  cleanup.push(()=>host.harness.lifecycle.dispose());
  return {host,create,pluginRoot,controller:new PoolUpdate(host.bb),exit:(exitCode:number)=>{terminal={...terminal,status:'exited',exitCode};}};
}
it('starts exactly one BB-owned machine terminal and follows it across plugin reload',async()=>{
  const f=await fixture();
  const [first,second]=await Promise.all([f.controller.start(),f.controller.start()]);
  expect(first).toEqual(second);expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.create.mock.calls[0]?.[0]).toMatchObject({scope:{kind:'host_path',hostId:'host-one',cwd:f.pluginRoot},start:{mode:'command',command:expect.stringContaining('--pause-sessions')}});
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
