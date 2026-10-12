import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {memoryContract} from './memory-contract.ts';
export function setupMemory(bb:BbPluginApi,requireEnabled:()=>Promise<void>=async()=>{}) {
 bb.rpc.register(memoryContract,{
  memoryInspect:async input=>{await requireEnabled();return bb.sdk.plugins.callRpc({pluginId:'oxi-memory',method:'memoryInspect',input,outputSchema:memoryContract.memoryInspect.output});},
  memorySave:async input=>{await requireEnabled();return bb.sdk.plugins.callRpc({pluginId:'oxi-memory',method:'memorySave',input,outputSchema:memoryContract.memorySave.output});},
 });
}
