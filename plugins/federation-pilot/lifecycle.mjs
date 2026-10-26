import { createFederation, loadConfig } from './federation-core.mjs';

// Server reloads with an unchanged app hash do not remount content scripts.
// Watch public configuration so enable/disable and write mode apply to open tabs.
export async function mountFederation(context, win, pluginId, deps = {}) {
  if (win.__federationPilotMount) return undefined;
  const readConfig = deps.readConfig ?? loadConfig;
  const createTransport = deps.createTransport ?? createFederation;
  const configWindow = { fetch: win.fetch.bind(win) };
  let stopped = false, timer = null, current = null, fingerprint = null;
  const owner = { dispose, generation: context.generation };
  win.__federationPilotMount = owner;
  function clearTransport() {
    const previous = current;
    current = null;
    previous?.dispose();
    if (win.__federationPilot?.state === previous?.state) delete win.__federationPilot;
  }
  function dispose() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) win.clearTimeout(timer);
    context.signal.removeEventListener('abort', dispose);
    clearTransport();
    if (win.__federationPilotMount === owner) delete win.__federationPilotMount;
  }
  async function refresh() {
    try {
      const config = await readConfig({win: configWindow, pluginId, signal: context.signal});
      if (stopped || context.signal.aborted) return;
      const next = JSON.stringify(config);
      if (fingerprint === next) return;
      clearTransport();
      if (!config) {fingerprint=next;return;}
      const diagnostics = [];
      const setRowStatus = typeof context.experimental_setThreadRowStatus === 'function'
        ? (id, status) => context.experimental_setThreadRowStatus(id, status) : null;
      current = createTransport({win, config, pluginId, setRowStatus, log: (kind,data) => {
        diagnostics.push({t:Date.now(),kind,...data});
        if(diagnostics.length>500)diagnostics.splice(0,diagnostics.length-500);
      }});
      fingerprint=next;
      win.__federationPilot = {state:current.state,diagnostics,knownRemoteIds:current.knownRemoteIds,conflicts:current.conflicts,generation:context.generation};
    } catch (e) {
      if (!stopped) console.warn('[federation-pilot] config refresh failed:', String(e));
    } finally {
      if (!stopped && !context.signal.aborted) timer = win.setTimeout(refresh,5000);
    }
  }
  context.signal.addEventListener('abort',dispose,{once:true});
  if(context.signal.aborted){dispose();return dispose;}
  await refresh();
  return dispose;
}
