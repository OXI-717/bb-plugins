import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedFrame} from '../realtime-frame.ts';
test('oversized timeline requests native refetch without dropping completion',()=>{
 const target={kind:'thread-timeline',threadId:'thr_alpha',segmentLimit:null,deferContent:true};
 const small=JSON.stringify({type:'thread-timeline',target,timeline:{tag:'small',rows:[]}});
 assert.equal(boundedFrame(small),small);
 const large=JSON.stringify({type:'thread-timeline',target:{...target,extra:'x'.repeat(70000)},timeline:{tag:'large',rows:['x'.repeat(70000)]}});
 const result=boundedFrame(large);assert.ok(result.length<65536);assert.deepEqual(JSON.parse(result),{type:'thread-timeline',target,timeline:null});
 for(const value of ['x'.repeat(70000),JSON.stringify({type:'other',target,text:'x'.repeat(70000)}),JSON.stringify({type:'thread-timeline',target:{...target,threadId:'invalid'},text:'x'.repeat(70000)})])assert.equal(boundedFrame(value),null);
});
