import {expect,it,vi} from 'vitest';
import {NativeQuota} from './native-quota.js';
import {registerUsageSource} from './usage-source.js';
import {usageFetchMethod,usageListMethod} from './usage-contract.js';
import type {AccountPoolHub} from './hub.js';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';

const time=1_800_000_000_000;
const primary={accountId:'google-primary',executorId:'agy-primary',hostId:'host-one'};
const reserve={...primary,accountId:'google-reserve',executorId:'agy-reserve'};
const report={...primary,schema:'oxi/native-account-quota/1',observedAt:time,rows:[
  {group:'Gemini Pro',window:'fiveHour',remainingPercent:0,resetAt:time+1000},
  {group:'Gemini Pro',window:'weekly',remainingPercent:80,resetAt:time+86_400_000},
]};

it('publishes one managed resource per enrolled account, with real zero and independent resets',async()=>{
  let now=time;
  let targets=[primary,reserve];
  const collect=vi.fn(async () => report);
  const quotas=new NativeQuota(async()=>targets,collect,()=>now);
  const host=createFakePluginHost({pluginId:'account-pool'});
  const hub={status:async()=>({accounts:[]})} as unknown as AccountPoolHub;
  registerUsageSource(host.bb,hub,false,quotas);
  const {callRpc}=host.harness.behavior;
  const listing=await callRpc(usageListMethod,null);
  expect(listing).toMatchObject({resources:[
    {id:'managed-agy:google-primary',accountKey:null,providerId:'acp-agy'},
    {id:'managed-agy:google-reserve',accountKey:null,providerId:'acp-agy'},
  ]});
  expect(collect).not.toHaveBeenCalled();
  const resourceId='managed-agy:google-primary';
  const read=()=>callRpc(usageFetchMethod,{resourceId,refresh:false});
  expect(await read()).toMatchObject({observedAt:time,usage:{status:'ok',windows:[
    {kind:'five-hour',usedPercent:100,resetsAt:new Date(time+1000).toISOString()},
    {kind:'weekly',usedPercent:20,resetsAt:new Date(time+86_400_000).toISOString()},
  ]}});
  expect(collect).toHaveBeenCalledExactlyOnceWith(primary);
  now+=1000;
  expect(await read()).toMatchObject({usage:{windows:[{kind:'weekly'}]}});
  now+=5*60_000;
  expect(await read()).toMatchObject({observedAt:null,usage:{status:'error'}});
  targets=[reserve];
  await expect(read()).rejects.toThrow('no longer exists');
});

it('does not attach foreign host, executor or account evidence to a row',async()=>{
  for(const bad of [{...report,hostId:'other'},{...report,executorId:'other'},{...report,accountId:'other'}]){
    const quota=new NativeQuota(async()=>[primary],async()=>bad,()=>time);
    await quota.refreshAccount([primary]);
    expect(quota.readAccount([primary])).toBeNull();
  }
});

it('deduplicates requests and discards an in-flight result after the account is disabled',async()=>{
  let finish!:(value:typeof report)=>void;
  let targets=[primary,reserve];
  const collect=vi.fn(async()=>new Promise<typeof report>(resolve=>{finish=resolve;}));
  const quota=new NativeQuota(async()=>targets,collect,()=>time);
  const first=quota.refreshAccount([primary]);
  const concurrent=quota.refreshAccount([primary],true);
  await quota.refreshAccount([reserve]);
  expect(collect).toHaveBeenCalledExactlyOnceWith(primary);
  targets=[reserve];
  finish(report);
  await Promise.all([first,concurrent]);
  expect(quota.readAccount([primary])).toBeNull();
});

it('uses another enrolled executor for the same subscription if the first host lacks a collector',async()=>{
  const mac={...primary,hostId:'host-mac',executorId:'agy-mac'};
  const collect=vi.fn(async (target:typeof primary)=>{
    if(target.hostId===mac.hostId)throw Error('unsupported runtime');
    return report;
  });
  const quota=new NativeQuota(async()=>[mac,primary,reserve],collect,()=>time);
  await quota.refreshAccount([mac,primary]);
  expect(collect.mock.calls).toEqual([[mac],[primary]]);
  expect(quota.readAccount([mac,primary])?.rows).toEqual(report.rows);
  expect(quota.readAccount([reserve])).toBeNull();
});
