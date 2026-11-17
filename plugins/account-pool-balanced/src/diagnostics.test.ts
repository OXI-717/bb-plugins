import { expect, it } from 'vitest';
import { summarizeDiagnostics } from './diagnostics.js';
it('uses measured samples and strips payloads', () => {
 const report=summarizeDiagnostics({from:0,to:3600000},[{hour:0,provider:'codex',queueWaits:2,queueWaitMs:300,queueFailures:1,...{credentials:'PRIVATE'}}],[{at:10,provider:'codex',event:'queue-wait',durationMs:20,...{body:'PRIVATE'}},{at:30,provider:'codex',event:'queue-wait',durationMs:null}]);
 expect(report.history[0]).toMatchObject({queueWaits:2,meanQueueWaitMs:150});
 expect(report.fresh[0]).toMatchObject({events:2,samples:1,meanMs:20,maxMs:20});
 expect(JSON.stringify(report)).not.toContain('PRIVATE');
 expect(summarizeDiagnostics({from:100,to:200},[],[]).fresh).toEqual([]);
});

import { vi } from 'vitest';
import { registerPoolCli } from './cli.js';
it('validates periods before reading and never starts the updater', async()=>{
 let run!: (args:string[],context:object)=>Promise<{exitCode:number;stdout?:string}>;
 const diagnostics=vi.fn(async()=>({accounts:[],history:[]}));
 const update=vi.fn(async()=>({operationId:'synthetic',startedAt:1,state:'succeeded' as const,hostId:'PRIVATE',terminalId:'PRIVATE'}));
 registerPoolCli({cli:{register:(r:{run:typeof run})=>{run=r.run;}}} as never,{diagnostics} as never,{} as never,{} as never,{} as never,
 undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,update);
 for(const args of [[],['--from','bad'],['--from','2026-02-30T00:00:00Z','--to','2026-03-01T00:00:00Z'],['--from','2026-01-01T00:00:00Z','--to','2026-02-01T00:00:00Z'],['--reload']])
  expect((await run(['diagnostics',...args],{})).exitCode).toBe(1);
 expect(diagnostics).not.toHaveBeenCalled();
 const result=await run(['diagnostics','--from','2026-01-01T00:00:00Z','--to','2026-01-02T00:00:00Z','--json'],{});
 expect(result.exitCode).toBe(0);expect(result.stdout).not.toContain('PRIVATE');expect(update).toHaveBeenCalledOnce();
 expect(diagnostics).toHaveBeenCalledExactlyOnceWith(Date.parse('2026-01-01T00:00:00Z'),Date.parse('2026-01-02T00:00:00Z'));
 diagnostics.mockClear();
 expect((await run(['diagnostics','--from','2026-01-01T00:00:00Z','--to','2026-01-02T00:00:00Z','--compare-previous'],{})).exitCode).toBe(0);
 expect(diagnostics).toHaveBeenNthCalledWith(2,Date.parse('2025-12-31T00:00:00Z'),Date.parse('2026-01-01T00:00:00Z'));
});

import { PoolOperations } from './operations.js';
it('uses one direct aggregate without paged snapshots',async()=>{
 const trafficHistory=vi.fn(()=>{throw Error('paged snapshot forbidden');});
 const trafficDiagnostics=vi.fn(()=>({history:[{provider:'codex',queueWaits:65536}],totalRows:65536,truncated:true,capacityDroppedEvents:4}));
 const hub={trafficHistory,trafficDiagnostics,observations:vi.fn(()=>({unavailable:true})),status:async()=>({accounts:[{id:'synthetic',provider:'codex',enabled:true,status:'ready',label:'PRIVATE',credentials:'PRIVATE'}]})};
 const report=await PoolOperations.prototype.diagnostics.call({hub} as never,0,3600000);
 expect(trafficDiagnostics).toHaveBeenCalledExactlyOnceWith(0,3600000);expect(trafficHistory).not.toHaveBeenCalled();
 expect(report.historyCoverage).toMatchObject({rowsRead:65536,truncated:true,capacityDroppedEvents:4});
 expect(JSON.stringify(report)).not.toContain('PRIVATE');
});
it('aggregates a capacity-sized iterable once without paging or sorting',()=>{
 let visits=0;
 const rows={*[Symbol.iterator](){for(let i=0;i<65536;i++){visits++;yield {hour:0,provider:'codex',queueWaits:1,queueWaitMs:2,queueFailures:0};}}};
 expect(summarizeDiagnostics({from:0,to:3600000},rows,[]).history).toEqual([{provider:'codex',queueWaits:65536,queueWaitMs:131072,queueFailures:0,meanQueueWaitMs:2}]);
 expect(visits).toBe(65536);
});
