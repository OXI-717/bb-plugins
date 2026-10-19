import {z} from 'zod';
type Options={load:()=>Promise<unknown>;save:(value:unknown)=>Promise<void>;allowed:(hostId:string)=>Promise<boolean>;resume:(threadId:string,at:number)=>Promise<void>;claimed:(threadId:string,at:number)=>boolean;now:()=>number;warn:()=>void};
const recordSchema=z.object({threadId:z.string().min(1).max(160),hostId:z.string().min(1).max(160),at:z.number().int().nonnegative(),attempts:z.number().int().min(0).max(3),nextAt:z.number().int().nonnegative(),state:z.enum(['pending','done','uncertain','exhausted'])});
export async function automaticStopRecovery(options:Options){
 const loaded=z.array(recordSchema).max(100).safeParse((await options.load())??[]);
 let records=loaded.success?loaded.data:null;
 if(!records)options.warn();
 let tail:Promise<void>=Promise.resolve();let closed=false;const flights=new Set<string>();let workers=0;
 const mutate=<T>(operation:()=>Promise<T>)=>{const next=tail.then(operation);tail=next.then(()=>undefined,()=>undefined);return next;};
 async function patch(threadId:string,at:number,change:Partial<z.infer<typeof recordSchema>>){
  return mutate(async()=>{
   if(closed||!records)return false;
   const next=records.map(record=>record.threadId===threadId&&record.at===at?{...record,...change}:record);
   await options.save(next);records=next;return true;
  });
 }
 return {
  close(){closed=true;},
  snapshot(){return records??[];},
  async remember(threadId:string,at:number,hostId:string){
   const record=recordSchema.parse({threadId,hostId,at,attempts:0,nextAt:options.now(),state:'pending'});
   await mutate(async()=>{
    if(closed||!records||records.some(value=>value.threadId===threadId&&value.at===at))return;
    const next=[...records,record].slice(-100);await options.save(next);records=next;
   });
  },
  async run(){
   if(closed||!records)return;
   const snapshot=[...records];let index=0;
   const jobs:Promise<void>[]=[];
   while(workers<4&&index<snapshot.length){
    workers++;
    jobs.push((async()=>{
     while(!closed&&index<snapshot.length){
      const item=snapshot[index++]!;
      const record=records?.find(value=>value.threadId===item.threadId&&value.at===item.at);
      if(!record||record.state!=='pending'||record.nextAt>options.now()||flights.has(record.threadId))continue;
      flights.add(record.threadId);
      try{
       const latest=records!.filter(value=>value.threadId===record.threadId).at(-1);
       if(latest?.at!==record.at){await patch(record.threadId,record.at,{state:'done'});continue;}
       if(options.claimed(record.threadId,record.at)){await patch(record.threadId,record.at,{state:'uncertain'});continue;}
       if(!await options.allowed(record.hostId)||closed)continue;
       const attempts=record.attempts+1;
       if(attempts>3){await patch(record.threadId,record.at,{state:'exhausted'});continue;}
       if(!await patch(record.threadId,record.at,{attempts,nextAt:options.now()+[30_000,120_000,300_000][attempts-1]!})||closed)continue;
       try{await options.resume(record.threadId,record.at);await patch(record.threadId,record.at,{state:'done'});}
       catch{
        const uncertain=options.claimed(record.threadId,record.at);
        await patch(record.threadId,record.at,{state:uncertain?'uncertain':attempts===3?'exhausted':'pending'});
        if(uncertain||attempts===3)options.warn();
       }
      }catch{if(!closed)options.warn();}
      finally{flights.delete(record.threadId);}
     }
    })().finally(()=>{workers--;}));
   }
   await Promise.all(jobs);
  },
 };
}
