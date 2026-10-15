// @vitest-environment jsdom
import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
const {rpc}=vi.hoisted(()=>({rpc:{call:vi.fn()}}));
vi.mock('@get-bb/plugin-sdk/app',()=>({useRpc:()=>rpc}));
import {MemorySettings} from './memory-settings';
const state=(projectId='projectAlpha',extra={})=>({projectId,binding:{mode:'project',code:'PROJECT_ALPHA'},mappingRevision:'r1',catalogRevision:'v1',catalog:[{code:'PROJECT_ALPHA',label:'Project Alpha'},{code:'PROJECT_BETA',label:'Project Beta'}],catalogAvailable:true,status:'linked',access:'available',read:true,add:true,automatic:true,...extra});
afterEach(()=>{cleanup();rpc.call.mockReset();});
it('sync rereads vault list, keeps missing mapping visible, and shows authorization independently',async()=>{
 rpc.call.mockResolvedValueOnce(state());render(<MemorySettings projectId="projectAlpha"/>);
 expect(await screen.findByText(/только в pending/)).toBeTruthy();
 rpc.call.mockResolvedValueOnce(state('projectAlpha',{catalog:[{code:'PROJECT_BETA',label:'Renamed'}],status:'missing-catalog',access:'not-checked'}));
 fireEvent.click(screen.getByRole('button',{name:'Синхронизировать список из волта'}));
 expect(await screen.findByText(/Связанный код отсутствует/)).toBeTruthy();
 expect(screen.getByRole('option',{name:'PROJECT_ALPHA — отсутствует в каталоге'})).toBeTruthy();
 expect(screen.getByRole('option',{name:'Renamed (PROJECT_BETA)'})).toBeTruthy();
 expect((screen.getByRole('button',{name:'Сохранить привязку'}) as HTMLButtonElement).disabled).toBe(true);
 expect(rpc.call.mock.calls.every(([method])=>method==='memoryInspect')).toBe(true);
});
it('saves stable code with revisions, preserves denied access and never treats it as empty search',async()=>{
 rpc.call.mockResolvedValueOnce(state());render(<MemorySettings projectId="projectAlpha"/>);await screen.findByText(/только в pending/);
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'code:PROJECT_BETA'}});
 rpc.call.mockResolvedValueOnce({ok:true,reason:'saved'}).mockResolvedValueOnce(state('projectAlpha',{binding:{mode:'project',code:'PROJECT_BETA'},access:'denied',read:false,add:false,automatic:false}));
 fireEvent.click(screen.getByRole('button',{name:'Сохранить привязку'}));
 expect(await screen.findByText(/Поиск: нет прав/)).toBeTruthy();
 expect(rpc.call).toHaveBeenCalledWith('memorySave',{projectId:'projectAlpha',binding:{mode:'project',code:'PROJECT_BETA'},mappingRevision:'r1',catalogRevision:'v1'});
});
it('switching projects discards late details from previous project and shows ambiguous Hub',async()=>{
 let resolve:any;rpc.call.mockReturnValueOnce(new Promise(r=>{resolve=r;}));
 const view=render(<MemorySettings projectId="projectAlpha"/>);
 rpc.call.mockResolvedValueOnce(state('hub',{binding:{mode:'ambiguous',code:null},status:'ambiguous',access:'not-checked'}));
 view.rerender(<MemorySettings projectId="hub"/>);await screen.findByText(/Общий workspace: предметный проект/);
 resolve(state());await waitFor(()=>expect(screen.queryByText(/Код привязки/)).toBeNull());
 expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('ambiguous');
});
it('distinguishes unavailable plugin and service; conflict requires refresh without claiming success',async()=>{
 rpc.call.mockRejectedValueOnce(Error('private secret'));const view=render(<MemorySettings projectId="projectAlpha"/>);
 expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('Плагин памяти недоступен'));
 expect(screen.queryByText(/private secret/)).toBeNull();
 rpc.call.mockResolvedValueOnce(state('hub',{access:'unavailable'}));view.rerender(<MemorySettings projectId="hub"/>);
 expect(await screen.findByText(/Сервис памяти недоступен/)).toBeTruthy();
 rpc.call.mockResolvedValueOnce({ok:false,reason:'conflict'});fireEvent.click(screen.getByRole('button',{name:'Сохранить привязку'}));
 expect(await screen.findByText(/Настройки или каталог изменились/)).toBeTruthy();
 expect(screen.queryByText(/Связь сохранена. Права доступа/)).toBeNull();
});
it('catalog read failure does not claim successful synchronization',async()=>{
 rpc.call.mockResolvedValueOnce(state());render(<MemorySettings projectId="projectAlpha"/>);await screen.findByText(/только в pending/);
 rpc.call.mockResolvedValueOnce(state('projectAlpha',{catalog:[],catalogAvailable:false,status:'catalog-unavailable',access:'not-checked'}));
 fireEvent.click(screen.getByRole('button',{name:'Синхронизировать список из волта'}));
 expect(await screen.findByText(/Не удалось перечитать каталог/)).toBeTruthy();
 expect(screen.queryByText(/Каталог перечитан из волта/)).toBeNull();
});
it('late save does not load details or update selection after switching projects',async()=>{
 rpc.call.mockResolvedValueOnce(state());const view=render(<MemorySettings projectId="projectAlpha"/>);await screen.findByText(/только в pending/);
 let resolve:any;rpc.call.mockReturnValueOnce(new Promise(r=>{resolve=r;}));
 fireEvent.click(screen.getByRole('button',{name:'Сохранить привязку'}));
 rpc.call.mockResolvedValueOnce(state('hub',{binding:{mode:'ambiguous',code:null},status:'ambiguous',access:'not-checked'}));
 view.rerender(<MemorySettings projectId="hub"/>);await screen.findByText(/Общий workspace: предметный проект/);
 resolve({ok:true,reason:'saved'});await waitFor(()=>expect(screen.queryByText(/Код привязки/)).toBeNull());
 expect(rpc.call.mock.calls.filter(([m])=>m==='memoryInspect').length).toBe(2);
});
it('timeout is explicit and is not shown as service-unavailable, denied, or an empty search',async()=>{
 rpc.call.mockResolvedValueOnce(state('projectAlpha',{access:'timeout',read:false,add:false,automatic:false}));
 render(<MemorySettings projectId="projectAlpha"/>);
 expect(await screen.findByText(/Сервис памяти не ответил вовремя \(таймаут\)/)).toBeTruthy();
 expect(screen.queryByText(/Сервис памяти недоступен/)).toBeNull();
 expect(screen.queryByText(/Поиск: нет прав/)).toBeNull();
 expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('code:PROJECT_ALPHA');
});
