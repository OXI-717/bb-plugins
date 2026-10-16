import {randomUUID} from 'node:crypto';
import {automationStatusSchema,type AutomationStatus} from './automation-contract.js';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { configurationSchema, hostContract, rpcContract, stopObservationSchema, stopReasonSchema } from './contract.js';
import { abortableDelay } from './delay.js';
import {eventJournal,type GuardEvent} from './event-journal.js';
import { protectedProvider, PROTECTED_PROVIDERS, type VpnState } from './state.js';

const CONFIG = 'configuration-v2';
const JOURNAL = 'owned-disabled-native-plugins-v2';
const PENDING = 'pending-native-plugin-changes-v2';
const STOPPED = 'stopped-thread-ids-v1';
const STOP_HISTORY = 'stop-observations-v1';
const EVENTS = 'protection-events-v1';
class AutomationPolicyChanged extends Error {constructor(){super('Automation policy changed; retry required');}}
const NATIVE_PLUGINS = ['provider-codex','provider-claude-code'] as const;
const LIMITATIONS = [
  'Send-now bypasses message.dispatch.',
  'Native plugin suspension is global across hosts and requires separate opt-in.',
  'Guard-owned native plugins resume automatically after VPN recovery; BB cannot distinguish a redundant manual disable while they are already paused.',
  'A crash during plugin disable leaves an ambiguous journal entry for manual review, never automatic restoration.',
  'An ambiguous native plugin change holds its provider until explicitly acknowledged after review.',
  'In-flight connections, running scripts, and existing bridge processes are not a proven network block.',
  'All provider IDs are protected except exact Kimi and Z.ai routes; generic ACP engines are protected.',
  'VPN Guard is BB admission control, not a packet firewall.',
];
type Configuration = z.infer<typeof configurationSchema>;
const initialConfiguration: Configuration = {mode:'observe',manualBlock:false,hostIds:[],suspendNativePluginsGlobally:false,coordinateAutomations:false,automationControllerPath:null};

