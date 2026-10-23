import {experimental_defineHostEntry} from '@get-bb/plugin-sdk/host';
import {browserHostContract,createMacBrowserHandlers} from './browser-host.js';
const browser=createMacBrowserHandlers();
export default experimental_defineHostEntry({contract:browserHostContract,handlers:{
 open:async(input,context)=>{context.signal.throwIfAborted();return browser.open(input,context.signal);},
 list:async(input,context)=>{context.signal.throwIfAborted();return browser.list(input);},
}});
