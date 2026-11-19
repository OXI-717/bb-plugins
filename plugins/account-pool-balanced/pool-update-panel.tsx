import {useCallback,useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {useRpc} from '@get-bb/plugin-sdk/app';
import type {z} from 'zod';
import type {updateStatusSchema} from './src/pool-update.js';
import type {accountPoolRpcContract} from './src/rpc.js';
import {version} from './package.json';
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
  const [statusError,setStatusError]=useState<string|null>(null);
  const generation=useRef(0);
  const request=useRef<number|null>(null);
  const startPending=useRef(false);
  const refresh=useCallback(async()=>{
    const current=generation.current;
    if(startPending.current||request.current===current)return;
    request.current=current;
    try {
      const next=await rpc.call('update.status',null);
      if(current!==generation.current)return;
      setOperation(next);
      setStatusError(null);
    } catch {
      if(current===generation.current)setStatusError('Не удалось проверить состояние обновления. Запуск пока недоступен.');
    } finally {
      if(request.current===current)request.current=null;
      if(current===generation.current)setLoading(false);
    }
  },[rpc]);
  useEffect(()=>{void refresh();const timer=window.setInterval(()=>void refresh(),3000);return()=>{window.clearInterval(timer);generation.current++;};},[refresh]);
  const busy=starting||loading||statusError!==null||(operation!==null&&!['succeeded','failed'].includes(operation.state));
  return <PoolUpdateView operation={operation} busy={busy} error={statusError??error} statusUnavailable={statusError!==null} onStart={()=>{
    if(busy||startPending.current)return;
    startPending.current=true;
    generation.current++;
    setStarting(true);setError(null);
    void rpc.call('update.start',null).then(setOperation).catch(()=>{
      setError('Не удалось подтвердить запуск. Проверяю состояние операции…');setLoading(true);
    }).finally(()=>{startPending.current=false;setStarting(false);void refresh();});
  }}/>;
}

export function PoolUpdateView({operation,busy,error,statusUnavailable=false,onStart}:{
  operation:z.infer<typeof updateStatusSchema>;busy:boolean;error:string|null;statusUnavailable?:boolean;onStart:()=>void;
}) {
  return <section aria-label="Обновление Pooler" className="space-y-2 rounded-lg border border-border p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Обновление Pooler</h2>
        <p className="text-xs text-muted-foreground">Версия Pooler {version}</p>
      </div>
      <Button size="sm" disabled={busy} onClick={onStart}>{busy&&!statusUnavailable?'Проверяю обновление…':'Обновить Pooler'}</Button>
    </div>
    <p className="text-xs text-muted-foreground">Приостановит сессии и запросы автопилота на всех машинах, сохранит резервную копию, установит новую версию и возобновит работу. Текущие ответы могут быть прерваны.</p>
    {operation?<p role="status" className="text-xs text-muted-foreground">
      {operation.alreadyCurrent ? 'Уже установлена последняя версия.' : labels[operation.state]}
    </p>:null}
    {error?<p role="alert" className="text-xs text-destructive-text">{error}</p>:null}
  </section>;
}

export function PoolTechnicalDetails({children}: {children: ReactNode}) {
  return (
    <details className="rounded-lg border border-border px-4">
      <summary className="cursor-pointer py-2.5 text-sm font-medium">
        Технические детали
      </summary>
      <p className="break-words pb-3 text-xs text-muted-foreground">{children}</p>
    </details>
  );
}
