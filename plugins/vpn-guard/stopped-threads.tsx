import {useEffect,useState} from 'react';
import {useBbNavigate,useSdk} from '@get-bb/plugin-sdk/app';
import {copy,type Language} from './copy.js';

type Entry={id:string;title:string|null;loaded:boolean;unavailable:boolean};
export function StoppedThreads({threadIds,language}:{threadIds:string[];language:Language}) {
  const sdk=useSdk();const navigate=useBbNavigate();const t=copy[language];
  const idsKey=JSON.stringify(threadIds.slice(-100).reverse());
  const [entries,setEntries]=useState<Entry[]>([]);
  useEffect(()=>{
    const ids=JSON.parse(idsKey) as string[];
    setEntries(ids.map(id=>({id,title:null,loaded:false,unavailable:false})));
    let active=true;let next=0;
    async function worker() {
      while(active&&next<ids.length){
        const id=ids[next++]!;let title:string|null=null;let unavailable=false;
        try {title=(await sdk.threads.get({threadId:id})).title?.trim()||null;}catch {unavailable=true;}
        if(active)setEntries(previous=>previous.map(entry=>entry.id===id?{id,title,loaded:true,unavailable}:entry));
      }
    }
    void Promise.all(Array.from({length:Math.min(4,ids.length)},()=>worker()));
    return()=>{active=false;};
  },[sdk,idsKey]);
  return <>
    {entries.some(entry=>!entry.loaded)&&<p className="vg-help" role="status">{t.loadingThreadTitles}</p>}
    <ol className="vg-events vg-stop-history">{entries.map(entry=><li key={entry.id}>
      {!entry.loaded?<span className="vg-help">{t.loading}</span>:entry.unavailable?<p className="vg-help">{t.threadUnavailable}</p>:<button type="button" onClick={()=>navigate.toThread(entry.id)}>{entry.title||t.untitledThread}</button>}
      <details className="vg-inline-details"><summary>{t.errorDetails}</summary><code>{entry.id}</code></details>
    </li>)}</ol>
  </>;
}
