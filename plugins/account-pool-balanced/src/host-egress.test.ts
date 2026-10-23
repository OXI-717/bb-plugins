import {expect,it,vi} from 'vitest';
import {createVpnPolicy} from './vpn-policy.js';
import {accountPoolConfigSchema} from './contracts.js';
import {createGuardNetworkCheck,bindGuardNetworkDecision} from './guard-network.js';
const direct={schema:'bb-vpn-guard/network-decision/2',hostId:'vm',allowed:true,reason:'direct'};
it('only a bound explicit direct grant bypasses local VPN evidence',async()=>{
 const payload=vi.fn(async()=>null);
 const read=async()=>bindGuardNetworkDecision(direct,'vm');
 const config=accountPoolConfigSchema.parse({vpnGuardEnabled:true});
 const p=createVpnPolicy(()=>config,Date.now,payload,createGuardNetworkCheck(read));
 await expect(p.assert('codex')).resolves.toBeUndefined();expect(payload).not.toHaveBeenCalled();
 for(const reason of ['outside_scope','observe','connected']){
  const q=createVpnPolicy(()=>config,Date.now,payload,createGuardNetworkCheck(async()=>bindGuardNetworkDecision({...direct,reason},'vm')));
  await expect(q.assert('codex')).rejects.toThrow('VPN_REQUIRED');
 }
});
it('mismatched host/legacy direct/manual block fail closed without fallback',async()=>{
 expect(()=>bindGuardNetworkDecision(direct,'mac')).toThrow();
 expect(()=>bindGuardNetworkDecision({...direct,schema:'bb-vpn-guard/network-decision/1'},'vm')).toThrow();
 const check=createGuardNetworkCheck(async()=>bindGuardNetworkDecision({...direct,allowed:false,reason:'manual_block'},'vm'));
 await expect(check('cursor')).rejects.toThrow('VPN_GUARD_BLOCKED');
});
it('a revoked direct grant is checked again for every upstream operation',async()=>{
 let allowed=true;
 const check=createGuardNetworkCheck(async()=>bindGuardNetworkDecision({...direct,allowed,reason:allowed?'direct':'vpn_unavailable'},'vm'));
 const config=accountPoolConfigSchema.parse({vpnGuardEnabled:true});
 const p=createVpnPolicy(()=>config,Date.now,async()=>null,check);
 await p.assert('codex');allowed=false;await expect(p.assert('codex')).rejects.toThrow();
});
