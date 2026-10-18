/** Only the newest status request may update the panel; mutations invalidate reads. */
export function createStatusRequests() {
  let sequence=0;
  return {
    start:()=>++sequence,
    isCurrent:(request:number)=>request===sequence,
    invalidate:()=>{sequence++;},
  };
}

/** Coalesce poll ticks; keep a separate bound on timed-out underlying calls. */
export function createStatusReads() {
 let waiting=false;let active=0;
 let waitingDone=Promise.resolve();
 async function read<T>(load:()=>Promise<T>,timeoutMs=10000,fresh=false):Promise<T|null>{
  if(waiting){if(!fresh)return null;await waitingDone;return read(load,timeoutMs,true);}
  if(active>=4)throw Error('Status requests unavailable');
  waiting=true;active++;
  let release!:()=>void;waitingDone=new Promise<void>(resolve=>{release=resolve;});
  let timer:ReturnType<typeof setTimeout>|undefined;
  let reading:Promise<T>;
  try{reading=Promise.resolve(load());}catch(error){active--;waiting=false;release();throw error;}
  void reading.finally(()=>{active--;}).catch(()=>undefined);
  try{return await Promise.race([reading,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Status request timed out')),timeoutMs);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);waiting=false;release();}
 }
 return {read,readFresh:<T>(load:()=>Promise<T>,timeoutMs=10000)=>read(load,timeoutMs,true)};
}
