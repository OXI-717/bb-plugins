// Keep the bridge signal bounded. Native BB treats a null timeline as a refetch.
export function boundedFrame(data:string):string|null {
 if(data.length<=65536)return data;
 let message:any;try{message=JSON.parse(data);}catch{return null;}
 const t=message?.target;
 if(message?.type!=='thread-timeline'||t?.kind!=='thread-timeline'||!/^thr_[a-z0-9]+$/.test(t.threadId??'')||
  !(t.segmentLimit===null||Number.isInteger(t.segmentLimit)&&t.segmentLimit>0)||typeof t.deferContent!=='boolean')return null;
 return JSON.stringify({type:'thread-timeline',target:{kind:t.kind,threadId:t.threadId,segmentLimit:t.segmentLimit,deferContent:t.deferContent},timeline:null});
}
