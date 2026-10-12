import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {integrationContract,type IntegrationName} from './integrations-contract';
export function setupIntegrations(bb:BbPluginApi) {
 const settings=bb.settings.define({
  enableMemory:{type:'boolean',label:'Память проекта (oxi-memory)',default:false},
  enableAutopilot:{type:'boolean',label:'Автопилот и сверка каталога (oxi-autopilot)',default:false},
  enableTasknotes:{type:'boolean',label:'Задачи Obsidian (TaskNotes)',default:false}
 });
 async function status(){const s=await settings.get();return {memory:s.enableMemory,autopilot:s.enableAutopilot,tasknotes:s.enableTasknotes};}
 settings.onChange(()=>bb.realtime.publish('project-integrations:changed',{}));
 bb.rpc.register(integrationContract,{
  integrationStatus:status,
  saveIntegrations:async value=>{await settings.experimental_set({enableMemory:value.memory,enableAutopilot:value.autopilot,enableTasknotes:value.tasknotes});return status();}
 });
 return {
  enabled:async(name:IntegrationName)=>(await status())[name],
  require:async(name:IntegrationName)=>{if(!(await status())[name])throw Error(`Подключение ${name} выключено. Включи его в настройках BB Projects.`);}
 };
}
export type Integrations=ReturnType<typeof setupIntegrations>;
