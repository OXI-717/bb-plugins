import {z} from 'zod';
import type {PoolKvStorage} from './core-storage.js';
const schema=z.array(z.object({key:z.string().max(2048),accountId:z.string().uuid()}).strict()).max(1024);
const KEY='thread-account-selection-v1';
const MAX_ROWS=1024, MAX_BYTES=240*1024;
/**
 * Manual thread account choices: bounded, persisted separately from the
 * rollback-compatible egress state. Requests read memory only; storage is touched once
 * at first use and on an explicit change.
 */
export class ThreadAccountSelection {
 private rows:Map<string,string>|null=null;
 private loading:Promise<void>|null=null;
 private pending:Promise<unknown>=Promise.resolve();
 constructor(private kv:PoolKvStorage,private accountExists:(id:string)=>Promise<boolean>){}
 /** Choices of removed accounts are dropped here and on every change, never per request. */
 private async prune(rows:Map<string,string>):Promise<boolean>{
  let changed=false;const known=new Map<string,boolean>();
  for(const [key,accountId] of rows){
   if(!known.has(accountId))known.set(accountId,await this.accountExists(accountId));
   if(!known.get(accountId)){rows.delete(key);changed=true;}
  }
  return changed;
 }
 private async persist(rows:Map<string,string>):Promise<void>{
  const list=[...rows].map(([key,accountId])=>({key,accountId})).slice(-MAX_ROWS);
  while(Buffer.byteLength(JSON.stringify(list))>MAX_BYTES)list.shift();
  await this.kv.set(KEY,schema.parse(list));
  rows.clear();for(const row of list)rows.set(row.key,row.accountId);
 }
 private load():Promise<void>{
  this.loading??=(async()=>{
   // A malformed record means "no manual choices", never a failed model request.
   const parsed=schema.safeParse(await this.kv.get(KEY)??[]);
   const rows=new Map((parsed.success?parsed.data:[]).map(row=>[row.key,row.accountId] as const));
   if(await this.prune(rows))await this.persist(rows);
   this.rows=rows;
  })().catch(error=>{this.loading=null;throw error;});
  return this.loading;
 }
 /** Unavailable storage degrades to the default (no manual choice) and is retried later. */
 async get(key:string):Promise<string|null>{
  if(this.rows===null){try{await this.load();}catch{return null;}}
  return this.rows?.get(key)??null;
 }
 set(key:string,accountId:string|null):Promise<void>{
  const result=this.pending.then(async()=>{
   await this.load();
   const rows=new Map(this.rows!);
   rows.delete(key);if(accountId!==null)rows.set(key,accountId);
   await this.prune(rows);await this.persist(rows);
   this.rows=rows;
  });this.pending=result.catch(()=>undefined);return result;
 }
}
