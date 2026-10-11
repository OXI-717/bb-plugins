import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { hostContract, modeSchema, rpcContract } from './contract.js';
import { protectedProvider, type VpnState } from './state.js';
import { z } from 'zod';

type Mode = 'observe' | 'enforce';
const LIMITATIONS = [
  'Send-now bypasses message.dispatch.',
  'In-flight connections, native maintenance already running, and active scripts are not intercepted.',
  'Provider opt-outs are global across hosts; a blocked host also hides protected providers on healthy hosts.',
  'A remote host without its own trusted writer is unknown and blocks protected work.',
  'This is BB admission control, not a packet firewall or VPN kill switch.',
];
const JOURNAL = 'owned-disabled-providers-v1';
const MODE = 'mode-v1';
const STOPPED = 'stopped-thread-ids-v1';

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({contract:hostContract});
  let mode: Mode = modeSchema.catch('observe').parse(await bb.storage.kv.get(MODE));
  const storedOwned=z.array(z.string()).safeParse(await bb.storage.kv.get<unknown>(JOURNAL));
  const storedStopped=z.array(z.string()).safeParse(await bb.storage.kv.get<unknown>(STOPPED));
  let owned = new Set((storedOwned.success ? storedOwned.data : []).filter(protectedProvider));
  let stopped = new Set((storedStopped.success ? storedStopped.data : []).slice(-100));
  let busy: Promise<void> = Promise.resolve();
  let previousStates = new Map<string,VpnState>();

  async function vpn(hostId: string | null): Promise<VpnState> {
    if (!hostId) return 'unknown';
    try { return (await host.call('readState', null, {hostId, timeoutMs:1500})).state; }
    catch { return 'unknown'; }
  }
  async function status() {
    const hosts = await bb.sdk.hosts.list();
    const results = await Promise.all(hosts.map(async h => ({id:h.id,name:h.name,vpn:await vpn(h.id)})));
    return {mode,hosts:results,protectedProviders:['codex','claude-code','cursor','devin'],ownedDisabledProviders:[...owned],stoppedThreadIds:[...stopped],limitations:LIMITATIONS};
  }
  async function saveOwned() { await bb.storage.kv.set(JOURNAL,[...owned]); }
  async function releaseOwned() {
    const catalog = await bb.sdk.providers.catalog();
    for (const id of [...owned]) {
      const entry = catalog.find(p=>p.id===id);
      // A missing provider, a disabled supplying plugin, or an already enabled
      // provider is never changed by the guard on recovery.
      if (entry && entry.pluginEnabled && !entry.enabled) {
        await bb.sdk.providers.setEnabled({providerId:id,enabled:true});
      }
      owned.delete(id);
      await saveOwned();
    }
  }
  async function disableProtected() {
    const catalog = await bb.sdk.providers.catalog();
    for (const entry of catalog) {
      if (!protectedProvider(entry.id) || !entry.enabled || !entry.pluginEnabled) continue;
      owned.add(entry.id);
      await saveOwned(); // write-ahead journal survives a crash between calls
      await bb.sdk.providers.setEnabled({providerId:entry.id,enabled:false});
    }
  }
  async function stopProtected(hostStates: Map<string,VpnState>) {
    for (const running of await bb.sdk.threads.listRunning()) {
      if (running.hostId && hostStates.get(running.hostId)==='connected') continue;
      try {
        const thread = await bb.sdk.threads.get({threadId:running.id});
        if (!protectedProvider(thread.providerId)) continue;
        await bb.sdk.threads.stop({threadId:running.id});
        stopped.add(running.id);
        if (stopped.size>100) stopped=new Set([...stopped].slice(-100));
        await bb.storage.kv.set(STOPPED,[...stopped]);
      } catch (error) { bb.log.warn(`Could not stop protected thread ${running.id}: ${String(error)}`); }
    }
  }
  async function reconcile() {
    const snapshot = await status();
    const states = new Map(snapshot.hosts.map(h=>[h.id,h.vpn] as const));
    if (mode==='enforce') {
      if (snapshot.hosts.length===0 || snapshot.hosts.some(h=>h.vpn!=='connected')) {
        await stopProtected(states);
        await disableProtected();
      } else {
        await releaseOwned();
      }
    } else if (owned.size) {
      await releaseOwned();
    }
    if ([...states].some(([id,state])=>previousStates.get(id)!==state) || previousStates.size!==states.size) {
      previousStates=states;
      await bb.experimental_hooks.recheck('message.dispatch');
    }
  }
  function requestReconcile(): Promise<void> {
    const next=busy.catch(()=>undefined).then(reconcile);
    busy=next;
    return next;
  }
  bb.experimental_hooks.on('message.dispatch',async context=>{
    if (mode!=='enforce' || !protectedProvider(context.requestedExecution.providerId)) return {action:'proceed'};
    const state=await vpn(context.host?.id ?? null);
    return state==='connected' ? {action:'proceed'} : {action:'wait',reason:`VPN Guard: ${state} on target host`};
  });
  bb.rpc.register(rpcContract,{
    status:()=>status(),
    async setMode({mode:next}) {
      await bb.storage.kv.set(MODE,next);
      mode=next;
      await requestReconcile();
      await bb.experimental_hooks.recheck('message.dispatch');
      return status();
    },
  });
  bb.cli.register({
    name:'vpn-guard',summary:'Observe or enforce host-local VPN admission',
    commands:[
      {name:'status',summary:'Show mode, hosts and actions',usage:'bb vpn-guard status [--json]'},
      {name:'enforce',summary:'Opt in to enforcement',usage:'bb vpn-guard enforce'},
      {name:'observe',summary:'Return to observation',usage:'bb vpn-guard observe'},
    ],
    async run(argv) {
      const [command,...args]=argv.filter(a=>a!=='--json');
      if (command==='status' && args.length===0) return {exitCode:0,stdout:JSON.stringify(await status())};
      if ((command==='enforce'||command==='observe') && args.length===0) {
        const next:Mode=command==='enforce'?'enforce':'observe';
        await bb.storage.kv.set(MODE,next); mode=next;
        await requestReconcile();
        await bb.experimental_hooks.recheck('message.dispatch');
        return {exitCode:0,stdout:JSON.stringify(await status())};
      }
      return {exitCode:1,stderr:'Usage: bb vpn-guard status|enforce|observe [--json]'};
    },
  });
  bb.background.service('reconcile',{
    async start(signal) {
      while (!signal.aborted) {
        try { await requestReconcile(); } catch (error) { bb.log.warn(`VPN Guard reconcile failed: ${String(error)}`); }
        await new Promise<void>(resolve=>{
          const timer=setTimeout(resolve,5000);
          signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});
        });
      }
    },
  });
}
