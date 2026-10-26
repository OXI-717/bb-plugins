import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountFederation} from '../lifecycle.mjs';
test('open tabs follow enable/write/disable changes and release all state on abort',async()=>{
 const signal=new AbortController();const timers=new Map();let id=0,config=null,created=0,disposed=0;
 const win={fetch:async()=>{},setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:id=>timers.delete(id)};
 const tick=async()=>{const [id,fn]=timers.entries().next().value;timers.delete(id);await fn()};
 const dispose=await mountFederation({signal:signal.signal,generation:1},win,'test',{
  readConfig:async()=>config,createTransport:()=>({state:{},dispose:()=>disposed++,knownRemoteIds:new Set([++created])})
 });
 assert.equal(created,0);assert.equal(timers.size,1);
 config={enabled:true,allowWrites:false};await tick();assert.equal(created,1);
 await tick();assert.equal(created,1);
 config={enabled:true,allowWrites:true};await tick();assert.equal(created,2);assert.equal(disposed,1);
 config=null;await tick();assert.equal(disposed,2);assert.equal(win.__federationPilot,undefined);
 config={enabled:true,allowWrites:true};await tick();assert.equal(created,3);
 signal.abort();dispose();assert.equal(disposed,3);assert.equal(timers.size,0);assert.equal(win.__federationPilotMount,undefined);
});
test('late config response cannot install after generation abort',async()=>{
 const signal=new AbortController();let resolve,created=0;
 const pending=new Promise(r=>resolve=r);
 const win={fetch:async()=>{},setTimeout:()=>{throw Error('must not schedule')},clearTimeout:()=>{}};
 const mounting=mountFederation({signal:signal.signal},win,'test',{readConfig:()=>pending,createTransport:()=>{created++;}});
 signal.abort();resolve({enabled:true});await mounting;
 assert.equal(created,0);assert.equal(win.__federationPilotMount,undefined);
});
test('same configuration retries after transient transport installation failure',async()=>{
 const signal=new AbortController();let timer,tries=0;
 const win={fetch:async()=>{},setTimeout:fn=>(timer=fn,1),clearTimeout:()=>{}};
 const old=console.warn;console.warn=()=>{};
 try{
  const dispose=await mountFederation({signal:signal.signal},win,'test',{readConfig:async()=>({enabled:true}),createTransport:()=>{if(++tries===1)throw Error('transient');return {state:{},dispose(){}};}});
  await timer();assert.equal(tries,2);assert.ok(win.__federationPilot);dispose();
 }finally{console.warn=old;}
});
test('removing one configured server rebuilds a single transport with the remaining connection',async()=>{
 const signal=new AbortController();let timer,disposed=0,config={enabled:true,servers:[{serverId:'alpha'},{serverId:'beta'}]};const installed=[];
 const win={fetch:async()=>{},setTimeout:fn=>(timer=fn,1),clearTimeout:()=>{}};
 const dispose=await mountFederation({signal:signal.signal},win,'test',{readConfig:async()=>config,createTransport:({config})=>{installed.push(config.servers.map(s=>s.serverId));return {state:{},dispose:()=>disposed++};}});
 config={enabled:true,servers:[{serverId:'beta'}]};await timer();assert.deepEqual(installed,[['alpha','beta'],['beta']]);assert.equal(disposed,1);dispose();assert.equal(disposed,2);
});
