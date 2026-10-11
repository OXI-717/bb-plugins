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
  async function change(action:()=>Promise<Status>) {
    setBusy(true);
    try {setStatus(await action());setError(null);} catch(e){setError(String(e));}
    finally {setBusy(false);}
  }
  async function selectHost(id:string,selected:boolean) {
    const ids=new Set(status?.hostIds??[]);
    if(selected) ids.add(id); else ids.delete(id);
    await change(()=>rpc.call('setHosts',{hostIds:[...ids]}));
  }
  return <main className="mx-auto max-w-3xl space-y-5 overflow-y-auto p-5">
    <h1 className="text-xl font-semibold">VPN Guard</h1>
    <p>Selected machines are checked using their own VPN status. Codex, Claude, Cursor and Devin are protected; Kimi and Z.ai stay available. Observation is the default.</p>
    {error && <p role="alert" className="text-red-500">{error}</p>}
    <section className="space-y-2">
      <h2 className="font-semibold">Machines in scope</h2>
      <p>Select every machine that may run protected work before enabling enforcement. An unavailable selected machine is treated as unknown. Other machines do not affect this policy.</p>
      <ul>{status?.hosts.map(h=><li key={h.id}>
        <label><input type="checkbox" checked={h.selected} disabled={busy||!h.available} onChange={e=>void selectHost(h.id,e.target.checked)}/> {h.name}</label>
        {' — '}{h.selected ? h.vpn : 'outside scope'}{!h.available?' (unavailable)':''}
      </li>)}</ul>
    </section>
    <section className="space-y-2">
      <h2 className="font-semibold">Admission and running turns</h2>
      <p>Enforcement holds normal sends and stops protected running turns on selected machines with disconnected or unknown VPN. Stopped turns are never replayed automatically. Send-now bypasses the dispatch hook.</p>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={()=>void change(()=>rpc.call('setMode',{mode:'observe'}))} className="rounded border px-3 py-2">Observe</button>
        <button type="button" disabled={busy||!status?.hostIds.length} onClick={()=>void change(()=>rpc.call('setMode',{mode:'enforce'}))} className="rounded border px-3 py-2">Enforce selected machines</button>
        <button type="button" disabled={busy} onClick={()=>void refresh()} className="rounded border px-3 py-2">Refresh</button>
      </div>
      <p>Mode: <strong>{status?.mode??'loading'}</strong>. Stopped turns recorded: {status?.stoppedThreadIds.length??0}.</p>
    </section>
    <section className="space-y-2">
      <h2 className="font-semibold">Optional global native plugin suspension</h2>
      <p>When a selected machine is blocked, this disables the Codex and Claude native plugins across ALL BB machines, including healthy machines. It may stop their background usage and OAuth registrations; termination of existing bridge processes and in-flight requests is unproven. Cursor and Devin share ACP with other providers and are not suspended this way.</p>
      <label><input type="checkbox" checked={status?.suspendNativePluginsGlobally??false} disabled={busy} onChange={e=>void change(()=>rpc.call('setGlobalSuspension',{enabled:e.target.checked,acknowledgeGlobalImpact:e.target.checked}))}/> Suspend native plugins globally during a block</label>
      <p>Guard-owned disabled plugins: {status?.ownedDisabledPlugins.join(', ')||'none'}. Recovery does not restore them automatically: BB cannot distinguish a redundant manual disable made while Guard owned one. Review current plugin settings before explicit restore.</p>
      <p>Changes interrupted by a crash, requiring manual review: {status?.ambiguousPluginChanges.join(', ')||'none'}.</p>
      <button type="button" disabled={busy||!status?.ownedDisabledPlugins.length} onClick={()=>void change(()=>rpc.call('restoreOwned',null))} className="rounded border px-3 py-2">Restore Guard-owned plugins after review</button>
    </section>
    <details><summary>Limits</summary><ul>{status?.limitations.map(l=><li key={l}>{l}</li>)}</ul></details>
  </main>;
}
export default definePluginApp(app=>{
  app.slots.navPanel({id:'vpn-guard',title:'VPN Guard',icon:'Shield',path:'vpn-guard',component:GuardPage});
});
