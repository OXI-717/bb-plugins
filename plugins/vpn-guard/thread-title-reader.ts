/** Retain active read slots across list remounts; cancel only queued work. */
export function createThreadTitleReader<T>(load:(id:string)=>Promise<T>) {
  type Job={id:string;signal:AbortSignal;resolve:(title:T)=>void;reject:(error:Error)=>void;cancel:()=>void};
  const queue:Job[]=[];let active=0;
  function drain() {
    while(active<4&&queue.length){
      const job=queue.shift()!;active++;
      void Promise.resolve().then(()=>{if(job.signal.aborted)throw new Error('Title read cancelled');return load(job.id);})
        .then(job.resolve,job.reject).finally(()=>{job.signal.removeEventListener('abort',job.cancel);active--;drain();});
    }
  }
  return {read:(id:string,signal:AbortSignal)=>new Promise<T>((resolve,reject)=>{
    if(signal.aborted){reject(new Error('Title read cancelled'));return;}
    const job:Job={id,signal,resolve,reject,cancel:()=>{const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);reject(new Error('Title read cancelled'));}};
    signal.addEventListener('abort',job.cancel,{once:true});queue.push(job);drain();
  })};
}
