import test from 'node:test';
import assert from 'node:assert/strict';
import {assertExclusive} from '../ownership.ts';
import {parseServers,publicServer} from '../configuration.ts';
import {assertSafeSshConfig,SSH_OPTIONS} from '../ssh-policy.ts';
test('ownership rejects local, other-remote and unavailable checks before payload can be forwarded',async()=>{
 let otherCalls=0;
 await assert.rejects(assertExclusive(['thr_private'],async()=>true,[async()=>{otherCalls++;return false}]),/collision on primary/);assert.equal(otherCalls,0);
 await assert.rejects(assertExclusive(['thr_other'],async()=>false,[async()=>true]),/between remotes/);
 await assert.rejects(assertExclusive(['thr_unknown'],async()=>false,[async()=>{throw Error('offline')}]),/offline/);
 await assert.rejects(assertExclusive(['thr_unknown'],async()=>{throw Error('SDK failure')},[]),/SDK failure/);
 await assertExclusive(['thr_remote'],async()=>false,[async()=>false]);
});
test('SSH preflight rejects every implicit tunnel and agent forwarding; hard overrides protect execution',()=>{
 for(const line of ['remoteforward 1 a:2','localforward 1 a:2','dynamicforward 1080','forwardagent yes','forwardagent /agent/path'])assert.throws(()=>assertSafeSshConfig(line));
 assertSafeSshConfig('hostname example.invalid\nforwardagent no\nforwardx11 no');
 assert.ok(SSH_OPTIONS.includes('-a'));assert.ok(SSH_OPTIONS.includes('-x'));assert.ok(SSH_OPTIONS.includes('PermitLocalCommand=no'));
});
test('generic configuration validates distinct servers/projects and exposes no SSH settings',()=>{
 const a={serverId:'alpha',label:'Alpha',projectId:'proj_alpha',bridgeHostId:'host_bridge',sshTarget:'remote-alpha'};
 const b={...a,serverId:'beta',projectId:'proj_beta',sshTarget:'remote-beta'};
 const rows=parseServers(JSON.stringify([a,b]),{});assert.equal(rows.length,2);assert.equal(rows[0].allowWrites,false);assert.deepEqual(Object.keys(publicServer(rows[0])).sort(),['allowWrites','label','projectId','serverId']);
 assert.throws(()=>parseServers(JSON.stringify([a,a]),{}));assert.throws(()=>parseServers(JSON.stringify([{...a,projectId:'proj_personal'}]),{}));assert.throws(()=>parseServers(JSON.stringify([{...a,sshTarget:'-oBad'}]),{}));
 assert.equal(parseServers('',{...a,remotePort:38886}).length,1);
});
