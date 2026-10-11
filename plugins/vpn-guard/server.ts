import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { configurationSchema, hostContract, rpcContract } from './contract.js';
import { abortableDelay } from './delay.js';
import { protectedProvider, type VpnState } from './state.js';

const CONFIG = 'configuration-v2';
const JOURNAL = 'owned-disabled-native-plugins-v2';
const PENDING = 'pending-native-plugin-changes-v2';
const STOPPED = 'stopped-thread-ids-v1';
const NATIVE_PLUGINS = ['provider-codex','provider-claude-code'] as const;
const PROTECTED_PROVIDERS = ['codex','claude','claude-code','cursor','acp-cursor','devin','acp-devin'];
const LIMITATIONS = [
  'Send-now bypasses message.dispatch.',
  'Native plugin suspension is global across hosts and requires separate opt-in.',
  'Disabled native plugins require explicit restore; BB has no ownership revision for manual changes.',
  'A crash during plugin disable leaves an ambiguous journal entry for manual review, never automatic restoration.',
  'In-flight connections, running scripts, and existing bridge processes are not a proven network block.',
  'Generic ACP IDs other than acp-cursor/acp-devin are outside this policy.',
  'VPN Guard is BB admission control, not a packet firewall.',
];
type Configuration = z.infer<typeof configurationSchema>;
const initialConfiguration: Configuration = {mode:'observe',hostIds:[],suspendNativePluginsGlobally:false};

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({contract:hostContract});
  const loaded=configurationSchema.safeParse(await bb.storage.kv.get<unknown>(CONFIG));
  let config:Configuration=loaded.success ? loaded.data : initialConfiguration;
  if (config.mode==='enforce' && config.hostIds.length===0) config={...config,mode:'observe'};
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
  let tail:Promise<void>=Promise.resolve();
  let previousStates=new Map<string,VpnState>();

  function serial<T>(operation:()=>Promise<T>):Promise<T> {
    const run=tail.then(operation,operation);
    tail=run.then(()=>undefined,()=>undefined);
    return run;
  }
  async function vpn(hostId:string):Promise<VpnState> {
    try {return (await host.call('readState',null,{hostId,timeoutMs:1500})).state;}
    catch {return 'unknown';}
  }
  async function status() {
    const listed=await bb.sdk.hosts.list();
    const selected=new Set(config.hostIds);
    const hosts=await Promise.all(listed.map(async h=>({
      id:h.id,name:h.name,selected:selected.has(h.id),available:true,
      vpn:selected.has(h.id)?await vpn(h.id):null,
    })));
    for (const id of selected) if(!listed.some(h=>h.id===id)) hosts.push({id,name:id,selected:true,available:false,vpn:'unknown'});
    return {mode:config.mode,hostIds:config.hostIds,suspendNativePluginsGlobally:config.suspendNativePluginsGlobally,
      hosts,protectedProviders:PROTECTED_PROVIDERS,ownedDisabledPlugins:[...owned],ambiguousPluginChanges:[...pending],stoppedThreadIds:[...stopped],limitations:LIMITATIONS};
  }
  async function saveConfig(next:Configuration) {
    await bb.storage.kv.set(CONFIG,next);
    config=next;
  }
  async function saveOwned() {await bb.storage.kv.set(JOURNAL,[...owned]);}
  async function savePending() {await bb.storage.kv.set(PENDING,[...pending]);}
  async function suspendNativePlugins() {
    const {plugins}=await bb.sdk.plugins.list();
    for(const id of NATIVE_PLUGINS) {
      const entry=plugins.find(p=>p.id===id);
      if(!entry?.enabled) continue;
      pending.add(id);
      await savePending();
      await bb.sdk.plugins.disable({pluginId:id});
      owned.add(id);
      await saveOwned();
      pending.delete(id);
      await savePending();
    }
  }
  async function restoreOwned() {
    const snapshot=await status();
    if(snapshot.hosts.some(h=>h.selected && h.vpn!=='connected')) throw new Error('Selected machines must be connected before restoring native plugins.');
    const {plugins}=await bb.sdk.plugins.list();
    for(const id of [...owned]) {
      const entry=plugins.find(p=>p.id===id);
      if(!entry) continue; // keep the claim visible if the plugin is missing
      if(!entry.enabled) await bb.sdk.plugins.enable({pluginId:id});
      owned.delete(id);
      await saveOwned();
    }
  }
  async function stopProtected(states:Map<string,VpnState>) {
    for(const running of await bb.sdk.threads.listRunning()) {
      if(!running.hostId || !config.hostIds.includes(running.hostId) || states.get(running.hostId)==='connected') continue;
      try {
        const thread=await bb.sdk.threads.get({threadId:running.id});
        if(!protectedProvider(thread.providerId)) continue;
        await bb.sdk.threads.stop({threadId:running.id});
        stopped.add(running.id);
        if(stopped.size>100) stopped=new Set([...stopped].slice(-100));
        await bb.storage.kv.set(STOPPED,[...stopped]);
      } catch(error) {bb.log.warn(`Could not stop protected thread ${running.id}: ${String(error)}`);}
    }
  }
  async function reconcile() {
    const snapshot=await status();
    const states=new Map(snapshot.hosts.filter(h=>h.selected).map(h=>[h.id,h.vpn??'unknown'] as const));
    if(config.mode==='enforce' && [...states.values()].some(state=>state!=='connected')) {
      await stopProtected(states);
      if(config.suspendNativePluginsGlobally) await suspendNativePlugins();
    }
    if([...states].some(([id,state])=>previousStates.get(id)!==state) || previousStates.size!==states.size) {
      previousStates=states;
      await bb.experimental_hooks.recheck('message.dispatch');
    }
  }
  async function update(next:Configuration) {
    if(next.mode==='enforce' && next.hostIds.length===0) throw new Error('Select at least one machine before enforcement.');
    await saveConfig(next);
    await reconcile();
    await bb.experimental_hooks.recheck('message.dispatch');
    return status();
  }
  bb.experimental_hooks.on('message.dispatch',async context=>{
    const id=context.requestedExecution.providerId;
    if(!protectedProvider(id)) return {action:'proceed'};
    if(owned.has(id==='codex'?'provider-codex':id==='claude'||id==='claude-code'?'provider-claude-code':''))
      return {action:'wait',reason:'VPN Guard: native plugin awaits explicit restore'};
    const hostId=context.host?.id;
    if(config.mode!=='enforce' || !hostId || !config.hostIds.includes(hostId)) return {action:'proceed'};
    if(!(await bb.sdk.hosts.list()).some(h=>h.id===hostId)) return {action:'wait',reason:'VPN Guard: selected host unavailable'};
    const state=await vpn(hostId);
    return state==='connected'?{action:'proceed'}:{action:'wait',reason:`VPN Guard: ${state} on selected host`};
  });
  bb.rpc.register(rpcContract,{
    status:()=>status(),
    setMode:({mode})=>serial(()=>update({...config,mode})),
    setHosts:({hostIds})=>serial(async()=>{
      const unique=[...new Set(hostIds)];
      const available=new Set((await bb.sdk.hosts.list()).map(h=>h.id));
      if(unique.some(id=>!available.has(id))) throw new Error('A selected machine is not enrolled.');
      return update({...config,hostIds:unique});
    }),
    setGlobalSuspension:({enabled,acknowledgeGlobalImpact})=>serial(()=>{
      if(enabled && !acknowledgeGlobalImpact) throw new Error('Global native plugin suspension needs explicit acknowledgment.');
      return update({...config,suspendNativePluginsGlobally:enabled});
    }),
    restoreOwned:()=>serial(async()=>{await restoreOwned();await bb.experimental_hooks.recheck('message.dispatch');return status();}),
  });
  bb.cli.register({
    name:'vpn-guard',summary:'Observe and guard selected BB machines',
    commands:[
      {name:'status',summary:'Show scope, VPN decisions and actions',usage:'bb vpn-guard status [--json]'},
      {name:'hosts',summary:'Select protected machines',usage:'bb vpn-guard hosts <host-id>... | none'},
      {name:'enforce',summary:'Enforce on selected machines',usage:'bb vpn-guard enforce'},
      {name:'observe',summary:'Return to observation',usage:'bb vpn-guard observe'},
      {name:'global-suspend',summary:'Opt in to global native plugin suspension',usage:'bb vpn-guard global-suspend on --ack-global | off'},
      {name:'restore-owned',summary:'Explicitly restore Guard-owned native plugins',usage:'bb vpn-guard restore-owned'},
    ],
    async run(argv) {
      const [command,...args]=argv.filter(a=>a!=='--json');
      try {
        let result;
        if(command==='status' && args.length===0) result=await status();
        else if(command==='enforce' && args.length===0) result=await serial(()=>update({...config,mode:'enforce'}));
        else if(command==='observe' && args.length===0) result=await serial(()=>update({...config,mode:'observe'}));
        else if(command==='hosts' && args.length>0) {
          const hostIds=args.length===1 && args[0]==='none'?[]:args;
          result=await serial(async()=>{
            const unique=[...new Set(hostIds)];
            const available=new Set((await bb.sdk.hosts.list()).map(h=>h.id));
            if(unique.some(id=>!available.has(id))) throw new Error('A selected machine is not enrolled.');
            return update({...config,hostIds:unique});
          });
        } else if(command==='global-suspend' && ((args.length===2 && args[0]==='on' && args[1]==='--ack-global')||(args.length===1 && args[0]==='off'))) {
          result=await serial(()=>update({...config,suspendNativePluginsGlobally:args[0]==='on'}));
        } else if(command==='restore-owned' && args.length===0) result=await serial(async()=>{await restoreOwned();await bb.experimental_hooks.recheck('message.dispatch');return status();});
        else return {exitCode:1,stderr:'Usage: bb vpn-guard status|hosts|enforce|observe|global-suspend|restore-owned'};
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
