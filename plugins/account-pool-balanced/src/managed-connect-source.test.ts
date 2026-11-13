import {EventEmitter} from 'node:events';
import {beforeEach,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({calls:[] as any[]}));
vi.mock('node:child_process',()=>({execFile:(...args:any[])=>{
  const stdin=new EventEmitter() as EventEmitter & {end:(v:string)=>void};
  stdin.end=v=>f.calls.push({args,input:JSON.parse(v),finish:args[3]});return {stdin};
}}));
import {createManagedConnectSource} from './managed-connect-source.js';
import type {HttpScopeAcceptance} from './http-scope-acceptance.js';
const a={accountId:'11111111-1111-4111-8111-111111111111',hostId:'host',profile:{id:'route',version:1},profileFingerprint:'a'.repeat(64),receiptDigest:'b'.repeat(64),configDigest:'c'.repeat(64),authGeneration:'one',expectedExit:['192.0.2.1'],checkedAt:1,expiresAt:900} satisfies HttpScopeAcceptance;
beforeEach(()=>{f.calls=[];});
it('production source denies absent/timeout/invalid observations; bounded on-demand command uses stdin',async()=>{
 let now=1;const source=createManagedConnectSource(()=>now);expect(source(a)).toBeUndefined();
 const work=source.prepare!(a),same=source.prepare!(a);expect(same).toBe(work);expect(f.calls).toHaveLength(1);
 const call=f.calls[0];expect(call.args[0]).toBe('/usr/bin/sudo');expect(call.args[1]).toEqual(['-n','/usr/local/libexec/pooler-connect-observe']);expect(call.args[2]).toMatchObject({timeout:8000,maxBuffer:32768});expect(call.input).toEqual(a);
 call.finish(null,'{"state":"connected"}');await work;expect(source(a)).toEqual({state:'connected'});
 expect(source({...a,hostId:'other'})).toBeUndefined();now=10001;expect(source(a)).toBeUndefined();
 const failed=source.prepare!(a);expect(source(a)).toBeUndefined();f.calls[1].finish(Error('timeout'),'');await failed;expect(source(a)).toBeUndefined();
 const invalid=source.prepare!(a);f.calls[2].finish(null,'invalid');await invalid;expect(source(a)).toBeUndefined();
});
