import {useCallback,useEffect,useRef,useState} from 'react';
import {useRealtime,useRpc} from '@get-bb/plugin-sdk/app';
import {integrationContract,integrationSchema} from './integrations-contract';
const defaults={memory:false,autopilot:false,tasknotes:false};
export function useIntegrations(){
 const rpc=useRpc<typeof integrationContract>();const [value,setValue]=useState(defaults);const [ready,setReady]=useState(false);const revision=useRef(0);
 const load=useCallback(()=>{const current=++revision.current;void rpc.call('integrationStatus',null).then(next=>{const parsed=integrationSchema.safeParse(next);if(current===revision.current&&parsed.success){setValue(parsed.data);setReady(true);}},()=>{if(current===revision.current){setValue(defaults);setReady(false);}});},[rpc]);
 useEffect(()=>{load();return()=>{revision.current++;};},[load]);
 useRealtime('project-integrations:changed',load);
 return {...value,ready};
}
export function IntegrationSettings(){
 const rpc=useRpc<typeof integrationContract>();const status=useIntegrations();const [value,setValue]=useState(defaults);const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{if(!busy&&status.ready)setValue({memory:status.memory,autopilot:status.autopilot,tasknotes:status.tasknotes});},[status.memory,status.autopilot,status.tasknotes,status.ready]);
 return <section className="rounded border border-border p-3 space-y-2"><h3 className="font-semibold">Дополнительные подключения</h3><p className="text-sm text-muted-foreground">Основные задачи и репозитории работают самостоятельно. Включи нужные дополнительные разделы.</p>{(['memory','autopilot','tasknotes'] as const).map(name=><label key={name} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value[name]} disabled={busy||!status.ready} onChange={async e=>{const next={...value,[name]:e.target.checked};setBusy(true);setError('');try{setValue(await rpc.call('saveIntegrations',next));}catch{setError('Не удалось сохранить подключения. Повтори попытку.');}finally{setBusy(false);}}}/>{{memory:'Память проекта — требуется oxi-memory',autopilot:'Автопилот — требуется oxi-autopilot',tasknotes:'Задачи Obsidian — настрой папку TaskNotes'}[name]}</label>)}{error&&<p role="alert">{error}</p>}</section>;
}
