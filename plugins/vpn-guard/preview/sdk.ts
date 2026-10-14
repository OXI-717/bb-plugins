import {guardFixture} from '../ui-fixture.js';

const params=new URLSearchParams(location.search);
const status=guardFixture();
const scenario=params.get('scenario');
if(scenario==='unknown'){
  status.hosts[0]!.vpn='unknown';status.hosts[0]!.available=false;
  status.hosts[0]!.evidence={state:'unknown',assurance:'invalid',reason:'probe_stale',updatedAt:null,probeAt:null};
}
if(scenario==='recovery'||scenario==='unknown'){
  status.ownedDisabledPlugins=['provider-codex'];
  status.suspendNativePluginsGlobally=true;
}
if(params.has('long'))status.hosts[0]!.name='Demo machine with a deliberately long name for layout verification';
const rpc={async call(method:string,input?:any){
  if(scenario==='error'&&method==='status')throw new Error('Synthetic host unavailable');
  switch(method){
    case 'status':break;
    case 'setMode':status.mode=input.mode;break;
    case 'setManualBlock':status.manualBlock=input.blocked;break;
    case 'setGlobalSuspension':status.suspendNativePluginsGlobally=input.enabled;break;
    case 'restoreOwned':if(status.manualBlock||status.hosts.some(host=>host.selected&&host.vpn!=='connected'))throw new Error('Selected machines must be connected before restoring native plugins.');status.ownedDisabledPlugins=[];break;
    case 'setHosts':status.hostIds=input.hostIds;status.hosts.forEach(host=>host.selected=status.hostIds.includes(host.id));break;
    default:throw new Error('Preview does not implement this action.');
  }
  return structuredClone(status);
}};
export function useRpc<T>(){return rpc;}
export function definePluginApp(factory:unknown){return factory;}
