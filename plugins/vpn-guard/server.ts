import {randomUUID} from 'node:crypto';
import {automationStatusSchema,type AutomationStatus} from './automation-contract.js';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { configurationSchema, hostContract, rpcContract, stopObservationSchema, stopReasonSchema } from './contract.js';
import { abortableDelay } from './delay.js';
import { protectedProvider, PROTECTED_PROVIDERS, type VpnState } from './state.js';

const CONFIG = 'configuration-v2';
const JOURNAL = 'owned-disabled-native-plugins-v2';
const PENDING = 'pending-native-plugin-changes-v2';
const STOPPED = 'stopped-thread-ids-v1';
const STOP_HISTORY = 'stop-observations-v1';
const NATIVE_PLUGINS = ['provider-codex','provider-claude-code'] as const;
const LIMITATIONS = [
  'Send-now bypasses message.dispatch.',
  'Native plugin suspension is global across hosts and requires separate opt-in.',
  'Disabled native plugins require explicit restore; BB has no ownership revision for manual changes.',
  'A crash during plugin disable leaves an ambiguous journal entry for manual review, never automatic restoration.',
  'An ambiguous native plugin change holds its provider until explicitly acknowledged after review.',
  'In-flight connections, running scripts, and existing bridge processes are not a proven network block.',
  'Generic ACP IDs other than acp-cursor/acp-devin are outside this policy.',
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
      hosts,protectedProviders:PROTECTED_PROVIDERS,ownedDisabledPlugins:[...owned],ambiguousPluginChanges:[...pending],stoppedThreadIds:[...stopped],stopHistory:[...stopHistory],limitations:LIMITATIONS,pool,automations:{status:automationStatus,error:automationError,held:automationBinding!==null||bindingCorrupt,needsReconcile:automationDesired===null}};
  }
  async function saveConfig(next:Configuration) {
    await bb.storage.kv.set(CONFIG,next);
    config=next;
    policyVersion++;
    recheckDirty=true;
  }
  async function saveOwned() {await bb.storage.kv.set(JOURNAL,[...owned]);}
  async function savePending() {await bb.storage.kv.set(PENDING,[...pending]);}
  async function suspendNativePlugins():Promise<Error[]> {
    const failures:Error[]=[];
    const {plugins}=await bb.sdk.plugins.list();
    for(const id of NATIVE_PLUGINS) {
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
      } catch(error) {failures.push(new Error(`${id}: ${String(error)}`));}
    }
    return failures;
  }
  async function restoreOwned() {
    if(config.manualBlock) throw new Error("Release the manual block before restoring native plugins.");
    const snapshot=await status();
    if(snapshot.hosts.some(h=>h.selected && h.vpn!=='connected')) throw new Error('Selected machines must be connected before restoring native plugins.');
    const {plugins}=await bb.sdk.plugins.list();
    for(const id of [...owned]) {
      const entry=plugins.find(p=>p.id===id);
      if(!entry) continue; // keep the claim visible if the plugin is missing
      if(!entry.enabled) await bb.sdk.plugins.enable({pluginId:id});
      owned.delete(id);
      policyVersion++;
      recheckDirty=true;
      await saveOwned();
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
        stopHistory=[...stopHistory,{threadId:running.id,hostId:running.hostId,at:Date.now(),reason:parsedReason.success?parsedReason.data:'invalid_evidence'}].slice(-100);
        await bb.storage.kv.set(STOP_HISTORY,stopHistory);
      } catch(error) {failures.push(new Error(`thread ${running.id}: ${String(error)}`));}
    }
    return failures;
  }
  async function controller(action:'status'|'hold'|'release'|'pause'|'resume',binding:{hostId:string;executable:string},reviewed=false,restoreRevision:string|null=null) {
    if(bindingCorrupt)throw Error('Automation ownership journal is malformed; manual review required');
    const value=await host.call('automation',{action,instanceId,executable:binding.executable,reviewed,restoreRevision},{hostId:binding.hostId,timeoutMs:32_000});
    automationStatus=automationStatusSchema.parse(value);automationError=null;
    return automationStatus;
  }
  async function coordinate(snapshot:Awaited<ReturnType<typeof status>>) {
    if(bindingCorrupt)throw Error('Automation ownership journal is malformed; manual review required');
    const server=snapshot.hosts.find(h=>h.id===snapshot.serverHostId);
    const wants=config.coordinateAutomations&&!!server?.selected&&(config.manualBlock||(config.mode==='enforce'&&server.vpn!=='connected'));
    try {
      if(wants) {
        if(!snapshot.serverHostId||!config.automationControllerPath)throw Error('Automation controller and server host must be configured');
        const binding={hostId:snapshot.serverHostId,executable:config.automationControllerPath};
        if(automationBinding&&(automationBinding.hostId!==binding.hostId||automationBinding.executable!==binding.executable))throw Error('Release the previous controller hold before changing its binding');
        if(!automationBinding){await bb.storage.kv.set('automation-hold-binding-v1',binding);automationBinding=binding;}
        // Hold is idempotent and retries failed or newly enabled schedules.
        const report=await controller('hold',binding);
        if(!report.holds.some(h=>h.owner===`vpn-guard:${instanceId}`))throw Error('Automation controller did not confirm the protection hold');
        if(report.errors.length)throw Error('Automation pause is incomplete; inspect controller status');
        if(report.activeRuns.length)automationError='Active automation runs may continue or are unverified';
      } else if(automationBinding) {
        const report=await controller('release',automationBinding);
        if(report.holds.some(h=>h.owner===`vpn-guard:${instanceId}`))throw Error('Automation protection hold was not released; retry required');
        await bb.storage.kv.set('automation-hold-binding-v1',null);automationBinding=null;
        if(report.errors.length)automationError='Automation recovery is incomplete; inspect controller status';
      } else if(config.coordinateAutomations&&snapshot.serverHostId&&config.automationControllerPath) {
        await controller('status',{hostId:snapshot.serverHostId,executable:config.automationControllerPath});
      }
      automationDesired=wants;
    } catch(error){automationError=String(error);automationDesired=null;throw error;}
  }
  async function reconcile() {
    const snapshot=await status();
    const states=new Map(snapshot.hosts.filter(h=>h.selected).map(h=>[h.id,h.vpn??'unknown'] as const));
    const failures:Error[]=[];
    if(config.manualBlock || (config.mode==='enforce' && [...states.values()].some(state=>state!=='connected'))) {
      if(config.suspendNativePluginsGlobally) {
        try {failures.push(...await suspendNativePlugins());}
        catch(error) {failures.push(new Error(`native suspension: ${String(error)}`));}
      }
      failures.push(...await stopProtected(states,snapshot));
    }
    try{await coordinate(snapshot);}catch(error){failures.push(new Error(`automation coordination: ${String(error)}`));}
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
          if(!pool.vpnOnlyProviders.includes(provider))return decision(false,'vpn_unavailable');
        }catch{return decision(false,'vpn_unavailable');}
      }
      let available=false;
      try {available=(await bb.sdk.hosts.list()).some(h=>h.id===hostId);} catch {}
      const state=available?await vpn(hostId):'unknown';
      if(version!==policyVersion) continue;
      return state==='connected'?decision(true,'connected'):decision(false,'vpn_unavailable');
    }
  }
  bb.rpc.register(rpcContract,{
    automationIdentity:()=>({instanceId}),
    setAutomationCoordination:({enabled,executable})=>serial(async()=>{
      if(enabled&&(!executable||!executable.startsWith('/')))throw Error('An absolute automation controller path is required');
      if(enabled){const primary=(await bb.sdk.system.config()).primaryHostId;if(!primary||!config.hostIds.includes(primary))throw Error('Select the BB server host before connecting automation protection');}
      if(automationBinding&&executable!==config.automationControllerPath)throw Error('Release the controller hold before changing the executable');
      return update({...config,coordinateAutomations:enabled,automationControllerPath:executable});
    }),
    automationAction:({action,reviewed,restoreRevision})=>serial(async()=>{
      const snapshot=await status();
      if(!config.coordinateAutomations||!snapshot.serverHostId||!config.automationControllerPath)throw Error('Automation controller is not configured');
      if(action==='resume'&&(config.manualBlock||automationBinding||snapshot.hosts.some(h=>h.selected&&h.vpn!=='connected')))throw Error('Release protection blocks and verify VPN before resuming');
      const report=await controller(action,{hostId:snapshot.serverHostId,executable:config.automationControllerPath},reviewed,restoreRevision);
      if(report.errors.length)throw Error('Automation action incomplete; inspect controller status');
      return status();
    }),
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
