// @vitest-environment jsdom
import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const {rpc,state,sdk}=vi.hoisted(()=>({rpc:{call:vi.fn()},sdk:{threads:{events:{list:vi.fn()}}},state:{settings:{threadMachineMarks:JSON.stringify({enabled:true,hosts:{host_a:{kind:'local'}}})},threads:[] as any[]}}));
vi.mock('@get-bb/plugin-sdk/app',()=>({useRpc:()=>rpc,useSdk:()=>sdk,useSettings:()=>({values:state.settings}),experimental_useSidebarThreads:()=>({status:'ready',threads:state.threads})}));
import {MachineMarksSettings,MachineHeaderMark,MachineMarksController} from './machine-marks-view';
import {machineMarkStore} from './machine-marks-dom';
const view=()=>({config:{enabled:true,hosts:{host_a:{kind:'local'},host_old:{kind:'primary',icon:'chip'}}},revision:'a'.repeat(64),hosts:[{id:'host_a',name:'Example Mac'},{id:'host_b',name:'Example server'}],error:null});
afterEach(()=>{cleanup();rpc.call.mockReset();sdk.threads.events.list.mockReset();state.threads=[];machineMarkStore.setRenderedIds(new Set());});
it('highlights ancestors from the existing child read, retains it when collapsed and clears on child restart',async()=>{
 const host={id:'host_a',name:'Example Mac'};
 state.threads=[{id:'thr_root',host,status:'active',runtimeStatus:'active',updatedAt:1,parentThreadId:null},{id:'thr_child',host,status:'idle',runtimeStatus:'idle',updatedAt:1,parentThreadId:'thr_root'}];
 machineMarkStore.setRenderedIds(new Set(['thr_root','thr_child']));sdk.threads.events.list.mockResolvedValue([{type:'system/thread/interrupted',data:{reason:'manual-stop'}}]);
 const v=render(<MachineMarksController/>);await waitFor(()=>expect(machineMarkStore.get('thr_root')?.stopped).toBe(true));expect(sdk.threads.events.list).toHaveBeenCalledTimes(1);
 machineMarkStore.setRenderedIds(new Set(['thr_root']));await waitFor(()=>expect(machineMarkStore.get('thr_root')?.label).toContain('дочерние'));
 expect(sdk.threads.events.list).toHaveBeenCalledTimes(1);
 state.threads=[state.threads[0],{...state.threads[1],status:'active',runtimeStatus:'active',updatedAt:2}];v.rerender(<MachineMarksController/>);
 await waitFor(()=>expect(machineMarkStore.get('thr_root')?.stopped).not.toBe(true));expect(sdk.threads.events.list).toHaveBeenCalledTimes(1);
});
it('does not fetch stop metadata for rows absent from the rendered sidebar',async()=>{
 state.threads=[{id:'thr_hidden_group',host:{id:'host_a',name:'Example Mac'},status:'idle',runtimeStatus:'idle',updatedAt:1}];
 render(<MachineMarksController/>);await waitFor(()=>expect(machineMarkStore.get('thr_hidden_group')).not.toBeNull());
 expect(sdk.threads.events.list).not.toHaveBeenCalled();
});
it('uses only the latest stop/turn metadata and works after StrictMode remount',async()=>{
 state.threads=[{id:'thr_a',host:{id:'host_a',name:'Example Mac'},status:'idle',runtimeStatus:'idle',updatedAt:1}];
 machineMarkStore.setRenderedIds(new Set(['thr_a']));
 sdk.threads.events.list.mockResolvedValue([{type:'system/thread/interrupted',data:{reason:'manual-stop'}}]);
 const view=render(<React.StrictMode><MachineMarksController/></React.StrictMode>);
 await waitFor(()=>expect(machineMarkStore.get('thr_a')?.stopped).toBe(true));
 expect(sdk.threads.events.list).toHaveBeenCalledWith(expect.objectContaining({threadId:'thr_a',limit:'1',order:'desc',types:['turn/started','system/thread/interrupted']}));
 state.threads=[{...state.threads[0],status:'active',runtimeStatus:'active',updatedAt:2}];view.rerender(<React.StrictMode><MachineMarksController/></React.StrictMode>);
 await waitFor(()=>expect(machineMarkStore.get('thr_a')?.stopped).not.toBe(true));view.unmount();expect(machineMarkStore.get('thr_a')).toBeNull();
});
it('saves stable IDs and keeps assignments missing from the current roster',async()=>{
 rpc.call.mockResolvedValueOnce(view());render(<MachineMarksSettings/>);await screen.findByText('Example Mac');
 fireEvent.change(screen.getByLabelText('Тип машины Example server'),{target:{value:'primary'}});
 rpc.call.mockResolvedValueOnce({saved:true}).mockResolvedValueOnce(view());fireEvent.click(screen.getByRole('button',{name:'Сохранить значки'}));
 await waitFor(()=>expect(rpc.call).toHaveBeenCalledWith('machineMarksSave',{config:{...view().config,hosts:{...view().config.hosts,host_b:{kind:'primary'}}},revision:'a'.repeat(64)}));
});
it('shows roster failure as an error with retry, rather than no machines',async()=>{
 rpc.call.mockRejectedValueOnce(Error('secret upstream'));render(<MachineMarksSettings/>);
 expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('Не удалось загрузить'));
 expect(screen.queryByText(/secret upstream/)).toBeNull();
});
it('preserves unsaved selection and does not claim success when save conflicts',async()=>{
 rpc.call.mockResolvedValueOnce(view());render(<MachineMarksSettings/>);await screen.findByText('Example Mac');
 fireEvent.change(screen.getByLabelText('Тип машины Example server'),{target:{value:'local'}});
 rpc.call.mockRejectedValueOnce(Error('conflict'));fireEvent.click(screen.getByRole('button',{name:'Сохранить значки'}));
 expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('Не удалось сохранить'));
 expect((screen.getByLabelText('Тип машины Example server') as HTMLSelectElement).value).toBe('local');
});
it('uses sidebar machine data in the header without changing a thread or fetching per row',()=>{
 state.threads=[{id:'thr_a',host:{id:'host_a',name:'Example Mac'}}];render(<MachineHeaderMark threadId="thr_a" projectId="proj_a" isCompactViewport={false}/>);
 expect(screen.getByRole('button',{name:'Локальный компьютер · Example Mac'})).toBeTruthy();expect(rpc.call).not.toHaveBeenCalled();
});
