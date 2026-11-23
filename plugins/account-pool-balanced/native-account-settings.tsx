import type {NativeProbeInput,NativeProbeResult} from './src/native-probe-wire';
import {useEffect, useState} from 'react';
import {Button} from './ui/components/ui/button';
import {ResourceOverflowMenu} from './ui/components/ui/resource/row';
import {AccountListRow, AccountRowStatus, SettingsBadge} from './account-list-row';
import {AccountProjectsForm} from './account-projects-form';
import type {NativeAccounts, NativeAccountUpdate} from './src/native-accounts.js';
import {NATIVE_MAX_CONCURRENT_SESSIONS} from './src/contracts.js';
type Account=NativeAccounts['accounts'][number];
type Projects=Array<{id:string;name:string}>;
type Patch=Omit<NativeAccountUpdate,'accountId'|'expectedRevision'>;
export function NativeAccountRow({
  account,
  open,
  expanded,
  managed = true,
}: {
  account: Account;
  open: () => void;
  expanded?: boolean;
  managed?: boolean;
}) {
  const name = account.label ?? "Google account";
  const enabled = managed && account.executors.some((executor) => executor.enabled);
  const status = !managed
    ? {label: "Managed mode is disabled", dot: 'bg-muted-foreground'}
    : account.uncertain > 0
      ? {label: `Stop unconfirmed: ${account.uncertain}`, dot: 'bg-warning'}
      : enabled
        ? {label: "Enabled", dot: 'bg-success'}
        : {label: "Disabled", dot: 'bg-muted-foreground'};
  const projects = account.projects;
  const maxSessions = account.maxConcurrentSessions ?? 1;

  return (
    <AccountListRow
      name={name}
      enabled={enabled}
      badges={
        <>
          {projects?.rules.length ? (
            <SettingsBadge>
              {projects.onlySelected ? "Selected projects only" : "Project roles"} · {projects.rules.length}
            </SettingsBadge>
          ) : null}
          {account.role === 'reserve' ? <SettingsBadge>Reserve</SettingsBadge> : null}
        </>
      }
      status={
        <>
          <AccountRowStatus {...status} />
          {account.queued > 0 ? <span>Queued: {account.queued}</span> : null}
        </>
      }
      metrics={
        <div className="text-left text-xs tabular-nums" title="Active sessions / limit">
          <div className="font-semibold text-foreground">Sessions <span>{account.active} / {maxSessions}</span></div>
          <div className="text-muted-foreground">No quota data yet</div>
        </div>
      }
      actions={
        <ResourceOverflowMenu
          label={`Actions: ${name}`}
          items={[{label: "Configure", onSelect: open}]}
        />
      }
      onOpen={open}
      expanded={expanded}
      controls={expanded ? `pool-native-${account.accountId}` : undefined}
    />
  );
}
export function NativeAccountSettings({account,revision,save,loadProjects,probe}:{probe?:(input:NativeProbeInput)=>Promise<NativeProbeResult>;account:Account;revision:string;save:(input:NativeAccountUpdate)=>Promise<void>;loadProjects:()=>Promise<Projects>}) {
  const priority=account.priority??(account.executors.some(e=>e.preferred)?0:10);
  const busy=account.active+account.queued+account.uncertain>0;
  const [draft,setDraft]=useState(String(priority));
  const [label,setLabel]=useState(account.label??'');
  useEffect(()=>setLabel(account.label??''),[account.label]);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const [probeMessage,setProbeMessage]=useState('');
  const [probeProjects,setProbeProjects]=useState<Projects>([]);
  const [probeProject,setProbeProject]=useState('');
  const [probeModel,setProbeModel]=useState('');
  useEffect(()=>{let live=true;void loadProjects().then(value=>{if(live)setProbeProjects(value);}).catch(()=>{});return()=>{live=false;};},[]);
  const probeText:Record<NativeProbeResult['status'],string>={
    'not-started':"No check has run. Verify executor availability and project settings.",
    'runtime-unavailable':"The installed executor does not support targeted checks.",
    'catalog-received':"Catalog received. A model response has not been verified yet.",
    'model-responded':"The model replied. Account and executor were verified; the diagnostic process stopped.",
    'verification-required':"Google requires verification. Complete it in the browser with the owner. No retry was sent.",
    'model-unavailable':"This model is absent from the account's fresh catalog. No model request was sent.",
    'provider-error':"The official client did not confirm a model response. The cause is unknown.",
    'stop-unconfirmed':"The diagnostic process stop is unconfirmed. Its busy session prevents another run.",
  };
  useEffect(()=>setDraft(String(priority)),[priority]);
  const change=async(patch:Patch)=>{
    setPending(true);setError('');
    try{await save({accountId:account.accountId,expectedRevision:revision,...patch});}
    catch(reason){
      const text=reason instanceof Error?reason.message:'';
      setError(text.includes('native-executor-busy')?"Projects, launch locations and session limits can change when the account becomes idle.":text.includes('native-selection-changed')?"Settings changed in another session. Refresh and try again.":"Could not save settings. Refresh and try again.");
      throw reason;
    }finally{setPending(false);}
  };
  const apply=(patch:Patch)=>{void change(patch).catch(()=>{});};
  return <div className="space-y-4">
    <section className="pool-settings-section" aria-label="Account selection">
      <h3 className="pool-settings-heading">Google account</h3>
      <p className="pool-settings-help">{account.label??"No name yet"}</p>
      <p className="pool-settings-help">This name labels the account in the pool. The official Google client verifies the email and subscription.</p>
      <fieldset disabled={pending} className="pool-settings-fields">
        <label className="pool-settings-field pool-settings-inline">Account name<input className="pool-settings-control" aria-label="Account name" maxLength={120} value={label} onChange={e=>setLabel(e.target.value)} onBlur={()=>{if(label.trim()&&label.trim()!==account.label)apply({label:label.trim()});}}/></label>
        <label className="pool-settings-field pool-settings-inline">Default role<select className="pool-settings-control" aria-label="Default role" value={account.role??'primary'} onChange={e=>apply({role:e.target.value as 'primary'|'reserve'})}><option value="primary">Primary</option><option value="reserve">Reserve</option></select></label>
        <label className="pool-settings-field pool-settings-inline">Priority<input className="pool-settings-control" type="number" min="-10000" max="10000" step="1" aria-label="Account priority" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}} onBlur={()=>{
          const next=Number(draft);if(draft.trim()===''||!Number.isInteger(next)||Math.abs(next)>10000){setError("Priority must be an integer from −10000 to 10000.");return;}
          if(next!==priority)apply({priority:next});
        }}/></label>
      </fieldset>
      <p className="pool-settings-help">Lower numbers go first among accounts with the same role and project assignment. Changes apply to new sessions; existing sessions retain their account.</p>
      <label className="pool-settings-field pool-settings-inline">Concurrent sessions
        <select className="pool-settings-control" disabled={pending||busy} value={account.maxConcurrentSessions??1} onChange={event=>apply({maxConcurrentSessions:Number(event.target.value)})}>
          {Array.from({length:NATIVE_MAX_CONCURRENT_SESSIONS},(_,index)=><option key={index+1} value={index+1}>{index+1}</option>)}
        </select>
      </label>
      <p className="pool-settings-help">Shared limit for this account on all machines, including autopilot. It can change when the queue is empty and sessions have stopped.</p>
    </section>
    <section className="pool-settings-section" aria-label="Google and model access">
      <h3 className="pool-settings-heading">Google and model access</h3>
      <p className="pool-settings-help">{account.executors.some(e=>e.enabled)?"Pool settings allow launches. This page has not verified a Google response yet.":"Regular sessions are disabled. The button below runs a separate targeted check."}</p>
      <p className="pool-settings-help">Select the model in BB's new Antigravity session form. A saved catalog does not confirm subscription access to a model; that is checked when requested.</p>
      <p className="pool-settings-help">For Verification Required, complete Google verification in the browser with the owner. Successful sign-in and payment alone do not confirm model access.</p>
      <p className="pool-settings-help">Measured limits and payment status are unavailable. This page does not start another sign-in.</p>
    </section>
    {account.mixedProjects&&<p role="status">Launch locations have different projects. Saving projects applies one setting to the whole account.</p>}
    <fieldset disabled={pending}><AccountProjectsForm account={{role:account.role??'primary',projects:account.projects}} showQuotaHelp={false} loadProjects={loadProjects} save={projects=>change({projects})}/></fieldset>
    <section className="pool-settings-section" aria-label="Launch locations">
      <h3 className="pool-settings-heading">Launch locations and autopilot</h3>
      <p className="pool-settings-help">Google sign-in is stored separately on each machine. Disabled launch locations cannot start new sessions.</p>
      <div className="pool-settings-fields"><label className="pool-settings-field">Project to check<select className="pool-settings-control" aria-label="Project to check" value={probeProject} onChange={event=>setProbeProject(event.target.value)}><option value="">Choose a project</option>{probeProjects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label className="pool-settings-field">Model to check<input className="pool-settings-control" aria-label="Model to check" maxLength={160} placeholder="Catalog only" value={probeModel} onChange={event=>setProbeModel(event.target.value)}/></label></div>
      <p className="pool-settings-help">The check sends one tool-free request to the selected model. An empty model field retrieves only the catalog. There is no need to enable the account or change the preferred account.</p>
      <fieldset disabled={pending} className="pool-settings-fields">{account.executors.map(e=><div key={e.id} className="space-y-2 py-2">
        <p className="pool-settings-help break-all">Executor: {e.id}</p><p className="pool-settings-help break-all">Machine: {e.hostId??"not specified"} · {e.enabled?"allowed by settings":"disabled"}</p>
        <Button size="sm" variant="outline" disabled={pending||!probe||!probeProject||!e.hostId} onClick={()=>{setPending(true);setProbeMessage('');void probe!({accountId:account.accountId,executorId:e.id,hostId:e.hostId!,projectId:probeProject,...(probeModel.trim()?{model:probeModel.trim()}:{} )}).then(result=>setProbeMessage(`${new Date(result.observedAt).toISOString().replace('T',' ').slice(0,19)+' UTC'} · ${result.model??"Catalog"} · ${probeText[result.status]}${result.catalog.length?` Models in catalog: ${result.catalog.length}.`:''}`)).catch(()=>setProbeMessage("No check has run or its result is unconfirmed. Verify project permissions and account availability.")).finally(()=>setPending(false));}}>Check account</Button>
        <label className="pool-settings-toggle"><input type="checkbox" aria-label={`Enable ${e.id}`} checked={e.enabled} onChange={event=>apply({executor:{id:e.id,enabled:event.target.checked}})}/>Enabled</label>
        <label className="pool-settings-toggle"><input type="checkbox" aria-label={`Allow autopilot for ${e.id}`} checked={e.autopilotAllowed} onChange={event=>apply({executor:{id:e.id,autopilotAllowed:event.target.checked}})}/>Allow autopilot</label>
      </div>)}</fieldset>
    </section>
    {probeMessage&&<p role="status" className="pool-settings-help">{probeMessage}</p>}
    {pending&&<p role="status">Saving…</p>}
    {error&&<p role="alert" className="pool-settings-error">{error}</p>}
  </div>;
}
