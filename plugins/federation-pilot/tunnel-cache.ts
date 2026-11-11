// A resolved port is not a health check. Serialize reuse checks and replacement.
export type ManagedTunnel={port:number,generation?:string,alive:()=>boolean,close:()=>void,pinned?:()=>boolean};
export function createTunnelCache(deps:{open:(key:string,signal:AbortSignal)=>Promise<ManagedTunnel>,listening:(port:number)=>Promise<boolean>,setTimer?:typeof setTimeout,clearTimer?:typeof clearTimeout}){
 const entries=new Map<string,{abort:AbortController,pending:Promise<ManagedTunnel>,timer:ReturnType<typeof setTimeout>|null,resource?:ManagedTunnel}>();
 const setTimer=deps.setTimer??setTimeout,clearTimer=deps.clearTimer??clearTimeout;let disposed=false;
 function remove(key:string,generation?:string){const entry=entries.get(key);if(!entry||generation!==undefined&&entry.resource?.generation!==generation)return;entries.delete(key);entry.abort.abort();if(entry.timer!==null)clearTimer(entry.timer);entry.resource?.close();}
 async function get(key:string,replacements=1):Promise<ManagedTunnel>{
  if(disposed)throw Error('federation:ssh_unavailable');
  let entry=entries.get(key);
  if(!entry){
   const created={abort:new AbortController(),pending:null as unknown as Promise<ManagedTunnel>,timer:null as ReturnType<typeof setTimeout>|null,resource:undefined as ManagedTunnel|undefined};entry=created;entries.set(key,created);
   created.pending=deps.open(key,created.abort.signal).then(resource=>{created.resource=resource;if(created.abort.signal.aborted){resource.close();throw Error('federation:ssh_unavailable');}return resource;}).catch(()=>{if(entries.get(key)===created)remove(key);throw Error('federation:ssh_unavailable');});
  }
  const resource=await entry.pending;
  if(entry.abort.signal.aborted)throw Error('federation:ssh_unavailable');
  if(!resource.alive()||!await deps.listening(resource.port)){
   if(entries.get(key)===entry)remove(key);
   // Concurrent callers join the single replacement entry.
   if(replacements===0)throw Error('federation:ssh_unavailable');
   return get(key,replacements-1);
  }
  if(entry.abort.signal.aborted)throw Error('federation:ssh_unavailable');
  if(entry.timer!==null)clearTimer(entry.timer);entry.timer=setTimer(()=>{if(entries.get(key)===entry&&!resource.pinned?.())remove(key);},90000);
  return resource;
 }
 return {get,invalidate:remove,reconcile(keys:string[]){for(const key of entries.keys())if(!keys.includes(key))remove(key);},dispose(){disposed=true;for(const key of entries.keys())remove(key);}};
}
