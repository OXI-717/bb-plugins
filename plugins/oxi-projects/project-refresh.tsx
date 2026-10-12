import { date as displayDate } from "./autopilot/view";
import {useEffect,useRef,useState} from 'react';
import {useRpc} from '@get-bb/plugin-sdk/app';
import {taskboardRpcContract} from './contract';
import {Button} from './components/ui/button';
export function ProjectRefresh({projectId,onRefreshed}:{projectId:string;onRefreshed?:()=>void}){
 const rpc=useRpc<typeof taskboardRpcContract>();
 const [busy,setBusy]=useState(false),[at,setAt]=useState<string|null>(null),[error,setError]=useState('');
 const pending=useRef(false);
 useEffect(()=>{let live=true;setAt(null);setError('');rpc.call('status',{projectId}).then(r=>{if(live){setAt(r.sources.find(s=>s.lastSyncedAt)?.lastSyncedAt??null);setError(r.sources.map(s=>s.message).filter(Boolean).join('; '));}},e=>{if(live)setError(String(e));});return()=>{live=false;};},[rpc,projectId]);
 return <div className="flex flex-wrap items-center gap-2 text-xs font-normal"><span className="text-muted-foreground">{at?`Данные: ${displayDate(at)}`:'Сохранённых данных пока нет'}</span><Button size="sm" variant="outline" disabled={busy} aria-label={`Обновить проект ${projectId}`} onClick={async()=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');try{const result=await rpc.call('refresh',{projectId});setAt(result.sources.find(s=>s.lastSyncedAt)?.lastSyncedAt??null);setError(result.sources.map(s=>s.message).filter(Boolean).join('; '));onRefreshed?.();}catch(e){setError(String(e));}finally{pending.current=false;setBusy(false);}}}>{busy?'Обновляется…':'Обновить'}</Button>{error&&<span role="alert" className="text-destructive">{error}</span>}</div>;
}
