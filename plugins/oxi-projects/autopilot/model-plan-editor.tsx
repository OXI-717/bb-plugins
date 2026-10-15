import {useState} from "react";
import {z} from "zod";
import {modelPlanSchema} from "./contract";
import type {Row} from "./view";

export type ModelPlan=z.infer<typeof modelPlanSchema>;
const efforts=["none","minimal","low","medium","high","xhigh","max"];
function initial(row:Row):ModelPlan {
  const records=row.project.executionPlan??[];
  const dev:ModelPlan["dev"]={},review:ModelPlan["review"]={};
  const engines=row.project.engines?.length?row.project.engines:records.map(x=>x.engine);
  const fixEngines=row.project.fixEngines?.length?row.project.fixEngines:engines;
  for(const x of records){
    if(engines.includes(x.engine))dev[x.engine]={model:x.taskModel,effort:x.taskEffort};
    if(fixEngines.includes(x.engine))review[x.engine]={model:x.reviewModel,effort:x.reviewEffort};
  }
  return {engines,fix_engines:fixEngines,
    allow_premium_auto:row.project.allowPremiumAuto??false,dev,review};
}
export function ModelPlanEditor({row,onSave}:{row:Row;onSave?:(plan:ModelPlan)=>Promise<void>}) {
  const catalog=row.project.engineCatalog??[];
  const availableEngines=catalog.map(x=>x.engine);
  const [editing,setEditing]=useState(false);
  const [plan,setPlan]=useState<ModelPlan>(()=>initial(row));
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  if(!onSave)return null;
  if(!catalog.length||!plan.engines.every(x=>availableEngines.includes(x))||!plan.fix_engines.every(x=>availableEngines.includes(x)))return <p className="text-xs text-muted-foreground">Каталог движков не получен или устарел. Обновите статус проекта перед редактированием.</p>;
  const update=(next:ModelPlan)=>setPlan(next);
  function chain(stage:"dev"|"review") {
    const key=stage==="dev"?"engines":"fix_engines";
    const values=plan[key];
    const available=availableEngines.filter(e=>!values.includes(e));
    const move=(index:number,offset:number)=>{
      const target=index+offset;if(target<0||target>=values.length)return;
      const next=[...values];[next[index],next[target]]=[next[target],next[index]];
      update({...plan,[key]:next});
    };
    return <div className="space-y-2">
      <p className="text-sm font-medium">{stage==="dev"?"Решение задач":"Исправление замечаний"}</p>
      {values.map((engine,index)=>{
        const entry=catalog.find(x=>x.engine===engine);
        const setting=plan[stage][engine]??(entry?stage==="dev"?{model:entry.taskModel,effort:entry.taskEffort}:{model:entry.reviewModel,effort:entry.reviewEffort}:{model:"",effort:"medium"});
        return <div key={engine} className="grid gap-2 rounded-md border border-border p-2 md:grid-cols-[9rem_1fr_8rem_auto] items-center">
          <span className="text-sm font-medium">{index+1}. {engine}</span>
          <input aria-label={`${stage} model ${engine}`} className="w-full rounded border border-border bg-background px-2 py-1 text-sm" value={setting.model} onChange={e=>update({...plan,[stage]:{...plan[stage],[engine]:{...setting,model:e.target.value}}})}/>
          <select aria-label={`${stage} effort ${engine}`} className="rounded border border-border bg-background px-2 py-1 text-sm" value={setting.effort} onChange={e=>update({...plan,[stage]:{...plan[stage],[engine]:{...setting,effort:e.target.value}}})}>{efforts.map(x=><option key={x} value={x}>{x}</option>)}</select>
          <div className="flex gap-1">
            <button type="button" aria-label={`Выше ${stage} ${engine}`} onClick={()=>move(index,-1)} disabled={index===0}>↑</button>
            <button type="button" aria-label={`Ниже ${stage} ${engine}`} onClick={()=>move(index,1)} disabled={index===values.length-1}>↓</button>
            <button type="button" aria-label={`Убрать ${stage} ${engine}`} onClick={()=>{const settings={...plan[stage]};delete settings[engine];update({...plan,[key]:values.filter(x=>x!==engine),[stage]:settings});}} disabled={values.length===1}>×</button>
          </div>
        </div>;
      })}
      {available.length>0&&<select aria-label={`Добавить движок ${stage}`} className="rounded border border-border bg-background px-2 py-1 text-sm" value="" onChange={e=>{
        const engine=e.target.value;if(!engine)return;
        const entry=catalog.find(x=>x.engine===engine);
        const setting=entry?stage==="dev"?{model:entry.taskModel,effort:entry.taskEffort}:{model:entry.reviewModel,effort:entry.reviewEffort}:null;
        if(!setting)return;
        update({...plan,[key]:[...values,engine],[stage]:{...plan[stage],[engine]:plan[stage][engine]??setting}});
      }}><option value="">+ Добавить движок</option>{available.map(e=><option key={e} value={e}>{e}</option>)}</select>}
    </div>;
  }
  return <div className="space-y-3 border-t border-border pt-3">
    {!editing?<button type="button" className="rounded border border-border px-3 py-1 text-sm" onClick={()=>{setPlan(initial(row));setEditing(true);setError(null);}}>Изменить последовательность и модели</button>:<>
      <p className="text-xs text-muted-foreground">Первый доступный движок берёт работу; остальные — запасные. Модели и уровень рассуждения задаются отдельно для задач и исправлений.</p>
      {chain("dev")}{chain("review")}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={plan.allow_premium_auto} onChange={e=>update({...plan,allow_premium_auto:e.target.checked})}/>Разрешить выбранные премиум-модели в автоматическом проходе проекта</label>
      <div className="flex gap-2">
        <button type="button" className="rounded bg-foreground px-3 py-1 text-sm text-background disabled:opacity-50" disabled={saving} onClick={async()=>{setSaving(true);setError(null);try{modelPlanSchema.parse(plan);await onSave(plan);setNotice(row.project.local?"Сохранено; статус обновляется":"Сохранено в репозиторий конфигурации; ждём ближайший fleet-sync на хосте");setEditing(false);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setSaving(false);}}}>{saving?"Сохраняем…":row.project.local?"Сохранить в автопилот":"Сохранить в репозиторий конфигурации"}</button>
        <button type="button" className="rounded border border-border px-3 py-1 text-sm" onClick={()=>setEditing(false)}>Отмена</button>
      </div>
    </>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice&&<p className="text-sm text-muted-foreground">{notice}</p>}
  </div>;
}
