import {expect,it} from 'vitest';
import {ThreadAccountSelection} from './thread-account-selection.js';
it('persists manual choices, bounds oldest records and removes deleted accounts',async()=>{
 const records=new Map<string,unknown>();let exists=true;
 const kv={get:async(k:string)=>records.get(k),set:async(k:string,v:unknown)=>{records.set(k,structuredClone(v));},delete:async(k:string)=>{records.delete(k);},list:async()=>[...records.keys()]};
 const id='11111111-1111-4111-8111-111111111111';
 const store=new ThreadAccountSelection(kv,async()=>exists);
 await store.set('thread',id);
 const restarted=new ThreadAccountSelection(kv,async()=>exists);
 expect(await restarted.get('thread')).toBe(id);
 // One instance owns the record in a running pool; a new instance reads what it stored.
 await restarted.set('thread',null);expect(await restarted.get('thread')).toBeNull();
 expect(await new ThreadAccountSelection(kv,async()=>exists).get('thread')).toBeNull();
 for(let i=0;i<1025;i++)await restarted.set('thread-'+i,id);
 expect(await restarted.get('thread-0')).toBeNull();expect(await restarted.get('thread-1024')).toBe(id);
 for(let i=0;i<150;i++)await restarted.set('large-'+i+'x'.repeat(2000),id);
 expect(Buffer.byteLength(JSON.stringify(records.get('thread-account-selection-v1')))).toBeLessThanOrEqual(240*1024);
 // Removed accounts are dropped on the next change and at start-up, not per request.
 exists=false;const afterRemoval=new ThreadAccountSelection(kv,async()=>exists);
 expect(await afterRemoval.get('thread-1024')).toBeNull();
 expect(records.get('thread-account-selection-v1')).toEqual([]);
});
it('serves requests from memory and treats malformed or unavailable storage as no manual choice',async()=>{
 const id='11111111-1111-4111-8111-111111111111';let reads=0,fail=false;let stored:unknown=[{key:'thread',accountId:id}];
 const kv={get:async()=>{reads++;if(fail)throw Error('storage unavailable');return stored;},set:async(_k:string,v:unknown)=>{stored=structuredClone(v);},delete:async()=>{},list:async()=>[]};
 let lookups=0;const store=new ThreadAccountSelection(kv,async()=>{lookups++;return true;});
 for(let i=0;i<50;i++)expect(await store.get('thread')).toBe(id);
 expect(reads).toBe(1);expect(lookups).toBe(1);
 stored={unexpected:true};expect(await new ThreadAccountSelection(kv,async()=>true).get('thread')).toBeNull();
 fail=true;const unavailable=new ThreadAccountSelection(kv,async()=>true);
 expect(await unavailable.get('thread')).toBeNull();
 fail=false;stored=[{key:'thread',accountId:id}];expect(await unavailable.get('thread')).toBe(id);
});
