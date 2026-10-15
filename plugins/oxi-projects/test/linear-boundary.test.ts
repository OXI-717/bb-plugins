import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startServer} from './fake-bb.ts';

test('does not expose migration from another plugin private storage',async()=>{
 const {rpc,dispose}=await startServer({catalog:[]});
 try{
  // Invalid input prevents executing an old migration while still checking
  // whether the removed RPC is registered at the actual plugin entrypoint.
  await assert.rejects(rpc.call('importLinearConnection',{}),/has no rpc method "importLinearConnection"/i);
 }finally{await dispose();}
});
