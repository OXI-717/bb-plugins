import type {PoolProvider} from './contracts.js';

export class NetworkFlights {
  private readonly active=new Map<AbortController,PoolProvider>();
  constructor(private readonly upstream:typeof fetch,private readonly stop:()=>AbortSignal,private readonly check:(provider:PoolProvider)=>Promise<void>,private readonly selectFetch:(provider:PoolProvider)=>typeof fetch=()=>upstream) {}
  get size(){return this.active.size;}
  async enforce() {
    for(const provider of new Set(this.active.values())) {
      try {await this.check(provider);} catch(error) {
        for(const [controller,current] of this.active) if(current===provider) controller.abort(error);
      }
    }
  }
  async fetch(provider:PoolProvider,input:RequestInfo|URL,init?:RequestInit,drainable=false):Promise<Response> {
    await this.check(provider);
    const owner=new AbortController();
    const signal=AbortSignal.any([owner.signal,...(drainable?[]:[this.stop()]),...(init?.signal?[init.signal]:[]),...(input instanceof Request?[input.signal]:[])]);
    signal.throwIfAborted();
    this.active.set(owner,provider);
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    let downstream:ReadableStreamDefaultController<Uint8Array>|undefined;
    let finished=false;
    const release=()=>{this.active.delete(owner);signal.removeEventListener('abort',abort);};
    const abort=()=>{
      if(finished)return;finished=true;
      downstream?.error(signal.reason);
      void reader?.cancel(signal.reason).catch(()=>undefined);
      release();
    };
    signal.addEventListener('abort',abort,{once:true});
    let response:Response|undefined;
    try {
      response=await this.selectFetch(provider)(input,{...init,signal});
      signal.throwIfAborted();
      await this.check(provider);
      signal.throwIfAborted();
      if(!response.body){finished=true;release();return response;}
      reader=response.body.getReader();
      const body=new ReadableStream<Uint8Array>({
        start(controller){downstream=controller;},
        async pull(controller){
          try {
            const next=await reader!.read();if(finished)return;
            if(next.done){finished=true;release();controller.close();}else controller.enqueue(next.value);
          } catch(error){if(!finished){finished=true;release();controller.error(error);}}
        },
        async cancel(reason){finished=true;release();owner.abort(reason);await reader!.cancel(reason);},
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    } catch(error) {
      finished=true;release();owner.abort(error);
      void response?.body?.cancel(error).catch(()=>undefined);
      throw error;
    }
  }
}
