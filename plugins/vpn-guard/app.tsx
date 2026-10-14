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
  const [statusFresh,setStatusFresh]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [controllerPath,setControllerPath]=useState('');
  const [reviewedSchedules,setReviewedSchedules]=useState(false);
  useEffect(()=>setReviewedSchedules(false),[status?.automations.status?.restoreRevision]);
  const requests=useRef(createStatusRequests());
  const refresh=useCallback(async()=>{
    const requestRevision=requests.current.start();
    try {const next=await rpc.call('status');if(requests.current.isCurrent(requestRevision)){setStatus(next);setStatusFresh(true);setError(null);}} catch(e){if(requests.current.isCurrent(requestRevision)){setStatusFresh(false);setError(String(e));}}
  },[rpc]);
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer);},[refresh]);
  async function change(action:()=>Promise<Status>) {
    requests.current.invalidate();
    setBusy(true);
    try {setStatus(await action());setStatusFresh(true);setError(null);} catch(e){setError(String(e));await refresh();setError(String(e));}
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
  const ready=!!status&&!busy&&statusFresh;
  const selectedHosts=status?.hosts.filter(host=>host.selected)??[];
  const canRestore=ready&&!status.manualBlock&&selectedHosts.every(host=>host.available&&host.vpn==='connected');
  const needsNativeRecovery=!!status&&(status.ownedDisabledPlugins.length>0||status.ambiguousPluginChanges.length>0);
  return <main className="vpn-guard" lang={language}>
    <header className="vg-header"><h1>{t.title}</h1><div className="vg-languages" role="group" aria-label={t.language}>
      {(['ru','en'] as const).map(l=><button key={l} type="button" className="vg-language" aria-pressed={language===l} onClick={()=>chooseLanguage(l)}>{l.toUpperCase()}</button>)}
    </div></header>
    <p className="vg-help">{t.description}</p>
    {status&&!statusFresh&&<p role="status" className="vg-error">{t.cachedStatus}</p>}
    {error&&<div role="alert" className="vg-error"><p>{readableError(error,language)}</p><details><summary>{t.errorDetails}</summary><pre className="vg-error-detail">{error}</pre></details></div>}
    <section><div className="vg-section-heading"><h2>{t.control}</h2>
      <p role="status" className={status?.manualBlock?'vg-blocked':'vg-help'}>{status ? !statusFresh?t.unknown:status.manualBlock?t.blocked:t.notBlocked :error?t.statusUnavailable:t.loading}</p></div>
      <div className="vg-actions"><button type="button" className={status?.manualBlock?'':'vg-danger'} disabled={!ready||!status.hostIds.length} onClick={()=>void change(()=>rpc.call('setManualBlock',{blocked:!status?.manualBlock}))}>{status?.manualBlock?t.unblock:t.block}</button>
        <button type="button" disabled={busy} onClick={()=>void refresh()}>{t.refresh}</button></div>
      <label className="vg-check"><input type="checkbox" checked={status?.mode==='enforce'} disabled={!ready||(!status.hostIds.length&&status.mode!=='enforce')} onChange={event=>void change(()=>rpc.call('setMode',{mode:event.target.checked?'enforce':'observe'}))}/><span>{t.enforce}</span></label>
      {status&&(!status.serverHostId||!status.hostIds.includes(status.serverHostId))&&<p className="vg-error" role="status">{t.serverScopeWarning}</p>}
      <p className="vg-help">{!statusFresh?t.stateUnavailable:status?.mode==='enforce'?t.enforceHelp:t.observeHelp}</p>
      <details className="vg-inline-details"><summary>{t.controlHelp}</summary><p className="vg-help">{t.blockHelp}</p><p className="vg-help">{t.poolHelp}</p></details>
    </section>
    <section><h2>{t.overview}</h2>
      <dl className="vg-overview">
        <div><dt>{t.pool}</dt><dd>{!statusFresh?t.unknown:status?.pool.linked===true?`${t.linked} · ${t.verifiedPolicy}`:status?.pool.linked===false?t.notLinked:t.unavailable}</dd></div>
        <div><dt>{t.automations}</dt><dd>{!statusFresh?t.unknown:!status?.coordinateAutomations?t.notLinked:status.automations.error||status.automations.status?.activeRuns.length?t.partial:!status.automations.status?t.unknown:status.automations.status.blocked?t.paused:t.available}</dd></div>
        <div><dt>{t.nativeState}</dt><dd>{!statusFresh?t.unknown:needsNativeRecovery?t.pendingRecovery:t.noNativeRecovery}</dd></div>
        <div><dt>{t.stopped}</dt><dd>{statusFresh?`${status?.stoppedThreadIds.length} ${t.threadUnit}`:t.unknown}</dd></div>
      </dl>
      <ul className="vg-machines vg-current-machines">{selectedHosts.map(host=><li key={host.id}><span>{host.name}</span><span className={statusFresh&&host.vpn==='connected'?'vg-help':'vg-error'}>{t[statusFresh?host.vpn??'unknown':'unknown']}</span></li>)}</ul>
      {statusFresh&&!selectedHosts.length&&<p className="vg-help">{t.noMachines}</p>}
    </section>
    <details className="vg-section" open={status?.automations.status?.recoveryPending||!!status?.automations.error}>
      <summary>{t.automations}</summary>
      {!status?.coordinateAutomations&&<p className="vg-help">{t.controllerOptional}</p>}
      {status?.coordinateAutomations&&<>
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
      </>}
      <details><summary>{t.controllerSetup}</summary>
        <label className="vg-field"><span>{t.controllerPath}</span><input value={controllerPath||status?.automationControllerPath||''} onChange={e=>setControllerPath(e.target.value)} placeholder="/absolute/path/to/oxi-auto"/></label>
        <div className="vg-actions"><button disabled={!ready} onClick={()=>void change(()=>rpc.call('setAutomationCoordination',{enabled:true,executable:controllerPath||status?.automationControllerPath||null}))}>{t.connectController}</button>
        <button disabled={!ready||!status.coordinateAutomations} onClick={()=>void change(()=>rpc.call('setAutomationCoordination',{enabled:false,executable:status?.automationControllerPath??null}))}>{t.disconnectController}</button></div>
      </details>
    </details>
    <details className="vg-section"><summary>{t.machineSettings}</summary><p className="vg-help">{t.machinesHelp}</p>
      <ul className="vg-machines">{status?.hosts.map(h=><li key={h.id}><label className="vg-check"><input type="checkbox" checked={h.selected} disabled={!ready||(!h.available&&!h.selected)} onChange={e=>void selectHost(h.id,e.target.checked)}/><span>{h.name}</span></label>
        <span className="vg-help">{!statusFresh?t.unknown:h.selected?t[h.vpn??'unknown']:t.outside}{statusFresh&&h.evidence?` · ${h.evidence.assurance==='verified_ipv4'?t.verifiedIpv4:t.unverifiedVpn}`:''}{statusFresh&&!h.available?` · ${t.unavailable}`:''}</span></li>)}</ul>
    </details>
    <details className="vg-section" open={needsNativeRecovery}><summary>{t.native}</summary><p className="vg-help">{t.nativeScope}</p>
      <label className="vg-check"><input type="checkbox" checked={status?.suspendNativePluginsGlobally??false} disabled={!ready} onChange={e=>void change(()=>rpc.call('setGlobalSuspension',{enabled:e.target.checked,acknowledgeGlobalImpact:e.target.checked}))}/><span>{t.suspend}</span></label>
      <p className="vg-help">{t.owned}: {status?.ownedDisabledPlugins.join(', ')||t.none}</p>
      <p className="vg-help">{t.policyOnly}</p>
      {needsNativeRecovery&&<><p className="vg-help">{t.restoreHelp}</p>
      <div className="vg-actions"><button type="button" disabled={!canRestore||!status?.ownedDisabledPlugins.length} onClick={()=>void change(()=>rpc.call('restoreOwned',null))}>{t.restorePlugins}</button></div>
      {!canRestore&&<p className="vg-help">{t.restoreBlocked}</p>}</>}
      {!!status?.ambiguousPluginChanges.length&&<><p className="vg-help">{t.ambiguous}</p>{status.ambiguousPluginChanges.map(id=><div key={id} className="vg-journal"><code>{id}</code><button type="button" disabled={!ready} onClick={()=>void change(()=>rpc.call('acknowledgeAmbiguous',{pluginId:id,acknowledgeReviewed:true}))}>{t.ack}</button></div>)}</>}
      <details className="vg-inline-details"><summary>{t.nativeDetails}</summary><p className="vg-help">{t.nativeHelp}</p></details>
    </details>
    <details className="vg-section"><summary>{t.limits}</summary><p className="vg-help">{t.limitText}</p></details>
  </main>;
}
export default definePluginApp(app=>{
  app.slots.navPanel({id:'vpn-guard',title:'VPN Guard',icon:'Shield',path:'vpn-guard',component:GuardPage});
});
