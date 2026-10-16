import {useEffect,useState} from 'react';
import {useBbNavigate,useSdk,useRpc} from '@get-bb/plugin-sdk/app';
import type {rpcContract} from './contract.js';
import {copy,type Language} from './copy.js';
import {createThreadTitleReader} from './thread-title-reader.js';

type ThreadSummary={providerId:string;title:string|null;idle:boolean;updatedAt:number;queued:boolean;archived:boolean};
const readers=new WeakMap<object,ReturnType<typeof createThreadTitleReader<ThreadSummary>>>();

type Entry={id:string;title:string|null;loaded:boolean;unavailable:boolean;thread?:ThreadSummary};
export function StoppedThreads({threadIds,language,stopHistory=[],canResume=()=>false}:{threadIds:string[];language:Language;stopHistory?:{threadId:string;hostId:string;at:number}[];canResume?:(hostId:string,providerId:string)=>boolean}) {
  const rpc=useRpc<typeof rpcContract>();const [resuming,setResuming]=useState<string|null>(null);const [requested,setRequested]=useState<string[]>([]);const [resumeError,setResumeError]=useState(false);
  const sdk=useSdk();const navigate=useBbNavigate();const t=copy[language];
  let reader=readers.get(sdk);
  if(!reader){reader=createThreadTitleReader(async id=>{const thread=await sdk.threads.get({threadId:id});return {providerId:thread.providerId,title:thread.title?.trim()||null,idle:thread.status==='idle',updatedAt:thread.updatedAt,queued:thread.queuedMessageCount>0,archived:thread.archivedAt!=null||thread.deletedAt!=null};});readers.set(sdk,reader);}
  const titleReader=reader;
  const serializedIds=JSON.stringify(threadIds.slice(-100).reverse());
  const [entries,setEntries]=useState<Entry[]>([]);
  useEffect(()=>{
    const ids=JSON.parse(serializedIds) as string[];
    setEntries(ids.map(id=>({id,title:null,loaded:false,unavailable:false})));
    let active=true;let next=0;const cancellation=new AbortController();
    async function worker() {
      while(active&&next<ids.length){
        const id=ids[next++]!;let thread:ThreadSummary|undefined;let unavailable=false;
        try {thread=await titleReader.read(id,cancellation.signal);}catch {unavailable=true;}
        if(active)setEntries(previous=>previous.map(entry=>entry.id===id?{id,title:thread?.title??null,thread,loaded:true,unavailable}:entry));
      }
    }
    void Promise.all(Array.from({length:Math.min(4,ids.length)},()=>worker()));
    return()=>{active=false;cancellation.abort();};
  },[titleReader,serializedIds]);
  async function resume(id:string,at:number) {
    setResuming(id);setResumeError(false);
    try{await rpc.call('resumeThread',{threadId:id,stoppedAt:at});setRequested(previous=>[...previous,JSON.stringify([id,at])]);}
    catch{setResumeError(true);}finally{setResuming(null);}
  }
  return <>
    {resumeError&&<p role="alert" className="vg-error">{t.resumeThreadError}</p>}
    {entries.some(entry=>!entry.loaded)&&<p className="vg-help" role="status">{t.loadingThreadTitles}</p>}
    <ol className="vg-events vg-stop-history">{entries.map(entry=><li key={entry.id}>
      {!entry.loaded?<span className="vg-help">{t.loading}</span>:entry.unavailable?<p className="vg-help">{t.threadUnavailable}</p>:<button type="button" onClick={()=>navigate.toThread(entry.id)}>{entry.title||t.untitledThread}</button>}
      {entry.loaded&&!entry.unavailable&&entry.thread?.idle&&!entry.thread.queued&&!entry.thread.archived&&stopHistory.some(stop=>stop.threadId===entry.id&&entry.thread!.updatedAt<=stop.at)&&<div className="vg-actions"><button type="button" disabled={!canResume(stopHistory.filter(stop=>stop.threadId===entry.id).at(-1)!.hostId,entry.thread.providerId)||resuming!==null||requested.includes(JSON.stringify([entry.id,stopHistory.filter(stop=>stop.threadId===entry.id).at(-1)!.at]))} onClick={()=>void resume(entry.id,stopHistory.filter(stop=>stop.threadId===entry.id).at(-1)!.at)}>{requested.includes(JSON.stringify([entry.id,stopHistory.filter(stop=>stop.threadId===entry.id).at(-1)!.at]))?t.resumeRequested:t.resumeThread}</button></div>}
    </li>)}</ol>
  </>;
}
