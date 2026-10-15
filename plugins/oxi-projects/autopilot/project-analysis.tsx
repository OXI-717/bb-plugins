import {useEffect,useState} from "react";
import {useRpc,useBbNavigate,experimental_NewThreadComposer as NewThreadComposer} from "@get-bb/plugin-sdk/app";
import type {bindingContract,WorkDraft} from "../work-bindings";
import {Button} from "./components/ui/button";
export function ProjectAnalysis({sourceId,project,bbProjectId}:{sourceId:string;project:string;bbProjectId?:string}){
 const rpc=useRpc<typeof bindingContract>(),navigate=useBbNavigate();
 const [projects,setProjects]=useState<Array<{id:string;name:string}>>([]),[selected,setSelected]=useState(bbProjectId??"");
 const [draft,setDraft]=useState<WorkDraft|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 useEffect(()=>{let live=true;if(!bbProjectId)void rpc.call("resolveAutopilotProject",{sourceId,project}).then(v=>{if(live){const choices=Array.isArray(v?.projects)?v.projects:[];setProjects(choices);if(choices.length===1)setSelected(choices[0].id);else if(!choices.length)setError("Свяжи этот автопилот с проектом BB в настройках проекта");}},()=>{if(live)setError("Не удалось найти связанный проект BB");});return()=>{live=false;};},[sourceId,project,bbProjectId]);
 return <div className="space-y-3">
  <p className="text-xs text-muted-foreground">Разбор только проекта {project}: проблемы без повторов и последние результаты. Модель выбирается перед отправкой.</p>
  {!selected&&<label>Проект BB для этого разбора <select aria-label="Проект BB для разбора проблем" value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Выбрать связь…</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
  {!draft&&<Button disabled={busy||!selected} onClick={async()=>{setBusy(true);setError("");try{setDraft(await rpc.call("prepareWork",{reference:{projectId:selected,source:"autopilot-project",kind:"epic",locator:JSON.stringify([sourceId,project,Intl.DateTimeFormat().resolvedOptions().timeZone])}}));}catch(e){setError(String(e));}finally{setBusy(false);}}}>{busy?"Собираем проблемы проекта…":"Разобрать проблемы с агентом"}</Button>}
  {error&&<p role="alert">{error}</p>}
  {draft&&<div className="rounded-lg border border-border p-3 space-y-3"><p className="font-semibold">Разбор {project} · черновик, тред ещё не создан</p><div className="flex gap-2"><Button variant="outline" onClick={async()=>{try{await navigator.clipboard.writeText(draft.prompt);}catch{setError("Не удалось скопировать контекст");}}}>Скопировать контекст проекта</Button><Button variant="outline" onClick={()=>setDraft(null)}>Закрыть черновик</Button></div><NewThreadComposer key={draft.id} defaultProjectId={selected} initialPrompt={draft.prompt} draftKey={`autopilot-project/${draft.id}`} layout="contained" className="h-[28rem] min-w-0 w-full" onSubmit={async request=>{try{const link=await rpc.call("launchWork",{reference:draft.reference,draftId:draft.id,request});setDraft(null);navigate.toThread(link.threadId);}catch(e){setError(String(e));throw e;}}}/></div>}
 </div>;
}
