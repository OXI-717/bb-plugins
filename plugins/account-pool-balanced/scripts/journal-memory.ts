/** Synthetic journal allocation benchmark. Run with node --expose-gc --import tsx. */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import inspector from 'node:inspector';
import { RequestJournal, newTrace } from '../src/request-journal.js';
const dir = await mkdtemp(path.join(os.tmpdir(), 'pool-memory-'));
const now = 1900000000000;
const journal = new RequestJournal(path.join(dir, 'recent.json'), () => now);
const trace = newTrace('codex', 'synthetic-client', 'proj_abcdef1234', null, 'gpt-6-astra', 'other');
const event = { ...trace, at: now, attempt: 0, event: 'request', accountId: null, status: null, durationMs: null, inFlight: 0, accountInFlight: 0, retryAfterMs: null, retryAfterSupplied: null, quotaEvidence: null, holdSource: null, heldUntil: null, outcome: null, failover: null, errorClass: null };
const pauses: number[] = [];
const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) pauses.push(e.duration); });
observer.observe({ entryTypes: ['gc'] });
const session = new inspector.Session(); session.connect();
const post = (method: string, params = {}) => new Promise<any>((resolve, reject) => session.post(method, params, (err, result) => err ? reject(err) : resolve(result)));
await journal.initialize();
global.gc?.(); const baseline = v8.getHeapStatistics().used_heap_size;
for (let i=0;i<6000;i++) journal.record({...event, projectId: `proj_${String(i).padStart(8,'0')}`});
await journal.flush(); global.gc?.();
const retained = v8.getHeapStatistics().used_heap_size;
await new Promise(r=>setImmediate(r)); pauses.length=0;
await post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
let peak = retained;
const start = performance.now();
for(let batch=0;batch<120;batch++) {
 for(let i=0;i<500;i++) journal.record(event);
 if(batch%10===0) await journal.flush();
 peak=Math.max(peak,v8.getHeapStatistics().used_heap_size);
 await new Promise(r=>setImmediate(r));
}
await journal.flush(); await new Promise(r=>setImmediate(r));
const {profile} = await post('HeapProfiler.stopSampling');
let sampledBytes=0; const sites: Record<string,number>={};
function visit(n:any) { sampledBytes+=n.selfSize; if(n.selfSize) {const k=n.callFrame.functionName+' '+n.callFrame.url.split('/').pop(); sites[k]=(sites[k]??0)+n.selfSize;} for(const c of n.children)visit(c); }
visit(profile.head);
console.log(JSON.stringify({ baseline, retainedDelta:retained-baseline, peak, elapsedMs:performance.now()-start, gcCount:pauses.length,gcTotalMs:pauses.reduce((a,b)=>a+b,0),gcMaxMs:Math.max(0,...pauses),sampledBytes,topSites:Object.entries(sites).sort((a,b)=>b[1]-a[1]).slice(0,12),historyBytes:(await stat(path.join(dir,'history.json'))).size,recentBytes:(await stat(path.join(dir,'recent.json'))).size }));
session.disconnect();observer.disconnect();await journal.close();await rm(dir,{recursive:true,force:true});
// Optional allocation regression budget; sampling is approximate, leave ample headroom.
if (process.argv.includes('--check') && sampledBytes > 1024 ** 3) throw Error('Journal allocation budget exceeded');
