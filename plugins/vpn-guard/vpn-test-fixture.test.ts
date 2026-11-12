import {expect,it,vi} from 'vitest';
import {verifiedHostResult} from './vpn-test-fixture.js';

it('uses one observation time when the clock advances between calls',()=>{
 let at=1_000_000;
 const clock=vi.spyOn(Date,'now').mockImplementation(()=>at++);
 try{
  const result=verifiedHostResult('connected');
  expect(result.evidence.updatedAt).toBe(result.evidence.probeAt);
  expect(clock).toHaveBeenCalledTimes(1);
 }finally{clock.mockRestore();}
});
