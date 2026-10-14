import {expect,it} from 'vitest';
import {evaluateVpnEvidence} from './vpn-evidence.js';

const now=1_800_000_000_000;
export const proof=()=>({schema:'oxi-vpnks/vpn-state/2',updated_unix:now/1000,state:'connected',reason:'ok',coverage:'ipv4',guard_version:'2.0.0',tunnel:{iface:'utun244',core_pid:123},epoch_hash:'epoch-one',traffic_probe_epoch_hash:'epoch-one',traffic_probe_ok:true,traffic_probe_unix:now/1000,last_probe_attempt:{ts:now/1000,ok:true},traffic_probe_max_age:390,file_ttl:90});
it('rejects retired evidence without an optional verification switch',()=>{
 expect(evaluateVpnEvidence({schema:'oxi-vpnks/vpn-state/1',state:'connected',updated_unix:now/1000},now).state).toBe('unknown');
});
it('verifies only coherent fresh IPv4 evidence',()=>{
 expect(evaluateVpnEvidence(proof(),now)).toMatchObject({state:'connected',assurance:'verified_ipv4',reason:'ok'});
 for(const sample of [
  {...proof(),updated_unix:now/1000+1}, {...proof(),updated_unix:now/1000-91},
  {...proof(),traffic_probe_unix:now/1000+1}, {...proof(),traffic_probe_unix:now/1000-391},
  {...proof(),traffic_probe_epoch_hash:'old'}, {...proof(),traffic_probe_ok:false},
  {...proof(),reason:'healing'}, {...proof(),coverage:'ipv6'},
  {...proof(),tunnel:{iface:'en0',core_pid:123}}, {...proof(),tunnel:{iface:'utun244',core_pid:0}},
  {...proof(),file_ttl:999999}, {...proof(),traffic_probe_max_age:999999},
  {...proof(),last_probe_attempt:{ts:now/1000+1,ok:true}},
 ]) expect(evaluateVpnEvidence(sample,now).state).not.toBe('connected');
});
it('recognizes a valid explicit denial without requiring successful proof',()=>{
 expect(evaluateVpnEvidence({...proof(),state:'disconnected',reason:'probe_failed',traffic_probe_ok:false,traffic_probe_unix:null,traffic_probe_epoch_hash:'-'},now).state).toBe('disconnected');
});
