import {afterEach,expect,it} from 'vitest';
import {createFakePluginHost,makeHostResponse,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import {setupMachineMarks} from './machine-marks-server';
const cleanups:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const fn of cleanups.splice(0))await fn();});
function host(settings:Record<string,string>={},sdk:any={hosts:{list:async()=>[makeHostResponse({id:'host_a',name:'Example'})]}}){const h=createFakePluginHost({pluginId:'oxi-projects',settings,sdk});setupMachineMarks(h.bb);cleanups.push(()=>h.harness.lifecycle.dispose());return h.harness;}
it('starts disabled and saves only a valid explicit configuration',async()=>{
 const h=host();const view:any=await h.behavior.callRpc('machineMarksRead',{});expect(view.config.enabled).toBe(false);expect(view.hosts[0].name).toBe('Example');
 const config={enabled:true,hosts:{host_a:{kind:'local'}}};await h.behavior.callRpc('machineMarksSave',{config,revision:view.revision});
 expect((await h.behavior.callRpc('machineMarksRead',{}) as any).config).toEqual(config);
 await expect(h.behavior.callRpc('machineMarksSave',{config,revision:view.revision})).rejects.toThrow(/изменились/);
});
it('reports corrupt storage without overwriting it and refuses stale repair',async()=>{
 const h=host({threadMachineMarks:'broken'});const view:any=await h.behavior.callRpc('machineMarksRead',{});expect(view.config).toBeNull();expect(view.error).toMatch(/повреждена/);
 await expect(h.behavior.callRpc('machineMarksSave',{config:{enabled:true,hosts:{host_a:{kind:'invalid'}}},revision:view.revision})).rejects.toThrow();
 expect((await h.behavior.callRpc('machineMarksRead',{}) as any).config).toBeNull();
});
it('does not turn roster failure into a successful empty list',async()=>{
 const h=host({}, {hosts:{list:async()=>{throw Error('private upstream details');}}});
 await expect(h.behavior.callRpc('machineMarksRead',{})).rejects.toThrow(/список машин/);
});
it('uses the thread environment rather than the server or current project host',async()=>{
 const h=host({}, {threads:{get:async()=>makeThreadResponse({environmentId:null})}});
 expect(await h.behavior.callRpc('machineMarkThread',{threadId:'thr_a'})).toEqual({host:null});
 expect(h.inspection.sdk.callsTo('hosts.list')).toHaveLength(0);
});
it('serializes concurrent settings saves so only one stale snapshot wins',async()=>{
 const h=host();const view:any=await h.behavior.callRpc('machineMarksRead',{});
 const r=await Promise.allSettled([h.behavior.callRpc('machineMarksSave',{config:{enabled:true,hosts:{}},revision:view.revision}),h.behavior.callRpc('machineMarksSave',{config:{enabled:true,hosts:{host_b:{kind:'other'}}},revision:view.revision})]);
 expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);
});
