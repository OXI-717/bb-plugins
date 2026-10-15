import {useEffect,useRef,useState} from 'react';
import {useRpc} from '@get-bb/plugin-sdk/app';
import type {z} from 'zod';
import {memoryContract,type memoryStateSchema} from './memory-contract';
import {Button} from './components/ui/button';
type State=z.infer<typeof memoryStateSchema>;
const statuses:Record<State['status'],string>={
 unselected:'Проект памяти не выбран.',
 'not-applicable':'Память для этого проекта не применяется.',
 ambiguous:'Общий workspace: предметный проект не определён. Поиск и запись памяти отключены до однозначной привязки.',
 linked:'Связь с проектом волта сохранена.',
 'missing-catalog':'Связанный код отсутствует в каталоге волта. Связь сохранена, поиск и запись недоступны.',
 'invalid-mapping':'Настройки привязок повреждены. Существующие связи не изменены.',
 'catalog-unavailable':'Каталог волта недоступен. Связь сохранена, поиск и запись недоступны.',
};
const failures:Record<string,string>={conflict:'Настройки или каталог изменились. Обнови список и повтори выбор.', 'catalog-unavailable':'Каталог волта недоступен.', 'invalid-code':'Выбранного кода нет в каталоге волта.', 'invalid-mapping':'Настройки привязок повреждены.', 'project-missing':'Проект BB недоступен.', 'save-failed':'Не удалось сохранить связь.'};
export function MemorySettings({projectId}:{projectId:string}) {return <MemoryEditor key={projectId} projectId={projectId}/>;}
function MemoryEditor({projectId}:{projectId:string}) {
 const rpc=useRpc<typeof memoryContract>();
 const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const [state,setState]=useState<State|null>(null),[selection,setSelection]=useState('unselected'),[busy,setBusy]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const apply=(next:State)=>{setState(next);setSelection(next.binding.mode==='project'?`code:${next.binding.code}`:next.binding.mode);};
 useEffect(()=>{let live=true;setState(null);setError('');setNotice('');setBusy(true);rpc.call('memoryInspect',{projectId}).then(next=>{if(live)apply(next);},()=>{if(live)setError('Плагин памяти недоступен. Проверь, что oxi-memory включён и обновлён.');}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};},[rpc,projectId]);
 async function refresh(){setBusy(true);setError('');setNotice('');try{const next=await rpc.call('memoryInspect',{projectId});if(!mounted.current)return;apply(next);if(next.catalogAvailable)setNotice('Каталог перечитан из волта. Существующие привязки сохранены.');else setError('Не удалось перечитать каталог волта. Привязки не изменены.');}catch{if(mounted.current){setState(null);setError('Плагин памяти недоступен.');}}finally{if(mounted.current)setBusy(false);}}
 async function save(){if(!state)return;setBusy(true);setError('');setNotice('');try{
  const binding=selection.startsWith('code:')?{mode:'project' as const,code:selection.slice(5)}:{mode:selection as 'unselected'|'not-applicable'|'ambiguous',code:null};
  const result=await rpc.call('memorySave',{projectId,binding,mappingRevision:state.mappingRevision,catalogRevision:state.catalogRevision});
  if(!mounted.current)return;
  if(!result.ok){setError(failures[result.reason]??'Не удалось сохранить связь.');return;}
  const next=await rpc.call('memoryInspect',{projectId});if(!mounted.current)return;apply(next);setNotice('Связь сохранена. Права доступа не изменены.');
 }catch{if(mounted.current)setError('Не удалось проверить результат сохранения. Обнови список.');}finally{if(mounted.current)setBusy(false);}}
 return <section className="rounded border border-border p-3 space-y-3" aria-label="Память проекта">
  <h3 className="font-semibold">Память проекта</h3>
  <p className="text-sm text-muted-foreground">Проекты из каталога Obsidian. Выбор связывает этот проект BB со стабильным кодом волта.</p>
  {busy&&<p role="status">Загрузка…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {state&&<><p>{statuses[state.status]}</p>{!state.catalogAvailable&&state.status!=='catalog-unavailable'&&<p role="alert">Каталог волта недоступен.</p>}
   {state.binding.code&&<p>Код привязки: <strong>{state.binding.code}</strong></p>}
   {state.access==='timeout'&&<p role="alert">Сервис памяти не ответил вовремя (таймаут). Права проверить не удалось; это не пустой результат поиска.</p>}
   {state.access==='unavailable'&&<p role="alert">Сервис памяти недоступен. Права проверить не удалось.</p>}
   {(state.access==='available'||state.access==='denied')&&<p>Поиск: {state.read?'доступен':'нет прав'} · Добавление: {state.add?'только в pending':'нет прав'} · Автопоиск: {state.automatic?'включён':'выключен'}</p>}
   <label className="block text-sm">Проект в волте<select className="block mt-1 max-w-full rounded border border-border bg-background p-2" aria-label="Проект памяти в волте" value={selection} disabled={busy||state.status==='invalid-mapping'} onChange={e=>{setSelection(e.target.value);setNotice('');}}>
    <option value="unselected">Не выбрана привязка</option><option value="not-applicable">Память не применяется</option><option value="ambiguous">Общий workspace — контекст неоднозначен</option>
    {state.binding.code&&!state.catalog.some(p=>p.code===state.binding.code)&&<option value={`code:${state.binding.code}`} disabled>{state.binding.code} — отсутствует в каталоге</option>}
    {state.catalog.map(p=><option key={p.code} value={`code:${p.code}`}>{p.label===p.code?p.code:`${p.label} (${p.code})`}</option>)}
   </select></label>
   <Button size="sm" disabled={busy||state.status==='invalid-mapping'||(selection.startsWith('code:')&&!state.catalog.some(p=>`code:${p.code}`===selection))} onClick={()=>void save()}>Сохранить привязку</Button>
  </>}
  <Button size="sm" variant="outline" disabled={busy} onClick={()=>void refresh()}>Синхронизировать список из волта</Button>
  <p className="text-sm text-muted-foreground">Синхронизация не создаёт проекты BB и не выдаёт права. Пустой результат поиска при доступной памяти — нормальный ответ.</p>
 </section>;
}
