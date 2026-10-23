import {MachineGlyph} from './machine-glyph';
import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {experimental_useSidebarThreads,useRpc,useSettings,type PluginAppBuilder,type PluginThreadHeaderActionProps} from '@get-bb/plugin-sdk/app';
import {machineMarksContract,type MachineMarksView} from './machine-marks-contract';
import {defaultMachineMarksConfig,MACHINE_MARKS_SETTING,machineIcons,machineKinds,machineMarkStyle,parseMachineMarksConfig,resolveMachineMark,type MachineHost,type MachineMarksConfig,type MachineRole} from './machine-marks';
import {machineMarkStore,mountMachineMarks} from './machine-marks-dom';

const lifecycles={experimental_lifecycles:['active','archived'] as const};
function useMarkConfig(){const {values}=useSettings();const raw=values?.[MACHINE_MARKS_SETTING];return useMemo(()=>parseMachineMarksConfig(raw),[raw]);}
export function MachineMarksController(){
 const {threads,status}=experimental_useSidebarThreads(lifecycles);const config=useMarkConfig();
 useEffect(()=>{machineMarkStore.set(status==='ready'?threads:[],config);},[threads,status,config]);
 useEffect(()=>()=>machineMarkStore.set([],null),[]);return null;
}
export function MachineHeaderMark({threadId}:PluginThreadHeaderActionProps){
 const config=useMarkConfig();const {threads}=experimental_useSidebarThreads(lifecycles);const rpc=useRpc<typeof machineMarksContract>();
 const known=threads.find(t=>t.id===threadId);const [fallback,setFallback]=useState<{threadId:string;host:MachineHost|null;failed:boolean}|null>(null);const [open,setOpen]=useState(false);
 useEffect(()=>{
  let cancelled=false;setFallback(null);setOpen(false);
  if(config?.enabled&&!known)void rpc.call('machineMarkThread',{threadId}).then(result=>{if(!cancelled)setFallback({threadId,host:result.host,failed:false});}).catch(()=>{if(!cancelled)setFallback({threadId,host:null,failed:true});});
  return ()=>{cancelled=true;};
 },[threadId,known,config?.enabled,rpc]);
 if(!config?.enabled)return null;
 const mark=resolveMachineMark(known?.host??(fallback?.threadId===threadId?fallback.host:null),config);
 const label=mark?.label??(fallback?.failed?'Не удалось определить машину':'Машина не назначена или ещё определяется');
 return <span style={{position:'relative',display:'inline-flex'}}><button type="button" style={mark?machineMarkStyle(mark.kind):undefined} aria-label={label} title={label} aria-expanded={open} onClick={()=>setOpen(!open)} onBlur={()=>setOpen(false)} onKeyDown={e=>{if(e.key==='Escape')setOpen(false);}} className="inline-flex size-7 items-center justify-center rounded text-xs hover:bg-muted">{mark?<MachineGlyph icon={mark.icon}/>: '?'}</button>{open?<span role="tooltip" className="absolute right-0 top-full z-50 mt-1 w-max max-w-64 rounded border bg-popover p-2 text-xs text-popover-foreground">{label}</span>:null}</span>;
}
export function MachineMarksSettings(){
 const rpc=useRpc<typeof machineMarksContract>();const [view,setView]=useState<MachineMarksView|null>(null);const [draft,setDraft]=useState<MachineMarksConfig|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [message,setMessage]=useState<string|null>(null);const generation=useRef(0);
 const load=useCallback(async()=>{
  const run=++generation.current;setBusy(true);setError(null);setMessage(null);
  try{const next=await rpc.call('machineMarksRead',{});if(run!==generation.current)return false;setView(next);setDraft(next.config);if(next.error)setError(next.error);return true;}
  catch{if(run===generation.current)setError('Не удалось загрузить настройки и список машин. Повторите загрузку.');return false;}
  finally{if(run===generation.current)setBusy(false);}
 },[rpc]);
 useEffect(()=>{void load();return ()=>{generation.current++;};},[load]);
 async function save(){
  if(!view||!draft)return;const run=++generation.current;setBusy(true);setError(null);setMessage(null);
  try{await rpc.call('machineMarksSave',{config:draft,revision:view.revision});if(run!==generation.current)return;if(await load())setMessage('Значки сохранены.');}
  catch{if(run===generation.current)setError('Не удалось сохранить. Настройки могли измениться в другом окне; загрузите их заново.');}
  finally{if(run===generation.current)setBusy(false);}
 }
 const hosts=view?[...view.hosts,...Object.keys(draft?.hosts??{}).filter(id=>!view.hosts.some(h=>h.id===id)).map(id=>({id,name:`${id} — отсутствует в списке`}))]:[];
 function change(id:string,role:MachineRole){setDraft(current=>current?{...current,hosts:{...current.hosts,[id]:role}}:null);setMessage(null);}
 return <div className="space-y-3 text-sm">
  <p className="text-muted-foreground">Значок показывает, где выполняется тред. Названия тредов, значки моделей и статус работы сохраняются.</p>
  {error?<p role="alert" className="text-destructive">{error}</p>:null}{message?<p role="status">{message}</p>:null}
  <button type="button" disabled={busy} onClick={()=>void load()} className="rounded border px-3 py-1.5">{busy?'Загрузка…':'Загрузить настройки заново'}</button>
  {view&&!draft?<button type="button" disabled={busy} onClick={()=>{setDraft({...defaultMachineMarksConfig,hosts:{}});setError(null);}} className="ml-2 rounded border px-3 py-1.5">Подготовить сброс повреждённой настройки</button>:null}
  {draft?<><label className="flex items-center gap-2"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>Показывать значки машин</label>
   <div className="space-y-3">{hosts.map(host=>{const role=draft.hosts[host.id]??{kind:'other' as const};return <div key={host.id} className="flex flex-wrap items-center gap-2 rounded border p-2"><span className="min-w-0 flex-1 break-words">{host.name}</span><select aria-label={`Тип машины ${host.name}`} disabled={busy} value={role.kind} onChange={e=>change(host.id,{...role,kind:e.target.value as MachineRole['kind']})} className="max-w-full rounded border bg-background p-1">{Object.entries(machineKinds).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select><select aria-label={`Значок машины ${host.name}`} disabled={busy} value={role.icon??''} onChange={e=>change(host.id,e.target.value?{...role,icon:e.target.value as MachineRole['icon']}:{kind:role.kind})} className="max-w-full rounded border bg-background p-1"><option value="">По типу машины</option>{Object.entries(machineIcons).map(([id,icon])=><option key={id} value={id}>{icon}</option>)}</select></div>;})}</div>
   <p className="text-xs text-muted-foreground">Новые машины получают признак «Другой сервер». Сохранённые назначения сохраняются при переименовании или временном отсутствии машины.</p>
   <button type="button" disabled={busy} onClick={()=>void save()} className="rounded border px-3 py-1.5">Сохранить значки</button></>:null}
 </div>;
}
export function registerMachineMarks(app:PluginAppBuilder){
 app.contentScripts.register({id:'thread-machine-marks',mount:()=>mountMachineMarks(document,machineMarkStore)});
 app.slots.experimental_appOverlay({id:'machine-marks-data',component:MachineMarksController});
 app.slots.experimental_threadHeaderAction({id:'machine-mark',title:'Машина треда',component:MachineHeaderMark});
 app.slots.settingsSection({id:'machine-marks',title:'Значки машин',description:'Где выполняется каждый тред',component:MachineMarksSettings});
}
