import {describe,expect,it} from 'vitest';
import {actsOnRunningWork,OBSERVATION_GRACE_MS,observationTracker} from './observation.js';

const connected={kind:'evidence',state:'connected',reason:undefined} as const;
const disconnected={kind:'evidence',state:'disconnected',reason:'probe_failed'} as const;
const failed={kind:'unobservable',reason:'host_rpc_failed'} as const;

describe('observation grace tracker',()=>{
  it('keeps the latest evidence through unobservability shorter than the grace period',()=>{
    const t=observationTracker();
    t.record('h','vpn-required',connected,0,1);
    t.record('h','vpn-required',failed,5_000,15_000);
    expect(t.verdict('h',5_000+OBSERVATION_GRACE_MS)).toEqual({kind:'connected'});
    expect(t.verdict('h',5_001+OBSERVATION_GRACE_MS)).toEqual({kind:'expired',reason:'host_rpc_failed'});
    expect(t.view('h')).toEqual({lastEvidenceAt:1,unobservedSince:5_000});
  });
  it('keeps explicit not-connected evidence effective during the grace period',()=>{
    const t=observationTracker();
    t.record('h','vpn-required',disconnected,0,0);
    t.record('h','vpn-required',failed,1_000,1_000);
    expect(t.verdict('h',2_000)).toEqual({kind:'blocked',state:'disconnected',reason:'probe_failed'});
    expect(actsOnRunningWork(t.verdict('h',2_000))).toBe(true);
  });
  it('counts from the first failed read when no evidence exists and resets on one success',()=>{
    const t=observationTracker();
    t.record('h','vpn-required',failed,0,0);
    t.record('h','vpn-required',{kind:'unobservable',reason:'host_catalog_unavailable'},60_000,60_000);
    expect(t.verdict('h',OBSERVATION_GRACE_MS)).toEqual({kind:'pending'});
    expect(actsOnRunningWork(t.verdict('h',OBSERVATION_GRACE_MS))).toBe(false);
    expect(t.verdict('h',OBSERVATION_GRACE_MS+1)).toEqual({kind:'expired',reason:'host_catalog_unavailable'});
    t.record('h','vpn-required',connected,95_000,95_000);
    t.record('h','vpn-required',failed,100_000,100_000);
    expect(t.verdict('h',100_000+OBSERVATION_GRACE_MS)).toEqual({kind:'connected'});
  });
  it('ignores an older read that completes after a newer one',()=>{
    const t=observationTracker();
    t.record('h','vpn-required',connected,10_000,10_000);
    t.record('h','vpn-required',failed,0,20_000);
    expect(t.view('h')).toEqual({lastEvidenceAt:10_000,unobservedSince:null});
    t.record('h','vpn-required',failed,30_000,30_000);
    t.record('h','vpn-required',connected,25_000,40_000);
    expect(t.view('h').unobservedSince).toBe(30_000);
  });
  it('forgets history when the network mode changes or the machine leaves scope',()=>{
    const t=observationTracker();
    t.record('h','vpn-required',connected,0,0);
    t.record('h','direct',failed,1_000,1_000);
    expect(t.verdict('h',1_000)).toEqual({kind:'pending'});
    t.retain([]);
    expect(t.view('h')).toEqual({lastEvidenceAt:null,unobservedSince:null});
  });
});
