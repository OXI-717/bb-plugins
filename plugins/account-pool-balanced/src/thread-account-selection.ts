import {z} from 'zod';
import type {PoolKvStorage} from './core-storage.js';
const schema=z.array(z.object({key:z.string().max(2048),accountId:z.string().uuid()}).strict()).max(1024);
const KEY='thread-account-selection-v1';
/** Serialized bounded preferences, separate from rollback-compatible egress state. */
export class ThreadAccountSelection {
 private pending:Promise<unknown>=Promise.resolve();
 constructor(private kv:PoolKvStorage,private accountExists:(id:string)=>Promise<boolean>){}
 private async read(){
  const rows=schema.parse(await this.kv.get(KEY)??[]);
  const known=new Set<string>();
  for(const id of new Set(rows.map(row=>row.accountId)))if(await this.accountExists(id))known.add(id);
  const kept=rows.filter(row=>known.has(row.accountId));
  if(kept.length!==rows.length)await this.kv.set(KEY,kept);
  return kept;
 }
 get(key:string):Promise<string|null>{
  const result=this.pending.then(async()=> (await this.read()).find(row=>row.key===key)?.accountId??null);
  this.pending=result.catch(()=>undefined);return result;
 }
 set(key:string,accountId:string|null):Promise<void>{
  const result=this.pending.then(async()=>{
   const rows=(await this.read()).filter(row=>row.key!==key);
   if(accountId!==null)rows.push({key,accountId});
   const bounded=rows.slice(-1024);
   while(Buffer.byteLength(JSON.stringify(bounded))>240*1024)bounded.shift();
   await this.kv.set(KEY,schema.parse(bounded));
  });this.pending=result.catch(()=>undefined);return result;
 }
}
