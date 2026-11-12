// @vitest-environment jsdom
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import type { AccountSummary } from './src/contracts.js';
import { AccountProjectsForm } from './account-projects-form.js';
afterEach(cleanup);
const account={id:'11111111-1111-4111-8111-111111111111',role:'reserve'} as AccountSummary;
it('loads projects, autosaves scope and per-project role, preserving account default',async()=>{
 const save=vi.fn(async(_value:unknown)=>{}), guard=vi.fn();
 const ui=render(<AccountProjectsForm account={account} loadProjects={async()=>[{id:'project-a',name:'Project A'}]} save={save} onUnsavedChange={guard}/>);
 await waitFor(()=>expect(ui.getByRole('option',{name:'Project A'})).toBeTruthy());
 fireEvent.change(ui.getByLabelText('Добавить проект'),{target:{value:'project-a'}});
 await waitFor(()=>expect(save.mock.calls[0]?.[0]).toEqual({onlySelected:false,rules:[{projectId:'project-a',role:'inherit'}]}));
 await waitFor(()=>expect((ui.getByLabelText('Где использовать') as HTMLSelectElement).disabled).toBe(false));
 fireEvent.change(ui.getByLabelText('Роль в Project A'),{target:{value:'primary'}});
 await waitFor(()=>expect(save.mock.calls.at(-1)?.[0]).toEqual({onlySelected:false,rules:[{projectId:'project-a',role:'primary'}]}));
 await waitFor(()=>expect((ui.getByLabelText('Где использовать') as HTMLSelectElement).disabled).toBe(false));
 fireEvent.change(ui.getByLabelText('Где использовать'),{target:{value:'selected'}});
 await waitFor(()=>expect(save.mock.calls.at(-1)?.[0]).toEqual({onlySelected:true,rules:[{projectId:'project-a',role:'primary'}]}));
 expect(account.role).toBe('reserve');await waitFor(()=>expect(guard).toHaveBeenLastCalledWith(false));
});
it('retains unknown projects and failed edits until retry succeeds',async()=>{
 const save=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined),guard=vi.fn();
 const ui=render(<AccountProjectsForm account={{...account,projects:{onlySelected:true,rules:[{projectId:'missing',role:'reserve'}]}}} loadProjects={async()=>[]} save={save} onUnsavedChange={guard}/>);
 expect(ui.getByText('Недоступный проект (missing)')).toBeTruthy();
 fireEvent.change(ui.getByLabelText('Роль в missing'),{target:{value:'primary'}});
 await waitFor(()=>expect(ui.getByRole('alert')).toBeTruthy());expect(guard).toHaveBeenLastCalledWith(true);
 fireEvent.click(ui.getByRole('button',{name:'Повторить'}));await waitFor(()=>expect(guard).toHaveBeenLastCalledWith(false));
 expect(save.mock.calls.at(-1)?.[0]).toEqual({onlySelected:true,rules:[{projectId:'missing',role:'primary'}]});
});
it('synchronizes pristine project rules received while the card is open',async()=>{
 const save=vi.fn(async(_value:unknown)=>{}),loadProjects=async()=>[];
 const a={onlySelected:false,rules:[{projectId:'project-a',role:'primary' as const}]};
 const b={onlySelected:false,rules:[{projectId:'project-b',role:'reserve' as const}]};
 const ui=render(<AccountProjectsForm account={{...account,projects:a}} loadProjects={loadProjects} save={save}/>);
 ui.rerender(<AccountProjectsForm account={{...account,projects:b}} loadProjects={loadProjects} save={save}/>);
 fireEvent.change(ui.getByLabelText('Где использовать'),{target:{value:'selected'}});
 await waitFor(()=>expect(save.mock.calls[0]?.[0]).toEqual({...b,onlySelected:true}));
});
it('keeps failed edits from overwriting realtime changes and allows explicit reload',async()=>{
 const save=vi.fn().mockRejectedValue(new Error('offline')),guard=vi.fn(),loadProjects=async()=>[];
 const a={onlySelected:false,rules:[{projectId:'project-a',role:'primary' as const}]};
 const b={onlySelected:false,rules:[{projectId:'project-b',role:'reserve' as const}]};
 const ui=render(<AccountProjectsForm account={{...account,projects:a}} loadProjects={loadProjects} save={save} onUnsavedChange={guard}/>);
 fireEvent.change(ui.getByLabelText('Где использовать'),{target:{value:'selected'}});
 await waitFor(()=>expect(ui.getByRole('button',{name:'Повторить'})).toBeTruthy());
 ui.rerender(<AccountProjectsForm account={{...account,projects:b}} loadProjects={loadProjects} save={save} onUnsavedChange={guard}/>);
 expect(ui.queryByRole('button',{name:'Повторить'})).toBeNull();
 fireEvent.click(ui.getByRole('button',{name:'Загрузить актуальные настройки'}));
 expect(ui.getByText('Недоступный проект (project-b)')).toBeTruthy();expect(guard).toHaveBeenLastCalledWith(false);expect(save).toHaveBeenCalledTimes(1);
});
