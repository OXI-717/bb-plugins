import {useIntegrations,IntegrationSettings} from './integrations-view';
import {MemorySettings} from './memory-settings';
import {ChatWatch} from './chat-watch-view';
import {NotesSettings} from "./notes-settings";
import {CatalogDrift} from './catalog-view';
import {TaskNotesView} from "./tasknotes-view";
import {useEffect,useState,type ReactNode} from 'react';
import {useRpc,useBbNavigate,useBbContext} from '@get-bb/plugin-sdk/app';
import {taskboardRpcContract,sourceName} from './contract';
import {workspaceContract} from './workspace-contract';
import type {Project} from './github/contract';
import {ProjectView,Editor} from './github/app';
import {ProjectPanel} from './autopilot/project-panel';
import {workSummary,observedSummary} from './autopilot/work';
import type {Row,DetailState} from './autopilot/view';
import {Button} from './components/ui/button';
export function CatalogSettings({projectId}:{projectId:string|null}) {
 const features=useIntegrations();
 const rpc=useRpc<typeof workspaceContract>();
 const [projects,setProjects]=useState<Project[]>([]),[accounts,setAccounts]=useState<string[]>([]),[editor,setEditor]=useState<Project|null>(null),[error,setError]=useState(''),[saved,setSaved]=useState<string|null>(null);
 useEffect(()=>{let live=true;rpc.call('github_catalog').then(r=>{if(live){setProjects(r.projects);setAccounts(r.accounts);setError(r.accountError??'');}},e=>{if(live)setError(String(e));});return()=>{live=false;};},[rpc,projectId]);
 useEffect(()=>{setEditor(null);setSaved(null);},[projectId]);
 const shown=projects.filter(p=>p.bbProjectId===projectId);
 const unlinked=projectId?projects.filter(p=>!p.bbProjectId):[];
 // Сохранённая запись остаётся на своём месте в списке, а не уезжает в конец.
 const store=async(value:Project)=>{const next=await rpc.call('github_saveProject',value);setProjects(old=>old.some(p=>p.id===next.id)?old.map(p=>p.id===next.id?next:p):[...old,next]);return next;};
 const open=(value:Project)=>{setSaved(null);setEditor(value);};
 // Редактор и итог сохранения — прямо под строкой, по которой кликнули.
 const inline=(id:string)=><>{editor?.id===id&&<Editor key={editor.id} showAutopilot={features.autopilot} initial={editor} accounts={accounts} onCancel={()=>setEditor(null)} onSave={async value=>{const next=await store(value);setEditor(cur=>cur?.id===value.id?null:cur);setSaved(next.id);}}/>}{saved===id&&editor?.id!==id&&<p role="status" className="text-sm text-muted-foreground">Сохранено.</p>}</>;
 const row=(p:Project,label:string,value:Project)=><div key={p.id} className="space-y-2"><div className="flex flex-wrap gap-2 items-center"><span>{p.name} · {p.repositories.length} репозиториев</span><Button size="sm" variant="outline" aria-expanded={editor?.id===p.id} onClick={()=>editor?.id===p.id?setEditor(null):open(value)}>{editor?.id===p.id?'Свернуть':label}</Button></div>{inline(p.id)}</div>;
 const fresh=editor&&!projects.some(p=>p.id===editor.id)?editor.id:null;
 return <section className="p-4 space-y-3"><h2 className="font-semibold">Подключения проекта</h2>{error&&<p role="alert">{error}</p>}<IntegrationSettings/>{features.autopilot&&<CatalogDrift projectId={projectId}/>} {features.memory&&projectId&&<MemorySettings projectId={projectId}/>}
 {shown.map(p=>row(p,'Настроить',p))}
 {unlinked.length>0&&<details className="rounded border border-border p-2 text-sm"><summary className="cursor-pointer text-muted-foreground">Не привязаны ни к одному проекту BB ({unlinked.length})</summary><div className="mt-2 space-y-2">{unlinked.map(p=>row(p,'Привязать к этому проекту',{...p,bbProjectId:projectId}))}</div></details>}
 <Button variant="outline" disabled={!projectId||!!fresh} onClick={()=>open({id:crypto.randomUUID(),name:'Новый проект',bbProjectId:projectId,autopilotProject:null,repositories:[]})}>Добавить подключение</Button>
 {fresh&&inline(fresh)}
 {features.tasknotes&&shown.map(p=><NotesSettings key={p.id} project={p} onSave={async value=>{await store(value);}}/>)}</section>;
}
function AutopilotProject({projects}:{projects:Project[]}) {
 const rpc=useRpc<typeof workspaceContract>();const [rows,setRows]=useState<Row[]>([]),[selected,setSelected]=useState(''),[detail,setDetail]=useState<DetailState|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 const names=projects.map(p=>p.autopilotProject).filter(Boolean),key=JSON.stringify(names);
 useEffect(()=>{let live=true;const load=async()=>{try{const result=await rpc.call('autopilot_status');if(!live)return;setRows(result.snapshots.flatMap(snapshot=>(snapshot.data?.status.projects??[]).filter(p=>names.includes(p.name)).map(project=>{const runs=(snapshot.data?.runs??[]).filter(r=>r.project===project.name);return {key:`${snapshot.source.id}/${project.name}`,snapshot,project,runs,summary:observedSummary(result.projectObservations?.find(o=>o.sourceId===snapshot.source.id&&o.project===project.name),workSummary(project.state,runs,project.local,Date.now()),Date.now(),runs.find(r=>r.phase==="Задачи")?.at)};})));setError('');}catch(e){if(live)setError(String(e));}};void load();const timer=setInterval(load,15000);return()=>{live=false;clearInterval(timer);};},[rpc,key]);
 const row=rows.find(r=>r.key===selected)??rows[0];
 useEffect(()=>{let live=true;setDetail(null);if(!row)return;const load=async()=>{try{const value=await rpc.call('autopilot_project',{sourceId:row.snapshot.source.id,project:row.project.name});if(live)setDetail(value);}catch(e){if(live)setDetail({data:null,error:String(e),loading:false});}};void load();const timer=setInterval(load,5000);return()=>{live=false;clearInterval(timer);};},[rpc,row?.key,revision]);
 return <div className="p-4 space-y-3"><ChatWatch/>{error&&<p role="alert">{error}</p>}{rows.length>1&&<select aria-label="Источник автопилота" value={row?.key} onChange={e=>setSelected(e.target.value)}>{rows.map(r=><option key={r.key} value={r.key}>{r.project.name} · {r.snapshot.source.label}</option>)}</select>}{row?<ProjectPanel bbProjectId={projects[0]?.bbProjectId??undefined} row={row} detail={detail} now={Date.now()} reload={()=>{void rpc.call('autopilot_project',{sourceId:row.snapshot.source.id,project:row.project.name,refresh:true});setRevision(v=>v+1);}} savePlan={async plan=>{await rpc.call('autopilot_saveModelPlan',{sourceId:row.snapshot.source.id,project:row.project.name,plan,...(!row.project.local&&row.project.fleetRevision?{fleetRevision:row.project.fleetRevision}:{})});setRevision(v=>v+1);}}/>:<p className="text-sm text-muted-foreground">{names.length?'Состояние автопилота загружается или источник недоступен.':'Автопилот для этого проекта не привязан.'}</p>}</div>;
}
export function WorkspaceFrame({projectId,children,initialView='tasks'}:{projectId:string|null|undefined;children:ReactNode;initialView?:'tasks'|'prs'|'autopilot'|'settings'}) {
 const features=useIntegrations();
 const rpc=useRpc<typeof workspaceContract>();const navigate=useBbNavigate();
 const trackerRpc=useRpc<typeof taskboardRpcContract>();
 const [tracker,setTracker]=useState<string|null>(null);
 useEffect(()=>{let live=true;setTracker(null);setTaskSource('tracker');if(projectId)trackerRpc.call('getProjectConfig',{projectId}).then(r=>{if(live)setTracker(r.config.sources[0]?.source??null);},e=>{if(live)setError(String(e));});return()=>{live=false;};},[trackerRpc,projectId]);
 const [taskSource,setTaskSource]=useState('tracker');
 const [view,setView]=useState(initialView),[projects,setProjects]=useState<Project[]>([]),[selected,setSelected]=useState(''),[error,setError]=useState('');
 useEffect(()=>{if(!features.autopilot&&view==='autopilot')setView('tasks');if(!features.tasknotes&&taskSource==='notes')setTaskSource('tracker');},[features.autopilot,features.tasknotes,view,taskSource]);
 useEffect(()=>{let live=true;setProjects([]);setSelected('');rpc.call('github_catalog').then(r=>{if(live)setProjects(r.projects.filter(p=>p.bbProjectId===projectId));},e=>{if(live)setError(String(e));});return()=>{live=false;};},[rpc,projectId]);
 if(!projectId)return <>{children}</>;
 const active=projects.find(p=>p.id===selected)??projects[0];
 return <div className="flex min-h-0 h-full flex-col"><div className="flex flex-wrap gap-1 border-b border-border px-3 py-2 shrink-0">{(['tasks','prs',...(features.autopilot?['autopilot'] as const:[]),'settings'] as const).map(v=><Button key={v} size="sm" variant={view===v?'default':'outline'} onClick={()=>{if(v==='settings')navigate.toPluginPanel('tasks',{subPath:`manage/${encodeURIComponent(projectId)}`});else setView(v);}}>{{tasks:'Задачи',prs:'PR',autopilot:'Автопилот',settings:'Настройки'}[v]}</Button>)}</div>
 <div className="flex-1 min-h-0 overflow-auto">{error&&<p role="alert">{error}</p>}{view==='tasks'?<><div className="flex gap-2 p-2"><Button size="sm" variant={taskSource==='tracker'?'default':'outline'} onClick={()=>setTaskSource('tracker')}>{tracker?sourceName(tracker as any):'Трекер'}</Button>{tracker!=='github'&&projects.some(p=>p.repositories.length>0)&&<Button size="sm" variant={taskSource==='github'?'default':'outline'} onClick={()=>setTaskSource('github')}>GitHub Issues</Button>}{features.tasknotes&&projects.some(p=>p.integrations?.some(i=>i.kind==='tasknotes'))&&<Button size="sm" variant={taskSource==='notes'?'default':'outline'} onClick={()=>setTaskSource('notes')}>TaskNotes</Button>}</div>{taskSource==='tracker'?children:taskSource==='github'?<div className="p-4 space-y-3">{projects.length>1&&<select aria-label="Группа репозиториев задач" value={active?.id} onChange={e=>setSelected(e.target.value)}>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>}{active&&<ProjectView key={`${active.id}/issues`} project={active} itemKind="issue"/>}</div>:<TaskNotesView key={projectId} projectId={projectId} connections={projects.flatMap(p=>p.integrations??[]).filter(i=>i.kind==='tasknotes')}/>}</>:view==='autopilot'&&features.autopilot?<AutopilotProject projects={projects}/>:<div className="p-4 space-y-3">{projects.length>1&&<select aria-label="Группа репозиториев" value={active?.id} onChange={e=>setSelected(e.target.value)}>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>}{active?<ProjectView key={`${active.id}/prs`} project={active} itemKind="pr"/>:<p>У проекта пока нет подключённых репозиториев. Открой настройки проекта.</p>}</div>}</div></div>;
}
export function ProjectHome({projectId}:{projectId:string|null}) {const navigate=useBbNavigate();if(!projectId)return null;return <div className="flex gap-2 flex-wrap"><Button onClick={()=>navigate.toPluginPanel('tasks',{subPath:encodeURIComponent(projectId)})}>Работа проекта</Button><Button variant="outline" onClick={()=>navigate.toPluginPanel('tasks',{subPath:`manage/${encodeURIComponent(projectId)}`})}>Подключения и настройки</Button></div>;}
