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
 return {async read<T>(load:()=>Promise<T>,timeoutMs=10000):Promise<T|null>{
  if(waiting)return null;
  if(active>=4)throw Error('Status requests unavailable');
  waiting=true;active++;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let reading:Promise<T>;
  try{reading=Promise.resolve(load());}catch(error){active--;waiting=false;throw error;}
  void reading.finally(()=>{active--;}).catch(()=>undefined);
  try{return await Promise.race([reading,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Status request timed out')),timeoutMs);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);waiting=false;}
 }};
}
