import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {catalogContract,catalogHostContract,compare,type PanelEntry} from './catalog-contract.js';

export function setupCatalog(bb:BbPluginApi,readPanel:()=>Promise<PanelEntry[]>,requireEnabled:()=>Promise<void>=async()=>{}){
 const settings=bb.settings.define({catalogHost:{type:'string',label:'Хост сверки каталога (autopilot.conf и чекауты)',default:''}});
 const client=bb.hosts.experimental_client({contract:catalogHostContract});const abort=new AbortController();bb.onDispose(()=>abort.abort());
 async function check(){
  await requireEnabled();
  const {catalogHost}=await settings.get();
  if(!catalogHost)throw Error('Хост сверки не настроен: bb plugin config oxi-projects set catalogHost <host_id>');
  const all=(await bb.sdk.projects.list({includePersonal:false})).filter(p=>p.kind==='standard');
  const bbProjects=all.map(p=>({id:p.id,name:p.name,sources:p.sources.filter(s=>s.hostId===catalogHost).map(s=>({path:s.path}))}));
  const local=await client.call('catalogLocal',{sourcePaths:bbProjects.flatMap(p=>p.sources.map(s=>s.path))},{hostId:catalogHost,timeoutMs:45000,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(40000)])});
  return {findings:compare(local,await readPanel(),bbProjects),checkedAt:Date.now()};
 }
 async function jiraEnv(path:string,prefix:string|undefined){
  const {catalogHost}=await settings.get();
  if(!catalogHost)throw Error('Хост сверки не настроен: bb plugin config oxi-projects set catalogHost <host_id>');
  return client.call('jiraEnv',{path,prefix},{hostId:catalogHost,timeoutMs:20000,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(15000)])});
 }
 bb.rpc.register(catalogContract,{catalogCheck:async({projectId})=>{const report=await check();return projectId?{...report,findings:report.findings.filter(f=>f.projectIds.includes(projectId))}:report;}});
 return {check,jiraEnv};
}
