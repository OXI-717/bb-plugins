import {afterEach,expect,it,vi} from 'vitest';
import {readRemoteEvidence} from './remote-evidence.js';
import {verifiedHostResult} from './vpn-test-fixture.js';

afterEach(()=>vi.useRealTimers());
it('allows a fresh remote response beyond the former worker deadline',async()=>{
  vi.useFakeTimers();
  const read=readRemoteEvidence(timeoutMs=>new Promise((resolve,reject)=>{
    const deadline=setTimeout(()=>reject(Error('exceeded its deadline')),timeoutMs);
    setTimeout(()=>{clearTimeout(deadline);resolve(verifiedHostResult('connected'));},2000);
  }),()=>{throw Error('unexpected failure');});
  await vi.advanceTimersByTimeAsync(2000);
  expect(await read).toMatchObject({state:'connected',evidence:{assurance:'verified_ipv4'},rpc:{category:'ok'}});
});
it.each([
  [Object.assign(Error('private-payload'),{code:'command_timeout'}),'timeout'],
  [Object.assign(Error('private-payload'),{body:{code:'host_unavailable'}}),'host_unavailable'],
  [Object.assign(Error('private-payload'),{name:'AbortError'}),'cancelled'],
])('records only a safe RPC category and elapsed duration for failure %#',async(error,category)=>{
  const reports:unknown[]=[];
  const result=await readRemoteEvidence(async()=>{throw error;},value=>reports.push(value));
  expect(result).toEqual({state:'unknown',rpc:{category,elapsedMs:expect.any(Number)}});
  expect(reports).toEqual([result.rpc]);
  expect(JSON.stringify(result)).not.toContain('private-payload');
});
