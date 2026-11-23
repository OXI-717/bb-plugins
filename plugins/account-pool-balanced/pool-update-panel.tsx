import {useCallback,useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {useRpc} from '@get-bb/plugin-sdk/app';
import type {z} from 'zod';
import type {updateStatusSchema} from './src/pool-update.js';
import type {accountPoolRpcContract} from './src/rpc.js';
import {version} from './package.json';
import {Button} from './ui/components/ui/button';

const labels = {
  starting:"Starting update…", running:"Preparation and update are running. Work will resume automatically.",
  succeeded:"Operation complete. Pooler is ready.",
  failed:"Update did not finish. See the Pool update terminal on the server machine.",
  unknown:"Checking launch status. Do not start another update; inspect the Pool update terminal.",
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
      if(current===generation.current)setStatusError("Could not check update status. Starting is unavailable for now.");
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
      setError("Could not confirm launch. Checking operation status…");setLoading(true);
    }).finally(()=>{startPending.current=false;setStarting(false);void refresh();});
  }}/>;
}

export function PoolUpdateView({operation,busy,error,statusUnavailable=false,onStart}:{
  operation:z.infer<typeof updateStatusSchema>;busy:boolean;error:string|null;statusUnavailable?:boolean;onStart:()=>void;
}) {
  return <section aria-label="Pooler update" className="space-y-2 rounded-lg border border-border p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Pooler update</h2>
        <p className="text-xs text-muted-foreground">Pooler version {version}</p>
      </div>
      <Button size="sm" disabled={busy} onClick={onStart}>{busy&&!statusUnavailable?"Checking update…":"Update Pooler"}</Button>
    </div>
    <p className="text-xs text-muted-foreground">Pauses sessions and autopilot requests on all machines, verifies a backup, installs the new version and resumes work. Current responses may be interrupted.</p>
    {operation?<p role="status" className="text-xs text-muted-foreground">
      {operation.alreadyCurrent ? "The latest version is already installed." : labels[operation.state]}
    </p>:null}
    {error?<p role="alert" className="text-xs text-destructive-text">{error}</p>:null}
  </section>;
}

function PoolDisclosure({title, children}: {title: string; children: ReactNode}) {
  return (
    <details className="rounded-lg border border-border px-4">
      <summary className="cursor-pointer py-2.5 text-sm font-medium">
        {title}
      </summary>
      {children}
    </details>
  );
}

export function PoolSelectedAccounts({accounts}: {
  accounts: ReadonlyArray<{ provider: string; account: string }>;
}) {
  return (
    <PoolDisclosure title="Selected accounts">
      <section aria-label="Selected accounts" className="space-y-3 border-t border-border py-3">
        <p className="text-xs text-subtle-foreground">Pooler shows the latest selection. Projects and threads can use different accounts.</p>
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {accounts.map(({provider, account}) => (
            <div key={provider} className="min-w-0 rounded-md border border-border px-3 py-2">
              <dt className="text-xs text-subtle-foreground">{provider}</dt>
              <dd className="m-0 break-words text-sm font-medium">{account}</dd>
            </div>
          ))}
        </dl>
      </section>
    </PoolDisclosure>
  );
}

export function PoolTechnicalDetails({children}: {children: ReactNode}) {
  return (
    <PoolDisclosure title="Technical details">
      <p className="break-words pb-3 text-xs text-muted-foreground">{children}</p>
    </PoolDisclosure>
  );
}
