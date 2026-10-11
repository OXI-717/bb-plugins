import { useCallback, useEffect, useState } from 'react';
import { definePluginApp, useRpc, type StandardSchemaV1InferOutput } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.js';

type Status = StandardSchemaV1InferOutput<(typeof rpcContract)['status']['output']>;
export function GuardPage() {
  const rpc=useRpc<typeof rpcContract>();
  const [status,setStatus]=useState<Status|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const refresh=useCallback(async()=>{
    try {setStatus(await rpc.call('status'));setError(null);} catch(e){setError(String(e));}
  },[rpc]);
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer);},[refresh]);
  async function setMode(mode:'observe'|'enforce') {
    setBusy(true);
    try {setStatus(await rpc.call('setMode',{mode}));setError(null);} catch(e){setError(String(e));}
    finally {setBusy(false);}
  }
  return <main className="mx-auto max-w-3xl space-y-5 overflow-y-auto p-5">
    <h1 className="text-xl font-semibold">VPN Guard</h1>
    <p>Protects Codex, Claude, Cursor and Devin work on machines whose VPN state is unavailable. Kimi and Z.ai remain available.</p>
    {error && <p role="alert" className="text-red-500">{error}</p>}
    <div className="flex gap-2">
      <button type="button" disabled={busy} onClick={()=>void setMode('observe')} className="rounded border px-3 py-2">Observe</button>
      <button type="button" disabled={busy} onClick={()=>void setMode('enforce')} className="rounded border px-3 py-2">Enforce</button>
      <button type="button" disabled={busy} onClick={()=>void refresh()} className="rounded border px-3 py-2">Refresh</button>
    </div>
    <p>Mode: <strong>{status?.mode??'loading'}</strong></p>
    <section><h2 className="font-semibold">Machines</h2><ul>{status?.hosts.map(h=><li key={h.id}>{h.name}: {h.vpn}</li>)}</ul></section>
    <section><h2 className="font-semibold">Actions</h2>
      <p>Providers disabled by Guard: {status?.ownedDisabledProviders.join(', ')||'none'}</p>
      <p>Stopped turns: {status?.stoppedThreadIds.length??0}</p>
    </section>
    <details><summary>Limits</summary><ul>{status?.limitations.map(l=><li key={l}>{l}</li>)}</ul></details>
  </main>;
}
export default definePluginApp(app=>{
  app.slots.navPanel({id:'vpn-guard',title:'VPN Guard',icon:'Shield',path:'vpn-guard',component:GuardPage});
});
