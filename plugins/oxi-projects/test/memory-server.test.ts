import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {setupMemory} from '../memory-server.ts';
test('memory bridge only forwards validated inspect/save RPC to memory owner',async()=>{
 const calls:any[]=[];
 const {bb,harness}=createFakePluginHost({sdk:{plugins:{callRpc:async args=>{calls.push(args);return {ok:true,reason:'saved'};}}}});
 setupMemory(bb);
 const input={projectId:'projectAlpha',binding:{mode:'project',code:'PROJECT_ALPHA'},mappingRevision:'one',catalogRevision:'two'};
 assert.deepEqual(await harness.behavior.callRpc('memorySave',input),{ok:true,reason:'saved'});
 assert.equal(calls[0].pluginId,'oxi-memory');assert.equal(calls[0].method,'memorySave');assert.deepEqual(calls[0].input,input);
 await assert.rejects(harness.behavior.callRpc('memorySave',{...input,binding:{mode:'project',code:'invalid'}}));
 assert.equal(calls.length,1);await harness.lifecycle.dispose();
});
