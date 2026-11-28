import {isNativeCatalogProcessStopped} from './native-catalog-process.js';
import {collectNativeQuota} from './native-quota-host.js';
import {nativeProbeCapabilities,runNativeProbe} from './native-probe-host.js';
import {ensureGrokAcpHome} from './grok-acp-home.js';
import {experimental_defineHostEntry} from '@get-bb/plugin-sdk/host';
import {browserHostContract,createMacBrowserHandlers} from './browser-host.js';
const browser=createMacBrowserHandlers();
export default experimental_defineHostEntry({contract:browserHostContract,handlers:{
 nativeProbeCapabilities:async input=>nativeProbeCapabilities(input.executorId),
 nativeProbe:async(input,context)=>runNativeProbe(input,context.signal),
 nativeQuota:async(input,context)=>collectNativeQuota(input,context.signal),
 catalogProcessStatus:async input=>({stopped:await isNativeCatalogProcessStopped(input)}),
 grokHome:async(_input,context)=>({path:await ensureGrokAcpHome(context.experimental_paths.dataDir)}),
 open:async(input,context)=>{context.signal.throwIfAborted();return browser.open(input,context.signal);},
 list:async(input,context)=>{context.signal.throwIfAborted();return browser.list(input);},
}});
