import {useEffect,useState} from 'react';
import {useRpc} from '@get-bb/plugin-sdk/app';
import {catalogContract,type Finding} from './catalog-contract';
import {date as displayDate} from './autopilot/view';
import {Button} from './components/ui/button';

export function CatalogDrift({projectId}:{projectId:string|null}) {
 const rpc=useRpc<typeof catalogContract>();
 const [findings,setFindings]=useState<Finding[]|null>(null),[checkedAt,setCheckedAt]=useState<number|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{let live=true;setBusy(true);setError('');rpc.call('catalogCheck',{projectId}).then(r=>{if(live){setFindings(r.findings);setCheckedAt(r.checkedAt);}},e=>{if(live)setError(String(e));}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};},[rpc,projectId,revision]);
 const errors=findings?.filter(f=>f.level==='error').length??0;
 return <section className="rounded border border-border p-3 space-y-2">
  <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-medium">Сверка списков{findings&&findings.length>0&&<span className="ml-2 rounded bg-destructive/15 px-1.5 text-xs text-destructive">{findings.length}</span>}</h3><p className="text-xs text-muted-foreground">Автопилот, подключения панели и проект BB должны описывать одни и те же репозитории.{checkedAt?` Проверено ${displayDate(new Date(checkedAt).toISOString())}.`:''}</p></div><Button variant="outline" disabled={busy} onClick={()=>setRevision(v=>v+1)}>{busy?'Проверяем…':'Проверить'}</Button></div>
  {error&&<p role="alert">{error}</p>}
  {findings&&(findings.length===0?<p className="text-sm text-muted-foreground">Расхождений нет.</p>:<ul className="space-y-1 text-sm">{findings.map((f,i)=><li key={i} className={f.level==='error'?'text-destructive':'text-muted-foreground'}><span className="font-mono text-xs">{f.scope}</span> — {f.message}</li>)}</ul>)}
  {findings&&errors>0&&<p className="text-xs text-muted-foreground">Ошибок {errors}. Правь секцию в autopilot.conf или подключение выше, затем нажми «Проверить».</p>}
 </section>;
}
