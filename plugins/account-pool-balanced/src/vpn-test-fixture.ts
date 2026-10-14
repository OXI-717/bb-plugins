import type {VpnState} from './vpn-evidence.js';

/** Synthetic complete proof for tests; never a production state-only bypass. */
export function vpnProof(nowMs:number,state:VpnState='connected') {
  if(state==='unknown')return null;
  const ts=Math.floor(nowMs/1000);
  return {schema:'oxi-vpnks/vpn-state/2',updated_unix:ts,state,
    reason:state==='connected'?'ok':'probe_failed',coverage:'ipv4',guard_version:'2.0.0',
    tunnel:{iface:'utun244',core_pid:123},epoch_hash:'synthetic-epoch',traffic_probe_epoch_hash:'synthetic-epoch',
    traffic_probe_ok:state==='connected',traffic_probe_unix:ts,last_probe_attempt:{ts,ok:state==='connected'},
    traffic_probe_max_age:390,file_ttl:90};
}
