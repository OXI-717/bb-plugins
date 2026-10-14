import type {VpnState} from './vpn-evidence.js';

export function vpnProof(nowMs:number) {
  const ts=Math.floor(nowMs/1000);
  return {schema:'oxi-vpnks/vpn-state/2',updated_unix:ts,state:'connected',reason:'ok',coverage:'ipv4',
    guard_version:'2.0.0',tunnel:{iface:'utun244',core_pid:123},epoch_hash:'synthetic-epoch',
    traffic_probe_epoch_hash:'synthetic-epoch',traffic_probe_ok:true,traffic_probe_unix:ts,
    last_probe_attempt:{ts,ok:true},traffic_probe_max_age:390,file_ttl:90};
}

/** Match the host RPC evidence contract rather than inventing a state-only allow. */
export function verifiedHostResult(state:VpnState) {
  return {state,evidence:{state,assurance:state==='connected'?'verified_ipv4' as const:'unverified' as const,
    reason:state==='connected'?'ok':'probe_failed',updatedAt:Date.now(),probeAt:Date.now()}};
}
