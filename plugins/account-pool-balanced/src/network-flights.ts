import type {PoolMaintenance} from './maintenance.js';
import type {PoolProvider} from './contracts.js';
import {GuardRequiredError} from './network-errors.js';

/**
 * How long responses that were already admitted may continue while the Guard cannot be
 * read at all (timeout or failed call). An explicit refusal, an invalid decision or missing
 * VPN evidence is never tolerated, and new requests are refused from the first failed read.
 */
export const GUARD_UNREADABLE_GRACE_MS = 30_000;
/** The Guard gave no answer. It did not refuse, and nothing indicates the network changed. */
export function guardUnreadable(error:unknown):boolean {
  return error instanceof GuardRequiredError && error.code==='VPN_GUARD_UNAVAILABLE' &&
    (error.failureReason==='timeout'||error.failureReason==='rpc_failed');
}

export type StreamIdentity={requestId:string;threadId:string|null};
export type CursorStream={requestId:string;threadId:string;bytesRead:number;contentType:string};

export class NetworkFlights {
  private readonly active=new Map<AbortController,PoolProvider>();
  private readonly cursorBodies=new Map<AbortController,CursorStream>();
  private readonly unreadableSince=new Map<PoolProvider,number>();
  cursorStreams(threadId:string):CursorStream[]{return [...this.cursorBodies.values()].filter(s=>s.threadId===threadId).map(s=>({...s}));}
  interruptCursorStream(requestId:string,threadId:string):boolean {
    for(const [owner,stream] of this.cursorBodies) if(stream.requestId===requestId&&stream.threadId===threadId&&stream.bytesRead>0){
      owner.abort(new Error('Controlled Cursor stream interruption'));return true;
    }
    return false;
  }
  constructor(private readonly upstream:typeof fetch,private readonly stop:()=>AbortSignal,private readonly check:(provider:PoolProvider)=>Promise<void>,private readonly selectFetch:(provider:PoolProvider,drainable:boolean)=>typeof fetch=()=>upstream,private maintenance?:PoolMaintenance,private readonly now:()=>number=Date.now,
    /** The pool's own requirement that holds without the Guard (its last answer, local VPN evidence). */
    private readonly withoutGuard:(provider:PoolProvider)=>Promise<void>=async()=>{}) {}
  /**
   * Null while an unanswered Guard read is still inside the grace for running responses;
   * otherwise the reason to stop them. Guard silence never suspends the pool's own
   * requirement: when that fails, its error is the reason, with no allowance.
   */
  private async refusal(provider:PoolProvider,error:unknown):Promise<unknown> {
    if(!guardUnreadable(error)){this.unreadableSince.delete(provider);return error;}
    try{await this.withoutGuard(provider);}catch(own){this.unreadableSince.delete(provider);return own;}
    const now=this.now(),since=this.unreadableSince.get(provider)??now;
    this.unreadableSince.set(provider,since);
    return now-since<GUARD_UNREADABLE_GRACE_MS?null:error;
  }
  get size(){return this.active.size;}
  async enforce() {
    for(const provider of new Set(this.active.values())) {
      try {await this.check(provider);this.unreadableSince.delete(provider);} catch(error) {
        const reason=await this.refusal(provider,error);
        if(reason===null)continue;
        for(const [controller,current] of this.active) if(current===provider) controller.abort(reason);
      }
    }
    // A provider with no running response has nothing to tolerate: start afresh next time.
    for(const provider of this.unreadableSince.keys())if(![...this.active.values()].includes(provider))this.unreadableSince.delete(provider);
  }
  async fetch(provider:PoolProvider,input:RequestInfo|URL,init?:RequestInit,drainable=false,admit?: (send:()=>Promise<Response>)=>Promise<Response>,requestCheck?:()=>Promise<void>, accountFetch?:typeof fetch,onBodyError?:(error:unknown,bytesRead:number)=>void,identity?:StreamIdentity):Promise<Response> {
    const maintenanceSignal=this.maintenance?.signal;
    this.maintenance?.assertAllowed();
    const check=requestCheck??(()=>this.check(provider));
    await check();
    const owner=new AbortController();
    const signal=AbortSignal.any([owner.signal,...(maintenanceSignal?[maintenanceSignal]:[]),...(drainable?[]:[this.stop()]),...(init?.signal?[init.signal]:[]),...(input instanceof Request?[input.signal]:[])]);
    signal.throwIfAborted();
    this.active.set(owner,provider);
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    let downstream:ReadableStreamDefaultController<Uint8Array>|undefined;
    let finished=false,bytesRead=0;
    const report=(error:unknown)=>{try{onBodyError?.(error,bytesRead);}catch{/* Diagnostics cannot change forwarding. */}};
    const release=()=>{this.cursorBodies.delete(owner);this.active.delete(owner);signal.removeEventListener('abort',abort);};
    const abort=()=>{
      if(finished)return;
      if(reader&&owner.signal.aborted)report(signal.reason);
      finished=true;
      downstream?.error(signal.reason);
      void reader?.cancel(signal.reason).catch(()=>undefined);
      release();
    };
    signal.addEventListener('abort',abort,{once:true});
    let response:Response|undefined;
    try {
      const send=()=>{signal.throwIfAborted();this.maintenance?.assertAllowed();return (accountFetch??this.selectFetch(provider,drainable))(input,{...init,signal});};
      response=await (admit?admit(send):send());
      signal.throwIfAborted();
      // The request was admitted by a successful check just before dispatch. If the
      // repeat read merely gets no answer, the periodic enforcement decides within its grace.
      try{await check();}catch(error){const reason=await this.refusal(provider,error);if(reason!==null)throw reason;}
      signal.throwIfAborted();
      if(!response.body){finished=true;release();return response;}
      reader=response.body.getReader();
      const cursorBody=provider==='cursor'&&identity?.threadId?{requestId:identity.requestId,threadId:identity.threadId,bytesRead:0,contentType:['text/event-stream','application/connect+proto','application/connect+json'].includes(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()??'')?response.headers.get('content-type')!.split(';')[0]!.trim().toLowerCase():'other'}:undefined;
      if(cursorBody)this.cursorBodies.set(owner,cursorBody);
      const body=new ReadableStream<Uint8Array>({
        start(controller){downstream=controller;},
        async pull(controller){
          try {
            const next=await reader!.read();if(finished)return;
            if(next.done){finished=true;release();controller.close();}else {bytesRead+=next.value.byteLength;if(cursorBody)cursorBody.bytesRead=bytesRead;controller.enqueue(next.value);}
          } catch(error){if(!finished){report(error);finished=true;release();controller.error(error);}}
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
