// @vitest-environment jsdom
import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const {rpc,state}=vi.hoisted(()=>({rpc:{call:vi.fn()},state:{settings:{threadMachineMarks:JSON.stringify({enabled:true,hosts:{host_a:{kind:'local'}}})},threads:[] as any[]}}));
vi.mock('@get-bb/plugin-sdk/app',()=>({useRpc:()=>rpc,useSettings:()=>({values:state.settings}),experimental_useSidebarThreads:()=>({status:'ready',threads:state.threads})}));
import {MachineMarksSettings,MachineHeaderMark} from './machine-marks-view';
const view=()=>({config:{enabled:true,hosts:{host_a:{kind:'local'},host_old:{kind:'primary',icon:'chip'}}},revision:'a'.repeat(64),hosts:[{id:'host_a',name:'Example Mac'},{id:'host_b',name:'Example server'}],error:null});
afterEach(()=>{cleanup();rpc.call.mockReset();state.threads=[];});
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
