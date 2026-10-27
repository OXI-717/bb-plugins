import { expect, it } from 'vitest';
import { createHub } from './hub.js';
import { accountPoolConfigSchema } from './contracts.js';
import type { AccountStore, QuotaStore, PoolAffinityStore } from './store.js';

it('reports NeuralDeep network refusal without hiding it behind account eligibility', async () => {
  const checked: string[] = [];
  const settings = accountPoolConfigSchema.parse({vpnGuardEnabled:true,vpnOnlyProviders:[]});
  const hub = createHub({route:'/pool',accounts:{list:async()=>[]} as unknown as AccountStore,
    affinity:{} as PoolAffinityStore,quotas:{} as QuotaStore,getSettings:()=>settings,
    hubTokens:{list:async()=>[],authenticate:async()=>null},
    guardCheck:async provider=>{checked.push(provider);if(provider==='neuraldeep')throw Error('synthetic network denial');},
    fetchIpv4:async()=>{throw Error('No upstream request permitted');},
    fetch:async()=>{throw Error('No upstream request permitted');},now:()=>1800000000000,
    vpnPayload:async()=>null,
  });
  const status = await hub.status();
  expect(checked).toContain('neuraldeep');
  expect(status.vpn?.blockedProviders).toEqual(['neuraldeep']);
});
