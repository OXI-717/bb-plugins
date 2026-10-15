import {parseProjectCatalog,LegacyAccountSelectionError} from './github/catalog-compat';
import {setupIntegrations,type Integrations} from './integrations-server.js';
import {setupMemory} from './memory-server.js';
import {notesContract,notesHostContract,notesConnection} from "./tasknotes-contract.js";
import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {z} from 'zod';
import {project,type Project,contract as githubContract} from './github/contract.js';
import {accounts,accountClient,listProject,readItem,makeRunner} from './github/api.js';
import {rpcContract as autopilotContract} from './autopilot/contract.js';
import {workspaceContract} from './workspace-contract.js';
export async function setupWorkspace(bb:BbPluginApi,integrations:Integrations=setupIntegrations(bb)) {
 setupMemory(bb,()=>integrations.require('memory'));
 const settings=bb.settings.define({projects:{type:'string',label:'Подключения проектов',experimental_multiline:true,default:'[]'}});
 const controller=new AbortController();bb.onDispose(()=>controller.abort());const runner=makeRunner(controller.signal);
 const parse=parseProjectCatalog;
 const read=async()=>parse((await settings.get()).projects);
 const migrated=await bb.storage.kv.get<boolean>('catalog-migrated-v1');
 let catalogMigrationIssue:string|null=null;
 if(!migrated) {
  let stage:'fetch'|'parse'|'save'='fetch';
  try {
   const previous=await bb.sdk.plugins.getSettings({pluginId:'oxi-github'});
   stage='parse';
   const imported=parse(String(previous.values.projects??'[]'));
   stage='save';
   if(!(await read()).length&&imported.length) {
    await bb.storage.kv.set('catalog-before-migration-v1',imported);
    await settings.experimental_set({projects:JSON.stringify(imported)});
   }
   await bb.storage.kv.set('catalog-migrated-v1',true);
  } catch(error) {
   if(error instanceof LegacyAccountSelectionError)catalogMigrationIssue=error.message;
   else if(stage==='parse')catalogMigrationIssue='Прежний каталог имеет неверный формат. Проверь его JSON и перезагрузи плагин; исходные настройки сохранены.';
   else if(stage==='save')catalogMigrationIssue='Импорт каталога не подтверждён. Исходные настройки сохранены; повтори после перезагрузки плагина.';
   bb.log.warn(catalogMigrationIssue??'Каталог GitHub не импортирован: источник недоступен. Повтор при следующем запуске.');
  }
 }
 async function get(id:string){const value=(await read()).find(p=>p.id===id);if(!value)throw Error('Подключение проекта не найдено');return value;}
 async function forBb(id:string):Promise<Project> {
  const matches=(await read()).filter(p=>p.bbProjectId===id);
  const repositories=matches.flatMap(p=>p.repositories);
  const dedup=new Map<string,typeof repositories[number]>();
  for(const r of repositories){const key=r.repo.toLowerCase();const old=dedup.get(key);if(old&&old.account!==r.account)throw Error(`Конфликт аккаунтов для ${r.repo}`);dedup.set(key,r);}
  return {id,name:matches.map(p=>p.name).join(', ')||id,bbProjectId:id,autopilotProject:null,repositories:[...dedup.values()]};
 }
 let onChange:(ids:string[])=>void=()=>{};
 let saveQueue=Promise.resolve();
 const handlers:Record<string,any>={
  workspaceHosts:async()=> (await bb.sdk.hosts.list()).map(h=>({id:h.id,name:h.name})),
  github_catalog:async()=>{let names:string[]=[];let accountError:string|null=catalogMigrationIssue;try{names=await accounts(runner);}catch(e){accountError=[catalogMigrationIssue,String(e)].filter(Boolean).join(' · ');}return {projects:await read(),accounts:names,accountError};},
  github_saveProject:async(input:Project)=>{const task=saveQueue.then(async()=>{const all=await read();await settings.experimental_set({projects:JSON.stringify([...all.filter(p=>p.id!==input.id),input])});onChange([...new Set([all.find(p=>p.id===input.id)?.bbProjectId,input.bbProjectId].filter((id):id is string=>!!id))]);bb.realtime.publish('data-changed',{});});saveQueue=task.catch(()=>{});await task;return input;},
  github_list:async(input:any)=>listProject(await get(input.projectId),input,runner),
  github_read:async(input:any)=>readItem(await get(input.projectId),input,runner),
 };
 for(const [method,entry] of Object.entries(autopilotContract))handlers['autopilot_'+method]=async(input:any)=>{await integrations.require('autopilot');return bb.sdk.plugins.callRpc({pluginId:'oxi-autopilot',method,input,outputSchema:entry.output as z.ZodType<any>});};
 handlers.autopilot_dispatch=async(input:any)=>{
   await integrations.require('autopilot');
   const mapped=[...new Set((await read()).filter(p=>p.autopilotProject===input.project).map(p=>p.bbProjectId).filter((id):id is string=>!!id))];
   if(mapped.length!==1)throw Error('Сначала однозначно привяжи проект автопилота к проекту BB в настройках');
   const template=(await bb.sdk.threads.list({projectId:mapped[0],archived:false,limit:50})).find(t=>t.providerId&&t.environmentId);
   if(!template)throw Error('Нужен тред этого проекта с настроенным окружением');
   return bb.sdk.plugins.callRpc({pluginId:'oxi-autopilot',method:'dispatch',input:{...input,templateThreadId:template.id},outputSchema:autopilotContract.dispatch.output});
 };
 bb.rpc.register(workspaceContract,handlers as any);
 const notesClient=bb.hosts.experimental_client({contract:notesHostContract});
 async function connection(projectId:string,connectionId:string){await integrations.require('tasknotes');const matches=(await read()).filter(p=>p.bbProjectId===projectId).flatMap(p=>p.integrations??[]).filter(i=>i.id===connectionId&&i.kind==='tasknotes');if(matches.length!==1)throw Error('Подключение TaskNotes не найдено или неоднозначно');return notesConnection.parse(matches[0]);}
 async function notesRead(projectId:string,connectionId:string,path:string){const c=await connection(projectId,connectionId);return notesClient.call('read',{connection:c,path},{hostId:c.hostId,timeoutMs:60000,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(55000)])});}
 bb.rpc.register(notesContract,{notesList:async({projectId,connectionId})=>{const c=await connection(projectId,connectionId);return notesClient.call('list',c,{hostId:c.hostId,timeoutMs:35000,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});},notesRead:({projectId,connectionId,path})=>notesRead(projectId,connectionId,path)});
 async function githubStatus(){const all=await read();return {ghOk:true,ghState:'ready' as const,ghError:null,lastSyncedAt:null,repos:all.flatMap(p=>p.repositories.map(r=>({repo:r.repo,projectId:p.bbProjectId})))};}
 async function ghForRepo(projectId:string,repo:string){const p=await forBb(projectId);const r=p.repositories.find(r=>r.repo===repo);if(!r)throw Error('Репозиторий не привязан к проекту');return accountClient(r.account,runner);}
 function scopedGithub(projectId:string):BbPluginApi {
  return {...bb,sdk:{...bb.sdk,plugins:{...bb.sdk.plugins,callRpc:async(args:any)=>{
   if(args.pluginId!=='github')return bb.sdk.plugins.callRpc(args);
   const input=args.input??{};let result:any;
   if(args.method==='status')result=await githubStatus();
   else if(args.method==='refresh')result={repos:(await forBb(projectId)).repositories.length,items:0};
   else if(args.method==='listItems'){
    const p=await forBb(projectId);const listed=await listProject(p,{projectId,repos:[input.repo],account:null,kind:'issue',state:'all'},runner);
    if(listed.errors.length)throw Error(listed.errors.map(e=>`${e.repo}: ${e.message}`).join('; '));
    if(listed.limited.length)throw Error(`GitHub вернул неполный список для: ${listed.limited.join(', ')}`);
    result={items:listed.items.map(({account,...i})=>i)};
   } else if(args.method==='getIssue') result={issue:await readItem(await forBb(projectId),{...input,kind:'issue'},runner)};
   else if(args.method==='setIssueState') {const gh=await ghForRepo(projectId,input.repo);await gh(['issue',input.state==='closed'?'close':'reopen',String(input.number),'-R',input.repo]);result={ok:true};}
   else throw Error(`Unsupported project GitHub method: ${args.method}`);
   return args.outputSchema.parse(result);
  }}}} as BbPluginApi;
 }
 function cli(projectId:string){return async(args:string[],timeout?:number)=>{const endpoint=args.find(a=>a.startsWith('repos/'));const repo=endpoint?.match(/^repos\/([^/]+\/[^/?]+)/)?.[1];if(!repo)throw Error('GitHub-запрос не содержит репозиторий проекта');return (await ghForRepo(projectId,repo))(args,timeout);};}
 return {read,forBb,notesRead,githubStatus,scopedGithub,cli,onCatalogChange:(fn:(ids:string[])=>void)=>{onChange=fn;}};
}
