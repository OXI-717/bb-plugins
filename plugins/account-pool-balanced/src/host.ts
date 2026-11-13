import {nativeProbeCapabilities,runNativeProbe} from './native-probe-host.js';
import {experimental_defineHostEntry} from '@get-bb/plugin-sdk/host';
import {browserHostContract,createMacBrowserHandlers} from './browser-host.js';
const browser=createMacBrowserHandlers();
export default experimental_defineHostEntry({contract:browserHostContract,handlers:{
 nativeProbeCapabilities:async input=>nativeProbeCapabilities(input.executorId),
 nativeProbe:async(input,context)=>runNativeProbe(input,context.signal),
 open:async(input,context)=>{context.signal.throwIfAborted();return browser.open(input,context.signal);},
 list:async(input,context)=>{context.signal.throwIfAborted();return browser.list(input);},
}});
