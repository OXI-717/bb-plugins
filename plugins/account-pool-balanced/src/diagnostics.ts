/** Aggregates only fixed metadata fields; never serializes input objects. */
export function summarizeDiagnostics(period:{from:number;to:number}, history:Iterable<{hour:number;provider:string;queueWaits:number;queueWaitMs:number;queueFailures:number}>, fresh:readonly {at:number;provider:string;event:string;durationMs:number|null;guardPhase?:string}[]) {
 const totals=new Map<string,{provider:string;queueWaits:number;queueWaitMs:number;queueFailures:number}>();
 for(const r of history){
  if(r.hour<period.from||r.hour>=period.to)continue;
  const t=totals.get(r.provider)??{provider:r.provider,queueWaits:0,queueWaitMs:0,queueFailures:0};
  t.queueWaits+=r.queueWaits;t.queueWaitMs+=r.queueWaitMs;t.queueFailures+=r.queueFailures;totals.set(r.provider,t);
 }
 const stages=new Map<string,{provider:string;stage:string;events:number;samples:number;sumMs:number;maxMs:number|null}>();
 for(const r of fresh){
  if(r.at<period.from||r.at>=period.to||!['queue-wait','guard-check','auth-refresh'].includes(r.event))continue;
  const stage=r.event==='guard-check'?`guard-check:${r.guardPhase??'unknown'}`:r.event;
  const key=JSON.stringify([r.provider,stage]);
  const s=stages.get(key)??{provider:r.provider,stage,events:0,samples:0,sumMs:0,maxMs:null};s.events++;
  if(r.durationMs!==null){s.samples++;s.sumMs+=r.durationMs;s.maxMs=Math.max(s.maxMs??0,r.durationMs);}stages.set(key,s);
 }
 return {history:[...totals.values()].map(t=>({...t,meanQueueWaitMs:t.queueWaits?t.queueWaitMs/t.queueWaits:null})),
 fresh:[...stages.values()].map(s=>({...s,meanMs:s.samples?s.sumMs/s.samples:null})),
 limitations:['History uses whole UTC hour buckets, grouped by provider/account; client/project dimensions are unavailable.',
 'Fresh stages are retained events only, may overlap, and are not additive. Missing stages have no samples; no percentiles or inferred queue depth.',
 'History has no event-level freshness timestamp. Empty data does not prove absence of traffic.']};
}
