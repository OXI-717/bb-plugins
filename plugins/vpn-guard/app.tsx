import { useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc, type StandardSchemaV1InferOutput } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.js';
import { copy, readableError, type Language } from './copy.js';
import { createStatusRequests } from './status-requests.js';
import './app.css';

type Status = StandardSchemaV1InferOutput<(typeof rpcContract)['status']['output']>;
function initialLanguage():Language {
  try {return localStorage.getItem('vpn-guard-language')==='en'?'en':'ru';} catch {return 'ru';}
}
export function GuardPage() {
  const rpc=useRpc<typeof rpcContract>();
  const [language,setLanguage]=useState<Language>(initialLanguage);
  const t=copy[language];
  const [status,setStatus]=useState<Status|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [controllerPath,setControllerPath]=useState('');
  const [reviewedSchedules,setReviewedSchedules]=useState(false);
  useEffect(()=>setReviewedSchedules(false),[status?.automations.status?.restoreRevision]);
  const requests=useRef(createStatusRequests());
  const refresh=useCallback(async()=>{
    const requestRevision=requests.current.start();
    try {const next=await rpc.call('status');if(requests.current.isCurrent(requestRevision)){setStatus(next);setError(null);}} catch(e){if(requests.current.isCurrent(requestRevision))setError(String(e));}
  },[rpc]);
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer);},[refresh]);
  async function change(action:()=>Promise<Status>) {
    requests.current.invalidate();
    setBusy(true);
    try {setStatus(await action());setError(null);} catch(e){setError(String(e));await refresh();setError(String(e));}
    finally {requests.current.invalidate();setBusy(false);}
  }
  async function selectHost(id:string,selected:boolean) {
    const ids=new Set(status?.hostIds??[]);
    if(selected) ids.add(id); else ids.delete(id);
    await change(()=>rpc.call('setHosts',{hostIds:[...ids]}));
  }
  function chooseLanguage(next:Language) {
    setLanguage(next);try {localStorage.setItem('vpn-guard-language',next);} catch { /* session language still works */ }
  }
  const ready=!!status&&!busy;
  return <main className="vpn-guard" lang={language}>
    <header className="vg-header"><h1>{t.title}</h1><div className="vg-languages" role="group" aria-label={t.language}>
      {(['ru','en'] as const).map(l=><button key={l} type="button" className="vg-language" aria-pressed={language===l} onClick={()=>chooseLanguage(l)}>{l.toUpperCase()}</button>)}
    </div></header>
    <p className="vg-help">{t.description}</p>
    {error&&<div role="alert" className="vg-error"><p>{readableError(error,language)}</p><details><summary>{t.errorDetails}</summary><pre className="vg-error-detail">{error}</pre></details></div>}
    <section><h2>{t.control}</h2>
      <p role="status" className={status?.manualBlock?'vg-blocked':'vg-help'}>{status ? status.manualBlock?t.blocked:t.notBlocked :t.loading}</p>
      <div className="vg-actions"><button type="button" className="vg-danger" disabled={!ready||!status.hostIds.length} onClick={()=>void change(()=>rpc.call('setManualBlock',{blocked:!status?.manualBlock}))}>{status?.manualBlock?t.unblock:t.block}</button>
        <button type="button" disabled={busy} onClick={()=>void refresh()}>{t.refresh}</button></div>
      <p className="vg-help">{t.blockHelp}</p>
      <p className="vg-help">{t.poolHelp}</p>
      {status&&(!status.serverHostId||!status.hostIds.includes(status.serverHostId))&&<p className="vg-error" role="status">{t.serverScopeWarning}</p>}
      <div className="vg-actions" role="group" aria-label={t.mode}>
        <button type="button" aria-pressed={status?.mode==='observe'} disabled={!ready} onClick={()=>void change(()=>rpc.call('setMode',{mode:'observe'}))}>{t.observe}</button>
        <button type="button" aria-pressed={status?.mode==='enforce'} disabled={!ready||!status.hostIds.length} onClick={()=>void change(()=>rpc.call('setMode',{mode:'enforce'}))}>{t.enforce}</button>
      </div><p className="vg-help">{t.modeHelp}</p>
      <p className="vg-help">{t.stopped}: {status?.stoppedThreadIds.length??0}</p>
    </section>
    <section><h2>{t.overview}</h2>
      <dl className="vg-overview">
        <div><dt>{t.pool}</dt><dd>{status?.pool.linked===true?`${t.linked} · ${status.pool.requireVerified?t.verifiedIpv4:t.ordinaryTransport}`:status?.pool.linked===false?t.notLinked:t.unavailable}</dd></div>
        <div><dt>{t.automations}</dt><dd>{!status?.coordinateAutomations?t.notLinked:status.automations.error||status.automations.status?.activeRuns.length?t.partial:!status.automations.status?t.unknown:status.automations.status.blocked?t.paused:t.available}</dd></div>
        <div><dt>{t.recovery}</dt><dd>{status?.automations.status?.recoveryPending?t.pendingRecovery:t.none}</dd></div>
        <div><dt>{t.pausedSchedules}</dt><dd>{status?.automations.status?.pausedCount??0}</dd></div>
      </dl>
      {status?.automations.status?.holds.map(hold=><p className="vg-help" key={hold.owner}>{hold.owner.startsWith('vpn-guard:')?t.guardHold:hold.owner==='emergency'?t.emergencyHold:t.manualHold}</p>)}
      {!!status?.automations.status?.legacyBlocked&&<p className="vg-help">{t.legacyPause}</p>}
      {!!status?.automations.error&&<div className="vg-error" role="status">{t.partial}<details><summary>{t.errorDetails}</summary><pre className="vg-error-detail">{status.automations.error}</pre></details></div>}
      {!!status?.automations.status?.errors.length&&<details><summary>{t.errorDetails}</summary><pre className="vg-error-detail">{status.automations.status.errors.join("\n")}</pre></details>}
      {!!status?.automations.status?.activeRuns.length&&<details><summary>{t.activeRun}: {status.automations.status.activeRuns.length}</summary><pre className="vg-error-detail">{status.automations.status.activeRuns.join("\n")}</pre></details>}
      <div className="vg-actions">
        <button disabled={!ready||!status.coordinateAutomations} onClick={()=>void change(()=>rpc.call('automationAction',{action:'pause',reviewed:false}))}>{t.pauseAutomations}</button>
        <button disabled={!ready||!status.coordinateAutomations||status.manualBlock||status.automations.held} onClick={()=>void change(()=>rpc.call('automationAction',{action:'resume',reviewed:reviewedSchedules,restoreRevision:status?.automations.status?.restoreRevision??null}))}>{t.resumeAutomations}</button>
      </div>
      <p className="vg-help">{t.restoreAutomationsHelp}</p>
      {!!status?.automations.status?.pendingRestore.length&&<details><summary>{t.restoreInventory}</summary>{status.automations.status.pendingRestore.map(r=><p className="vg-help" key={r.projectId+':'+r.id}>{r.name}</p>)}</details>}
      <label className="vg-check"><input type="checkbox" checked={reviewedSchedules} onChange={e=>setReviewedSchedules(e.target.checked)}/><span>{t.reviewedSchedules}</span></label>
      <details><summary>{t.controllerSetup}</summary>
        <label className="vg-field"><span>{t.controllerPath}</span><input value={controllerPath||status?.automationControllerPath||''} onChange={e=>setControllerPath(e.target.value)} placeholder="/absolute/path/to/oxi-auto"/></label>
        <div className="vg-actions"><button disabled={!ready} onClick={()=>void change(()=>rpc.call('setAutomationCoordination',{enabled:true,executable:controllerPath||status?.automationControllerPath||null}))}>{t.connectController}</button>
        <button disabled={!ready||!status.coordinateAutomations} onClick={()=>void change(()=>rpc.call('setAutomationCoordination',{enabled:false,executable:status?.automationControllerPath??null}))}>{t.disconnectController}</button></div>
      </details>
    </section>
    <section><h2>{t.machines}</h2><p className="vg-help">{t.machinesHelp}</p>
      <label className="vg-check"><input type="checkbox" checked={status?.requireVerifiedVpn??false} disabled={!ready} onChange={e=>void change(()=>rpc.call('setVerifiedVpn',{enabled:e.target.checked}))}/><span>{t.verifiedVpn}</span></label><p className="vg-help">{t.verifiedHelp}</p>
      <ul className="vg-machines">{status?.hosts.map(h=><li key={h.id}><label className="vg-check"><input type="checkbox" checked={h.selected} disabled={busy||(!h.available&&!h.selected)} onChange={e=>void selectHost(h.id,e.target.checked)}/><span>{h.name}</span></label>
        <span className="vg-help">{h.selected?t[h.vpn??'unknown']:t.outside}{h.evidence?` · ${h.evidence.assurance==='verified_ipv4'?t.verifiedIpv4:h.evidence.assurance==='legacy'?t.legacyVpn:t.unverifiedVpn}`:''}{!h.available?` · ${t.unavailable}`:''}</span></li>)}</ul>
    </section>
    <section><h2>{t.native}</h2><p className="vg-help">{t.nativeHelp}</p>
      <label className="vg-check"><input type="checkbox" checked={status?.suspendNativePluginsGlobally??false} disabled={!ready} onChange={e=>void change(()=>rpc.call('setGlobalSuspension',{enabled:e.target.checked,acknowledgeGlobalImpact:e.target.checked}))}/><span>{t.suspend}</span></label>
      <p className="vg-help">{t.owned}: {status?.ownedDisabledPlugins.join(', ')||t.none}</p>
      <p className="vg-help">{t.restoreHelp}</p>
      <div className="vg-actions"><button type="button" disabled={!ready||status.manualBlock||!status.ownedDisabledPlugins.length} onClick={()=>void change(()=>rpc.call('restoreOwned',null))}>{t.restore}</button></div>
      {!!status?.ambiguousPluginChanges.length&&<><p className="vg-help">{t.ambiguous}</p>{status.ambiguousPluginChanges.map(id=><div key={id} className="vg-journal"><code>{id}</code><button type="button" disabled={busy} onClick={()=>void change(()=>rpc.call('acknowledgeAmbiguous',{pluginId:id,acknowledgeReviewed:true}))}>{t.ack}</button></div>)}</>}
    </section>
    <details><summary>{t.limits}</summary><p className="vg-help">{t.limitText}</p></details>
  </main>;
}
export default definePluginApp(app=>{
  app.slots.navPanel({id:'vpn-guard',title:'VPN Guard',icon:'Shield',path:'vpn-guard',component:GuardPage});
});