export default async function plugin(bb: BbPluginApi) {
  const storedInstance=await bb.storage.kv.get<string>('protection-instance-v1');
  const instanceId=storedInstance&&/^[a-zA-Z0-9_-]{1,80}$/.test(storedInstance)?storedInstance:randomUUID();
  if(storedInstance!==instanceId)await bb.storage.kv.set('protection-instance-v1',instanceId);
  let automationStatus:AutomationStatus|null=null;
  let automationError:string|null=null;
  const rawHold=await bb.storage.kv.get('automation-hold-binding-v1');
  const storedHold=z.object({hostId:z.string(),executable:z.string()}).nullable().safeParse(rawHold);
  const bindingCorrupt=rawHold!==null&&rawHold!==undefined&&!storedHold.success;
  if(bindingCorrupt)automationError='Automation ownership journal is malformed; manual review required';
  let automationBinding=storedHold.success?storedHold.data:null;
  let automationDesired:boolean|null=null;
  let automationPolicyVersion=0;
  let automationOperationVersion=0;
  let automationTail:Promise<void>=Promise.resolve();
  let automationTask:Promise<void>|null=null;
  let coordinationRequested=false;
  let automationBusy=false;
  let lastAutomationAttempt:number|null=null;
  let lastAutomationSuccess:number|null=null;
  let automationRetryAt:number|null=null;
  let automationFailed=false;
  let lastCoordinatedVersion:number|null=null;
  let disposed=false;
  const lifetime=new AbortController();
  bb.onDispose(()=>{disposed=true;lifetime.abort();coordinationRequested=false;});
  const journal=eventJournal(await bb.storage.kv.get(EVENTS),events=>bb.storage.kv.set(EVENTS,events),()=>{if(!disposed)bb.log.warn('VPN Guard event journal write failed');});
  bb.onDispose(()=>journal.close());
  automationFailed=journal.snapshot().slice().reverse().find(e=>e.kind==='automation_failed'||e.kind==='automation_recovered')?.kind==='automation_failed';
  const observedVpn=new Map<string,string>();
  let nativeProblem:string|null=null;
  function event(value:Omit<GuardEvent,'at'>) {
    if(disposed)return;
    try {void journal.append(value);}catch {bb.log.warn('VPN Guard event rejected');}
  }
  function assertAutomationCurrent() {if(disposed||automationOperationVersion!==automationPolicyVersion)throw new AutomationPolicyChanged();}
  function automationSerial<T>(operation:()=>Promise<T>):Promise<T> {
    const run=automationTail.then(async()=>{
      if(disposed)throw new AutomationPolicyChanged();
      automationBusy=true;automationOperationVersion=automationPolicyVersion;lastAutomationAttempt=Date.now();
      try {
        const value=await operation();assertAutomationCurrent();
        lastAutomationSuccess=Date.now();automationRetryAt=null;
        if(automationFailed){automationFailed=false;event({kind:'automation_recovered'});}
        return value;
      } catch(error) {
        if(!disposed&&automationOperationVersion===automationPolicyVersion&&!(error instanceof AutomationPolicyChanged)) {
          automationError=String(error);automationDesired=null;automationRetryAt=Date.now()+5000;
          if(!automationFailed){automationFailed=true;event({kind:'automation_failed',reason:'controller_unavailable'});}
        }
        throw error;
      } finally {automationBusy=false;}
    });
    automationTail=run.then(()=>undefined,()=>undefined);return run;
  }
  function requestCoordination(force=false) {
    if(disposed)return;
    if(!config.coordinateAutomations&&!automationBinding&&!bindingCorrupt){automationDesired=false;return;}
    if(!force&&automationRetryAt!==null&&Date.now()<automationRetryAt)return;
    coordinationRequested=true;
    if(force||lastCoordinatedVersion!==automationPolicyVersion)automationDesired=null;
    if(automationTask)return;
    automationTask=automationSerial(async()=>{
      coordinationRequested=false;
      const snapshot=await status();assertAutomationCurrent();await coordinate(snapshot);assertAutomationCurrent();
    }).catch(error=>{
      if(disposed)return;
      if(error instanceof AutomationPolicyChanged||automationOperationVersion!==automationPolicyVersion)coordinationRequested=true;
      else {coordinationRequested=false;bb.log.warn('VPN Guard automation coordination failed; retry scheduled');}
    }).finally(()=>{automationTask=null;if(coordinationRequested&&!disposed)requestCoordination(true);});
  }

  const host = bb.hosts.experimental_client({contract:hostContract});
  const loaded=configurationSchema.safeParse(await bb.storage.kv.get<unknown>(CONFIG));
  let config:Configuration=loaded.success ? loaded.data : initialConfiguration;
  if ((config.mode==='enforce' || config.manualBlock) && config.hostIds.length===0) config={...config,mode:'observe',manualBlock:false};
  if(loaded.success)await bb.storage.kv.set(CONFIG,config);
  const storedOwned=z.array(z.string()).safeParse(await bb.storage.kv.get<unknown>(JOURNAL));
  const storedPending=z.array(z.string()).safeParse(await bb.storage.kv.get<unknown>(PENDING));
  const storedStopped=z.array(z.string()).safeParse(await bb.storage.kv.get<unknown>(STOPPED));
  let owned=new Set((storedOwned.success?storedOwned.data:[]).filter(id=>NATIVE_PLUGINS.includes(id as typeof NATIVE_PLUGINS[number])));
  let pending=new Set((storedPending.success?storedPending.data:[]).filter(id=>NATIVE_PLUGINS.includes(id as typeof NATIVE_PLUGINS[number])));
  if([...pending].some(id=>owned.has(id))) {
    pending=new Set([...pending].filter(id=>!owned.has(id)));
    await bb.storage.kv.set(PENDING,[...pending]);
  }
  let stopped=new Set((storedStopped.success?storedStopped.data:[]).slice(-100));
  const storedHistory=z.array(stopObservationSchema).max(100).safeParse(await bb.storage.kv.get(STOP_HISTORY));
  let stopHistory=storedHistory.success?storedHistory.data:[];
  let tail:Promise<void>=Promise.resolve();
  let previousStates=new Map<string,VpnState>();
  let policyVersion=0;
  let recheckDirty=false;

  function serial<T>(operation:()=>Promise<T>):Promise<T> {
    const run=tail.then(operation,operation);
    tail=run.then(()=>undefined,()=>undefined);
    return run;
  }
  async function vpn(hostId:string):Promise<VpnState> {
    try {const result=await host.call('readState',null,{hostId,timeoutMs:1500});return result.evidence?.assurance!=='verified_ipv4'?'unknown':result.state;}
    catch {return 'unknown';}
  }
  const poolPolicySchema=z.object({vpnGuardEnabled:z.boolean(),vpnPolicyVersion:z.literal(2),vpnOnlyProviders:z.array(z.string())});
  async function poolPolicy() {
    return poolPolicySchema.parse(await bb.sdk.plugins.callRpc({pluginId:'account-pool-balanced',method:'config.get',input:null,outputSchema:poolPolicySchema,signal:AbortSignal.timeout(1000)}));
  }
  async function status() {
    let serverHostId:string|null=null;
    try {serverHostId=(await bb.sdk.system.config()).primaryHostId;} catch {}
    let listed:Awaited<ReturnType<typeof bb.sdk.hosts.list>>;
    try {listed=await bb.sdk.hosts.list();}
    catch {listed=[];}
    const selected=new Set(config.hostIds);
    const hosts=await Promise.all(listed.map(async h=>{
      let result:Awaited<ReturnType<typeof host.call<'readState'>>>|undefined;
      if(selected.has(h.id))try{result=await host.call('readState',null,{hostId:h.id,timeoutMs:1500});}catch{}
      return {id:h.id,name:h.name,selected:selected.has(h.id),available:true,evidence:result?.evidence??null,
        vpn:selected.has(h.id)?(!result?'unknown':result.evidence?.assurance!=='verified_ipv4'?'unknown':result.state):null};
    }));
    for (const id of selected) if(!listed.some(h=>h.id===id)) hosts.push({id,name:id,selected:true,available:false,vpn:'unknown',evidence:null});
    let pool:{linked:boolean|null,vpnPolicyVersion:2|null,error:string|null}={linked:null,vpnPolicyVersion:null,error:null};
    try {const raw=await poolPolicy();pool={linked:raw.vpnGuardEnabled,vpnPolicyVersion:raw.vpnPolicyVersion,error:null};}catch{pool.error='Pooler linkage unavailable';}
    return {mode:config.mode,manualBlock:config.manualBlock,serverHostId,hostIds:config.hostIds,suspendNativePluginsGlobally:config.suspendNativePluginsGlobally,coordinateAutomations:config.coordinateAutomations,automationControllerPath:config.automationControllerPath,
      hosts,protectedProviders:PROTECTED_PROVIDERS,ownedDisabledPlugins:[...owned],ambiguousPluginChanges:[...pending],stoppedThreadIds:[...stopped],stopHistory:[...stopHistory],events:journal.snapshot(),limitations:LIMITATIONS,pool,automations:{status:automationStatus,error:automationError,held:automationBinding!==null||bindingCorrupt,needsReconcile:automationDesired===null,busy:automationBusy||automationTask!==null,lastAttemptAt:lastAutomationAttempt,lastSuccessAt:lastAutomationSuccess,retryAt:automationRetryAt}};
  }
  async function saveConfig(next:Configuration) {
    await bb.storage.kv.set(CONFIG,next);
    const previous=config;config=next;automationPolicyVersion++;automationRetryAt=null;
    policyVersion++;
    recheckDirty=true;
    if(previous.manualBlock!==next.manualBlock)event({kind:next.manualBlock?'manual_block_on':'manual_block_off',reason:'manual_block'});
  }
  async function saveOwned() {await bb.storage.kv.set(JOURNAL,[...owned]);}
  async function savePending() {await bb.storage.kv.set(PENDING,[...pending]);}
  async function suspendNativePlugins(onlyOwned=false):Promise<Error[]> {
    const failures:Error[]=[];
    const {plugins}=await bb.sdk.plugins.list();
    for(const id of NATIVE_PLUGINS) {
      if(onlyOwned&&!owned.has(id)) continue;
      const entry=plugins.find(p=>p.id===id);
      if(!entry?.enabled) continue;
      try {
        pending.add(id);
        policyVersion++;
        recheckDirty=true;
        await savePending();
        await bb.sdk.plugins.disable({pluginId:id});
        owned.add(id);
        policyVersion++;
        recheckDirty=true;
        await saveOwned();
        pending.delete(id);
        policyVersion++;
        recheckDirty=true;
        await savePending();
        nativeProblem=null;event({kind:'native_paused',pluginId:id});
      } catch(error) {if(nativeProblem!==`pause:${id}`){nativeProblem=`pause:${id}`;event({kind:'native_pause_failed',pluginId:id,reason:'operation_failed'});}failures.push(new Error(`${id}: ${String(error)}`));}
    }
    return failures;
  }
  async function assertNativeRecovery(automatic:boolean) {
    if(config.manualBlock) throw new Error("Release the manual block before restoring native plugins.");
    if((automatic&&config.hostIds.length===0)||(await Promise.all(config.hostIds.map(vpn))).some(state=>state!=='connected')) throw new Error('Selected machines must be connected before restoring native plugins.');
  }
  async function restoreOwned(automatic=false) {
    await assertNativeRecovery(automatic);
    const {plugins}=await bb.sdk.plugins.list();
    for(const id of [...owned]) {
      const entry=plugins.find(p=>p.id===id);
      if(!entry) continue; // keep the claim visible if the plugin is missing
      await assertNativeRecovery(automatic);
      if(!entry.enabled) await bb.sdk.plugins.enable({pluginId:id});
      try {await assertNativeRecovery(automatic);}
      catch(error) {
        // Enable can take long enough for VPN to disappear. Retain ownership
        // and restore the paused state; this is not a packet-level guarantee.
        await bb.sdk.plugins.disable({pluginId:id});
        throw error;
      }
      const next=new Set(owned);next.delete(id);
      await bb.storage.kv.set(JOURNAL,[...next]);
      owned=next;
      nativeProblem=null;event({kind:'native_restored',pluginId:id as 'provider-codex'|'provider-claude-code'});
      policyVersion++;
      recheckDirty=true;
    }
  }
  async function stopProtected(states:Map<string,VpnState>,snapshot:Awaited<ReturnType<typeof status>>):Promise<Error[]> {
    const failures:Error[]=[];
    let runningThreads:Awaited<ReturnType<typeof bb.sdk.threads.listRunning>>;
    try {runningThreads=await bb.sdk.threads.listRunning();}
    catch(error) {return [new Error(`threads.listRunning: ${String(error)}`)];}
    for(const running of runningThreads) {
      if(!running.hostId || !config.hostIds.includes(running.hostId) || (!config.manualBlock && states.get(running.hostId)==='connected')) continue;
      try {
        const thread=await bb.sdk.threads.get({threadId:running.id});
        if(!protectedProvider(thread.providerId)) continue;
        await bb.sdk.threads.stop({threadId:running.id});
        stopped.add(running.id);
        if(stopped.size>100) stopped=new Set([...stopped].slice(-100));
        await bb.storage.kv.set(STOPPED,[...stopped]);
        const observation=snapshot.hosts.find(h=>h.id===running.hostId);
        const reason=config.manualBlock?'manual_block':!observation?.available?'host_catalog_unavailable':!observation.evidence?'host_rpc_failed':observation.evidence.reason;
        const parsedReason=stopReasonSchema.safeParse(reason);
        const stopRecord=stopObservationSchema.safeParse({threadId:running.id,hostId:running.hostId,at:Date.now(),reason:parsedReason.success?parsedReason.data:'invalid_evidence'});
        if(stopRecord.success){stopHistory=[...stopHistory,stopRecord.data].slice(-100);await bb.storage.kv.set(STOP_HISTORY,stopHistory);}else bb.log.warn('VPN Guard stop observation rejected');
        event({kind:'thread_stopped',hostId:running.hostId,threadId:running.id,reason:parsedReason.success?parsedReason.data:'invalid_evidence'});
      } catch(error) {failures.push(new Error(`thread ${running.id}: ${String(error)}`));}
    }
    return failures;
  }
  async function controller(action:'status'|'hold'|'release'|'pause'|'resume',binding:{hostId:string;executable:string},reviewed=false,restoreRevision:string|null=null,schedulesOnly=false) {
    assertAutomationCurrent();
    if(bindingCorrupt)throw Error('Automation ownership journal is malformed; manual review required');
    const value=await host.call('automation',{action,instanceId,executable:binding.executable,reviewed,restoreRevision,schedulesOnly},{hostId:binding.hostId,timeoutMs:32_000,signal:lifetime.signal});
    assertAutomationCurrent();
    automationStatus=automationStatusSchema.parse(value);automationError=null;
    return automationStatus;
  }
  async function resumeAutomations(binding:{hostId:string;executable:string},automatic:boolean) {
    // Always inspect immediately before resume: release responses do not carry a
    // live revision. The controller checks this revision again under its lock.
    const report=await controller('status',binding);
    if(automatic&&(report.holds.length>0||report.legacyBlocked||!report.recoveryPending))return;
    if(!report.restoreRevision)throw Error('Automation recovery snapshot unavailable; retry required');
    if(await vpn(binding.hostId)!=='connected')throw Error('Release protection blocks and verify VPN before resuming');
    const restored=await controller('resume',binding,true,report.restoreRevision,automatic);
    if(restored.errors.length||restored.blocked||restored.recoveryPending)throw Error('Automation recovery is incomplete; inspect controller status');
    event({kind:'automation_restored',hostId:binding.hostId});
  }
  async function coordinate(snapshot:Awaited<ReturnType<typeof status>>) {
    assertAutomationCurrent();
    if(bindingCorrupt)throw Error('Automation ownership journal is malformed; manual review required');
    const server=snapshot.hosts.find(h=>h.id===snapshot.serverHostId);
    const wants=config.coordinateAutomations&&!!server?.selected&&(config.manualBlock||(config.mode==='enforce'&&server.vpn!=='connected'));
    try {
      if(wants) {
        if(!snapshot.serverHostId||!config.automationControllerPath)throw Error('Automation controller and server host must be configured');
        const binding={hostId:snapshot.serverHostId,executable:config.automationControllerPath};
        if(automationBinding&&(automationBinding.hostId!==binding.hostId||automationBinding.executable!==binding.executable))throw Error('Release the previous controller hold before changing its binding');
        const newlyHeld=automationBinding===null;
        if(!automationBinding){await bb.storage.kv.set('automation-hold-binding-v1',binding);automationBinding=binding;}
        // Hold is idempotent and retries failed or newly enabled schedules.
        const report=await controller('hold',binding);
        if(!report.holds.some(h=>h.owner===`vpn-guard:${instanceId}`))throw Error('Automation controller did not confirm the protection hold');
        if(report.errors.length)throw Error('Automation pause is incomplete; inspect controller status');
        if(newlyHeld)event({kind:'automation_hold',hostId:binding.hostId});
        if(report.activeRuns.length)automationError='Active automation runs may continue or are unverified';
      } else if(automationBinding) {
        const report=await controller('release',automationBinding);
        if(report.holds.some(h=>h.owner===`vpn-guard:${instanceId}`))throw Error('Automation protection hold was not released; retry required');
        const releasedHost=automationBinding.hostId;
        await bb.storage.kv.set('automation-hold-binding-v1',null);automationBinding=null;
        assertAutomationCurrent();event({kind:'automation_release',hostId:releasedHost});
        if(report.errors.length)automationError='Automation recovery is incomplete; inspect controller status';
      } else if(config.coordinateAutomations&&snapshot.serverHostId&&config.automationControllerPath) {
        await controller('status',{hostId:snapshot.serverHostId,executable:config.automationControllerPath});
      }
      if(!wants&&!automationBinding&&config.coordinateAutomations&&!config.manualBlock&&server?.selected&&server.vpn==='connected'&&config.automationControllerPath&&automationStatus?.recoveryPending) {
        await resumeAutomations({hostId:server.id,executable:config.automationControllerPath},true);
      }
      assertAutomationCurrent();automationDesired=wants;lastCoordinatedVersion=automationPolicyVersion;
    } catch(error){automationDesired=null;throw error;}
  }
  async function reconcile() {
    const snapshot=await status();
    const states=new Map(snapshot.hosts.filter(h=>h.selected).map(h=>[h.id,h.vpn??'unknown'] as const));
    const failures:Error[]=[];
    for(const observation of snapshot.hosts.filter(h=>h.selected)) {
      const reason=observation.vpn==='connected'?undefined:!observation.available?'host_catalog_unavailable':!observation.evidence?'host_rpc_failed':stopReasonSchema.safeParse(observation.evidence.reason).success?stopReasonSchema.parse(observation.evidence.reason):'invalid_evidence';
      const key=`${observation.vpn}:${reason??'ok'}`;
      if(observedVpn.get(observation.id)!==key){automationPolicyVersion++;automationRetryAt=null;observedVpn.set(observation.id,key);event({kind:observation.vpn==='connected'?'vpn_connected':'vpn_blocked',hostId:observation.id,reason});}
    }
    for(const id of observedVpn.keys())if(!config.hostIds.includes(id))observedVpn.delete(id);
    const vpnUnavailable=states.size===0||[...states.values()].some(state=>state!=='connected');
    const blocking=config.manualBlock||(config.mode==='enforce'&&vpnUnavailable);
    if(config.suspendNativePluginsGlobally&&blocking) {
      try {failures.push(...await suspendNativePlugins());}
      catch(error) {failures.push(new Error(`native suspension: ${String(error)}`));}
    } else if(owned.size>0&&(config.manualBlock||vpnUnavailable)) {
      // Disabling the option prevents new ownership, but cannot abandon an
      // interrupted recovery which may have enabled an owned plugin already.
      try {failures.push(...await suspendNativePlugins(true));}
      catch(error) {failures.push(new Error(`native suspension: ${String(error)}`));}
    }
    if(config.manualBlock || (config.mode==='enforce' && [...states.values()].some(state=>state!=='connected'))) {
      failures.push(...await stopProtected(states,snapshot));
    } else if(!config.manualBlock&&states.size>0&&[...states.values()].every(state=>state==='connected')&&owned.size>0) {
      try {await restoreOwned(true);}
      catch(error) {if(nativeProblem!=='restore'){nativeProblem='restore';event({kind:'native_restore_failed',reason:String(error).includes('connected')?'vpn_unavailable':'operation_failed'});}failures.push(new Error(`native recovery: ${String(error)}`));}
    }
    requestCoordination();
    if(recheckDirty || [...states].some(([id,state])=>previousStates.get(id)!==state) || previousStates.size!==states.size) {
      try {
        await bb.experimental_hooks.recheck('message.dispatch');
        previousStates=states;
        recheckDirty=false;
      } catch(error) {failures.push(new Error(`dispatch recheck: ${String(error)}`));}
    }
    if(failures.length) throw new AggregateError(failures,`VPN Guard reconcile failed: ${failures.map(error=>error.message).join('; ')}`);
  }
  async function update(next:Configuration) {
    if((next.mode==='enforce' || next.manualBlock) && next.hostIds.length===0) throw new Error('Select at least one machine before enforcement.');
    await saveConfig(next);
    await reconcile();
    return status();
  }
  async function setHosts(hostIds:string[]) {
    const unique=[...new Set(hostIds)];
    if(unique.some(id=>!config.hostIds.includes(id))) {
      const available=new Set((await bb.sdk.hosts.list()).map(h=>h.id));
      if(unique.some(id=>!available.has(id) && !config.hostIds.includes(id))) throw new Error('A newly selected machine is not enrolled.');
    }
    return update({...config,hostIds:unique});
  }
  async function acknowledgeAmbiguous(pluginId:string,reviewed:boolean) {
    if(!reviewed) throw new Error('Review the plugin state before acknowledging this journal entry.');
    if(!pending.has(pluginId)) throw new Error('No ambiguous entry for this plugin.');
    const next=new Set(pending);next.delete(pluginId);
    await bb.storage.kv.set(PENDING,[...next]);
    pending=next;
    policyVersion++;
    recheckDirty=true;
    await bb.experimental_hooks.recheck('message.dispatch');
    recheckDirty=false;
    return status();
  }
  function nativePluginFor(providerId:string) {
    return providerId==='codex'?'provider-codex':providerId==='claude'||providerId==='claude-code'?'provider-claude-code':'';
  }
  bb.experimental_hooks.on('message.dispatch',async context=>{
    const id=context.requestedExecution.providerId;
    if(!protectedProvider(id)) return {action:'proceed'};
    const hostId=context.host?.id;
    while(true) {
      const version=policyVersion;
      if(owned.has(nativePluginFor(id)) || pending.has(nativePluginFor(id))) return {action:'wait',reason:'VPN Guard: native plugin change awaits review or restore'};
      if(!hostId || !config.hostIds.includes(hostId)) return {action:'proceed'};
      if(config.manualBlock) return {action:'wait',reason:'VPN Guard: manual block on selected host'};
      if(config.mode!=='enforce') return {action:'proceed'};
      let available=false;
      try {available=(await bb.sdk.hosts.list()).some(h=>h.id===hostId);}
      catch { /* unavailable host catalog fails closed */ }
      const state=available?await vpn(hostId):'unknown';
      if(version!==policyVersion) continue;
      return state==='connected'?{action:'proceed'}:{action:'wait',reason:`VPN Guard: ${state} on selected host`};
    }
  });
  async function networkDecision(hostId:string,provider:string) {
    while(true) {
      const version=policyVersion;
      const decision=(allowed:boolean,reason:'manual_block'|'vpn_unavailable'|'outside_scope'|'observe'|'connected'|'restore_required')=>({schema:'bb-vpn-guard/network-decision/1' as const,allowed,reason});
      if(owned.has(nativePluginFor(provider)) || pending.has(nativePluginFor(provider))) return decision(false,'restore_required');
      if(!config.hostIds.includes(hostId)) return decision(true,'outside_scope');
      if(config.manualBlock) return decision(false,'manual_block');
      if(config.mode==='observe') return decision(true,'observe');
      {
        try {
          const pool=await poolPolicy();
          if(provider!=='opencode-go'&&!pool.vpnOnlyProviders.includes(provider))return decision(false,'vpn_unavailable');
        }catch{return decision(false,'vpn_unavailable');}
      }
      let available=false;
      try {available=(await bb.sdk.hosts.list()).some(h=>h.id===hostId);} catch {}
      const state=available?await vpn(hostId):'unknown';
      if(version!==policyVersion) continue;
      return state==='connected'?decision(true,'connected'):decision(false,'vpn_unavailable');
    }
  }
  const resumeClaimSchema=z.array(z.object({threadId:z.string(),stoppedAt:z.number().int().nonnegative()})).max(100);
  const savedResumeClaims=resumeClaimSchema.safeParse((await bb.storage.kv.get('thread-resume-claims-v1'))??[]);
  let resumeClaims=savedResumeClaims.success?savedResumeClaims.data:null;
  const resumeFlights=new Set<string>();
  let resumeClaimTail:Promise<void>=Promise.resolve();
  async function resumeThread(threadId:string,stoppedAt:number) {
    if(resumeFlights.has(threadId))throw Error('Resume is already pending. Open the thread to check.');
    resumeFlights.add(threadId);
    const version=policyVersion;
    const assertCurrent=()=>{
      if(disposed||version!==policyVersion||config.manualBlock)throw Error('Protection policy changed; open the thread to continue.');
      const record=stopHistory.slice().reverse().find(stop=>stop.threadId===threadId);
      if(!record||record.at!==stoppedAt||!config.hostIds.includes(record.hostId))throw Error('This Guard stop is no longer current. Open the thread to continue.');
      return record;
    };
    const assertThread=(thread:Awaited<ReturnType<typeof bb.sdk.threads.get>>)=>{
      if(thread.status!=='idle'||thread.archivedAt!=null||thread.deletedAt!=null||thread.queuedMessageCount||thread.updatedAt>stoppedAt)throw Error('The thread has changed since this stop. Open it to continue.');
      if(owned.has(nativePluginFor(thread.providerId))||pending.has(nativePluginFor(thread.providerId)))throw Error('Restore native plugins before resuming.');
    };
    try {
      const record=assertCurrent();
      const initial=await bb.sdk.threads.get({threadId});assertCurrent();assertThread(initial);
      if(await vpn(record.hostId)!=='connected')throw Error('Verified VPN is required before resuming.');
      assertCurrent();
      // Only claim writes serialize with each other; slow reads/sends never own the protection lane.
      const claim=resumeClaimTail.then(async()=>{
        assertCurrent();
        if(!resumeClaims||resumeClaims.some(value=>value.threadId===threadId&&value.stoppedAt===stoppedAt))throw Error('Resume was already requested or is uncertain. Open the thread to check.');
        const next=[...resumeClaims,{threadId,stoppedAt}].slice(-100);
        await bb.storage.kv.set('thread-resume-claims-v1',next);resumeClaims=next;
      });
      resumeClaimTail=claim.then(()=>undefined,()=>undefined);await claim;assertCurrent();
      if(await vpn(record.hostId)!=='connected')throw Error('Verified VPN is required before resuming.');
      assertCurrent();
      const current=await bb.sdk.threads.get({threadId});assertCurrent();assertThread(current);
      if(current.providerId!==initial.providerId)throw Error('The thread provider changed. Open it to continue.');
      // BB has no atomic compare-and-send. Normal admission still checks current protection.
      await bb.sdk.threads.send({threadId,mode:'start',input:[{type:'text',mentions:[],text:'Continue the work interrupted by VPN Guard. Check the current state before repeating any actions.'}]});
      return {accepted:true as const};
    } finally {resumeFlights.delete(threadId);}
  }
  bb.rpc.register(rpcContract,{
    resumeThread:({threadId,stoppedAt})=>resumeThread(threadId,stoppedAt),
    automationIdentity:()=>({instanceId}),
    setAutomationCoordination:({enabled,executable})=>serial(async()=>{
      if(enabled&&(!executable||!executable.startsWith('/')))throw Error('An absolute automation controller path is required');
      if(enabled){const primary=(await bb.sdk.system.config()).primaryHostId;if(!primary||!config.hostIds.includes(primary))throw Error('Select the BB server host before connecting automation protection');}
      if((automationBinding||automationBusy||automationTask)&&executable!==config.automationControllerPath)throw Error('Release the controller hold before changing the executable');
      return update({...config,coordinateAutomations:enabled,automationControllerPath:executable});
    }),
    automationAction:({action})=>{const requestedRevision=automationPolicyVersion;return automationSerial(async()=>{
      if(requestedRevision!==automationPolicyVersion)throw new AutomationPolicyChanged();
      const snapshot=await status();assertAutomationCurrent();
      if(!config.coordinateAutomations||!snapshot.serverHostId||!config.automationControllerPath)throw Error('Automation controller is not configured');
      if(action==='resume'&&(config.manualBlock||automationBinding||snapshot.hosts.some(h=>h.selected&&h.vpn!=='connected')))throw Error('Release protection blocks and verify VPN before resuming');
      const binding={hostId:snapshot.serverHostId,executable:config.automationControllerPath};
      if(action==='resume')await resumeAutomations(binding,false);
      else {
        const report=await controller(action,binding);
        if(report.errors.length)throw Error('Automation action incomplete; inspect controller status');
      }
      requestCoordination(true);return status();
    });},
    networkDecision:({hostId,provider})=>networkDecision(hostId,provider),
    status:()=>status(),
    setManualBlock:({blocked})=>serial(()=>update({...config,manualBlock:blocked})),
    setMode:({mode})=>serial(()=>update({...config,mode})),
    setHosts:({hostIds})=>serial(()=>setHosts(hostIds)),
    setGlobalSuspension:({enabled,acknowledgeGlobalImpact})=>serial(()=>{
      if(enabled && !acknowledgeGlobalImpact) throw new Error('Global native plugin suspension needs explicit acknowledgment.');
      return update({...config,suspendNativePluginsGlobally:enabled});
    }),
    restoreOwned:()=>serial(async()=>{await restoreOwned();await bb.experimental_hooks.recheck('message.dispatch');recheckDirty=false;return status();}),
    acknowledgeAmbiguous:({pluginId,acknowledgeReviewed})=>serial(()=>acknowledgeAmbiguous(pluginId,acknowledgeReviewed)),
  });
  bb.cli.register({
    name:'vpn-guard',summary:'Observe and guard selected BB machines',
    commands:[
      {name:'block',summary:'Block selected machines regardless of VPN',usage:'bb vpn-guard block'},
      {name:'unblock',summary:'Release manual block and retain current mode',usage:'bb vpn-guard unblock'},
      {name:'status',summary:'Show scope, VPN decisions and actions',usage:'bb vpn-guard status [--json]'},
      {name:'hosts',summary:'Select protected machines',usage:'bb vpn-guard hosts <host-id>... | none'},
      {name:'enforce',summary:'Enforce on selected machines',usage:'bb vpn-guard enforce'},
      {name:'observe',summary:'Return to observation',usage:'bb vpn-guard observe'},
      {name:'global-suspend',summary:'Opt in to global native plugin suspension',usage:'bb vpn-guard global-suspend on --ack-global | off'},
      {name:'restore-owned',summary:'Explicitly restore Guard-owned native plugins',usage:'bb vpn-guard restore-owned'},
      {name:'acknowledge-ambiguous',summary:'Clear a reviewed ambiguous journal entry without changing plugin state',usage:'bb vpn-guard acknowledge-ambiguous <plugin-id> --reviewed'},
    ],
    async run(argv) {
      const [command,...args]=argv.filter(a=>a!=='--json');
      try {
        let result;
        if(command==='status' && args.length===0) result=await status();
        else if((command==='block'||command==='unblock') && args.length===0) result=await serial(()=>update({...config,manualBlock:command==='block'}));
        else if(command==='enforce' && args.length===0) result=await serial(()=>update({...config,mode:'enforce'}));
        else if(command==='observe' && args.length===0) result=await serial(()=>update({...config,mode:'observe'}));
        else if(command==='hosts' && args.length>0) {
          const hostIds=args.length===1 && args[0]==='none'?[]:args;
          result=await serial(()=>setHosts(hostIds));
        } else if(command==='global-suspend' && ((args.length===2 && args[0]==='on' && args[1]==='--ack-global')||(args.length===1 && args[0]==='off'))) {
          result=await serial(()=>update({...config,suspendNativePluginsGlobally:args[0]==='on'}));
        } else if(command==='restore-owned' && args.length===0) result=await serial(async()=>{await restoreOwned();await bb.experimental_hooks.recheck('message.dispatch');recheckDirty=false;return status();});
        else if(command==='acknowledge-ambiguous' && args.length===2 && args[1]==='--reviewed') result=await serial(()=>acknowledgeAmbiguous(args[0],true));
        else return {exitCode:1,stderr:'Usage: bb vpn-guard status|hosts|block|unblock|enforce|observe|global-suspend|restore-owned|acknowledge-ambiguous'};
        return {exitCode:0,stdout:JSON.stringify(result)};
      } catch(error) {return {exitCode:1,stderr:String(error)};}
    },
  });
  bb.background.service('reconcile',{
    async start(signal) {
      while(!signal.aborted) {
        try {await serial(reconcile);} catch(error) {bb.log.warn(`VPN Guard reconcile failed: ${String(error)}`);}
        await abortableDelay(signal,5000);
      }
    },
  });
}
