import {retryDelay} from './recovery.ts';
// Only destination changes create work; failed cleanup gets five bounded attempts.
export function createReconciler(call:(hostId:string,keys:string[],signal:AbortSignal)=>Promise<unknown>,clock:{setTimer:typeof setTimeout,clearTimer:typeof clearTimeout}={setTimer:setTimeout,clearTimer:clearTimeout}){
 const entries=new Map<string,{fingerprint:string,abort:AbortController,timer:ReturnType<typeof setTimeout>|null}>();let stopped=false;
 function cancel(entry:typeof entries extends Map<string,infer T>?T:never){entry.abort.abort();if(entry.timer!==null)clock.clearTimer(entry.timer);}
 function update(hostId:string,keys:string[]){
  if(stopped)return;keys=[...new Set(keys)].sort();const fingerprint=JSON.stringify(keys),previous=entries.get(hostId);if(previous?.fingerprint===fingerprint)return;
  if(previous)cancel(previous);const entry={fingerprint,abort:new AbortController(),timer:null as ReturnType<typeof setTimeout>|null};entries.set(hostId,entry);
  async function attempt(n:number){try{await call(hostId,keys,entry.abort.signal);}catch{if(!entry.abort.signal.aborted&&n<4)entry.timer=clock.setTimer(()=>{entry.timer=null;void attempt(n+1);},retryDelay(n));}}
  void attempt(0);
 }
 return {update,dispose(){stopped=true;for(const entry of entries.values())cancel(entry);entries.clear();}};
}
