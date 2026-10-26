import { cliCommand,defineCli,type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { MaintenanceLease } from './lease.js';
export default async function plugin(bb:BbPluginApi){
  const lease=new MaintenanceLease(value=>bb.storage.kv.set('pause',value));
  await lease.initialize(await bb.storage.kv.get('pause'));
  bb.experimental_hooks.on('message.dispatch',()=>{
    const current=lease.status();
    return current?{action:'wait',reason:'Обновление пула: сессии на паузе, сообщения ждут в очереди.',sendAt:current.expiresAt}:{action:'proceed'};
  });
  const output=()=>({lease:lease.status(),scope:'all-hosts-all-projects',schemaVersion:1});
  const owner={owner:{type:'string' as const,required:true,description:'UUID of the maintenance operation'},json:{type:'boolean' as const,description:'Emit JSON'}};
  bb.cli.register(defineCli({name:'pool-maintenance',summary:'Queue session messages during bounded pool maintenance',commands:{
    status:cliCommand({summary:'Inspect maintenance pause metadata',options:{json:{type:'boolean',description:'Emit JSON'}},async run(){return {exitCode:0,stdout:JSON.stringify(output())};}}),
    acquire:cliCommand({summary:'Pause dispatch on all hosts for at most 30 minutes',options:owner,async run(input){await lease.acquire(z.uuid().parse(input.options.owner));return {exitCode:0,stdout:JSON.stringify(output())};}}),
    release:cliCommand({summary:'Release only this operation pause and continue queued messages',options:owner,async run(input){await lease.release(z.uuid().parse(input.options.owner));await bb.experimental_hooks.recheck('message.dispatch');return {exitCode:0,stdout:JSON.stringify(output())};}})
  }}));
}
