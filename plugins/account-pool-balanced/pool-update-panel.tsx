import {useCallback,useEffect,useState} from 'react';
import {useRpc} from '@get-bb/plugin-sdk/app';
import type {z} from 'zod';
import type {accountPoolRpcContract} from './src/rpc.js';
import type {updateStatusSchema} from './src/pool-update.js';
import {Button} from './ui/components/ui/button';

const labels = {
  starting:'Запускаю обновление…', running:'Подготовка и обновление выполняются. Работа возобновится автоматически.',
  succeeded:'Операция завершена. Pooler готов к работе.',
  failed:'Обновление не завершено. Подробности — в терминале «Pool update» на машине сервера.',
  unknown:'Проверяется состояние запуска. Не запускайте обновление повторно; проверьте терминал «Pool update».',
};
export function PoolUpdatePanel() {
  const rpc=useRpc<typeof accountPoolRpcContract>();
  const [operation,setOperation]=useState<z.infer<typeof updateStatusSchema>>(null);
  const [loading,setLoading]=useState(true);
  const [starting,setStarting]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const refresh=useCallback(async()=>{
    try {setOperation(await rpc.call('update.status',null));setLoading(false);}
    catch {/* The pool RPC is briefly unavailable while its bundle reloads. */}
  },[rpc]);
  useEffect(()=>{void refresh();const timer=window.setInterval(()=>void refresh(),3000);return()=>window.clearInterval(timer);},[refresh]);
  const busy=starting||loading||(operation!==null&&!['succeeded','failed'].includes(operation.state));
  return <PoolUpdateView operation={operation} busy={Boolean(busy)} error={error} onStart={()=>{
    setStarting(true);setError(null);
    void rpc.call('update.start',null).then(setOperation).catch(()=>{
      setError('Не удалось подтвердить запуск. Проверяю состояние операции…');setLoading(true);
    }).finally(()=>{setStarting(false);void refresh();});
  }}/>;
}

export function PoolUpdateView({operation,busy,error,onStart}:{
  operation:z.infer<typeof updateStatusSchema>;busy:boolean;error:string|null;onStart:()=>void;
}) {
  return <section aria-label="Обновление Pooler" className="space-y-2 rounded-lg border border-border p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-sm font-medium">Обновление Pooler</h2>
      <Button size="sm" disabled={busy} onClick={onStart}>{busy?'Проверяю обновление…':'Обновить Pooler'}</Button>
    </div>
    <p className="text-xs text-muted-foreground">Приостановит сессии и запросы автопилота на всех машинах, сохранит резервную копию, установит новую версию и возобновит работу. Текущие ответы могут быть прерваны.</p>
    {operation?<p role="status" className="text-xs text-muted-foreground">{labels[operation.state]}</p>:null}
    {error?<p role="alert" className="text-xs text-destructive-text">{error}</p>:null}
  </section>;
}
