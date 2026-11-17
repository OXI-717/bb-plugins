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
 await restarted.set('thread',null);expect(await store.get('thread')).toBeNull();
 for(let i=0;i<1025;i++)await store.set('thread-'+i,id);
 expect(await store.get('thread-0')).toBeNull();expect(await store.get('thread-1024')).toBe(id);
 for(let i=0;i<150;i++)await store.set('large-'+i+'x'.repeat(2000),id);
 expect(Buffer.byteLength(JSON.stringify(records.get('thread-account-selection-v1')))).toBeLessThanOrEqual(240*1024);
 exists=false;expect(await store.get('thread-1024')).toBeNull();
 expect(records.get('thread-account-selection-v1')).toEqual([]);
});
