/** Read only interruption/turn boundaries; never fetch message history. */
export type StopBoundary = {type:string;data:unknown};
export type StopMarkThread = {id:string;updatedAt:number;status:string;runtimeStatus:string;isHidden?:boolean};
export function isStoppedBoundary(events:readonly StopBoundary[]):boolean {
 const last=events[0];
 return last?.type==='system/thread/interrupted'&&last.data!==null&&typeof last.data==='object'&&'reason' in last.data&&last.data.reason==='manual-stop';
}
type Entry={key:string;stopped:boolean;unknown:boolean;attempts:number;readable:boolean;controller:AbortController|null};

/** Bounded, per-client cache. A restart clears the mark before any async read. */
export function createThreadStopMarks(read:(id:string,signal:AbortSignal)=>Promise<readonly StopBoundary[]>,changed:(ids:ReadonlySet<string>)=>void){
 const entries=new Map<string,Entry>();const pending=new Set<string>();let running=0,disposed=false,lastPublished:string|null=null;
 function publish(){const ids=[...entries].filter(([,entry])=>entry.stopped).map(([id])=>id).sort();const key=JSON.stringify(ids);if(key!==lastPublished){lastPublished=key;changed(new Set(ids));}}
 function drain(){
  while(!disposed&&running<4&&pending.size){
   const id=pending.values().next().value!;pending.delete(id);
   const entry=entries.get(id);if(!entry||!entry.readable||entry.controller)continue;
   const controller=new AbortController();entry.controller=controller;entry.attempts++;running++;
   const timeout=setTimeout(()=>controller.abort(),8000);
   void Promise.resolve().then(()=>read(id,controller.signal)).then(events=>{
    if(disposed||controller.signal.aborted||entries.get(id)!==entry)return;
    entry.unknown=false;entry.stopped=isStoppedBoundary(events);publish();
   }).catch(()=>{
    if(disposed||entries.get(id)!==entry)return;
    entry.unknown=true;entry.stopped=false;publish();
   }).finally(()=>{clearTimeout(timeout);entry.controller=null;running--;drain();});
  }
 }
 return {
  sync(threads:readonly StopMarkThread[],readableIds?:ReadonlySet<string>){
   if(disposed)return;
   const ids=new Set(threads.filter(thread=>!thread.isHidden).map(thread=>thread.id));
   for(const [id,entry] of entries)if(!ids.has(id)){entry.controller?.abort();entries.delete(id);pending.delete(id);}
   for(const thread of threads){
    if(thread.isHidden)continue;
    const key=JSON.stringify([thread.updatedAt,thread.status,thread.runtimeStatus]);
    const canRead=readableIds===undefined||readableIds.has(thread.id);
    const previous=entries.get(thread.id);
    if(!previous&&!canRead)continue;
    if(previous?.key===key){
     if(previous.readable!==canRead){
      previous.readable=canRead;
      if(!canRead){previous.controller?.abort();pending.delete(thread.id);}
      else if(previous.unknown&&!previous.controller&&previous.attempts<3)pending.add(thread.id);
     }
     continue;
    }
    previous?.controller?.abort();pending.delete(thread.id);
    const idle=thread.status==='idle'&&thread.runtimeStatus==='idle';
    entries.set(thread.id,{key,stopped:false,unknown:idle,attempts:0,readable:canRead,controller:null});
    if(idle&&canRead)pending.add(thread.id);
   }
   publish();drain();
  },
  retryUnknown(){if(disposed)return;for(const [id,entry] of entries)if(entry.readable&&entry.unknown&&!entry.controller&&entry.attempts<3)pending.add(id);drain();},
  dispose(){if(disposed)return;disposed=true;for(const entry of entries.values())entry.controller?.abort();entries.clear();pending.clear();publish();}
 };
}
