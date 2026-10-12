// @vitest-environment jsdom
import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,within,cleanup} from '@testing-library/react';
afterEach(cleanup);
const projects=[{id:'a',name:'Alpha',bbProjectId:'p',repositories:[]},{id:'b',name:'Beta',bbProjectId:'p',repositories:[]},{id:'x',name:'Loose',bbProjectId:null,repositories:[]}];
const {rpc}=vi.hoisted(()=>({rpc:{call:vi.fn()}}));
vi.mock('@get-bb/plugin-sdk/app',()=>({useRealtime:()=>{},useRpc:()=>rpc,useBbNavigate:()=>({toPluginPanel:vi.fn()}),useBbContext:()=>({})}));
vi.mock('./github/app',()=>({Editor:({initial,onSave}:any)=><div data-testid="editor">Редактор {initial.name}<button onClick={()=>onSave({...initial,name:initial.name+'!'})}>save</button></div>,ProjectView:()=>null}));
vi.mock('./notes-settings',()=>({NotesSettings:()=>null}));
vi.mock('./catalog-view',()=>({CatalogDrift:()=>null}));
import {CatalogSettings} from './workspace-view';

it('opens the editor under the clicked row, confirms the save, and keeps list order',async()=>{
 rpc.call.mockImplementation(async(method:string,input:any)=>method==='github_catalog'?{projects,accounts:[],accountError:null}:input);
 render(<CatalogSettings projectId="p"/>);
 const alpha=(await screen.findByText(/Alpha/)).closest('div')!.parentElement!;
 fireEvent.click(within(alpha).getByRole('button',{name:'Настроить'}));
 expect(within(alpha).getByTestId('editor').textContent).toContain('Alpha');
 expect(screen.getAllByTestId('editor')).toHaveLength(1);
 fireEvent.click(within(alpha).getByRole('button',{name:'save'}));
 expect(await within(alpha).findByRole('status')).toBeTruthy();
 const names=screen.getAllByText(/репозиториев/).map(n=>n.textContent);
 expect(names[0]).toContain('Alpha!');
 expect(names[1]).toContain('Beta');
});

it('keeps unlinked connections collapsed and binds them only to the open project',async()=>{
 rpc.call.mockImplementation(async(method:string,input:any)=>method==='github_catalog'?{projects,accounts:[],accountError:null}:input);
 render(<CatalogSettings projectId="p"/>);
 const summary=await screen.findByText('Не привязаны ни к одному проекту BB (1)');
 expect(summary.closest('details')!.open).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Привязать к этому проекту'}));
 fireEvent.click(screen.getByRole('button',{name:'save'}));
 expect(rpc.call).toHaveBeenCalledWith('github_saveProject',expect.objectContaining({id:'x',bbProjectId:'p'}));
});

it('does not close another editor opened while a save is pending',async()=>{
 let finish:(v:any)=>void=()=>{};
 rpc.call.mockImplementation(async(method:string,input:any)=>method==='github_catalog'?{projects,accounts:[],accountError:null}:new Promise(r=>{finish=()=>r(input);}));
 render(<CatalogSettings projectId="p"/>);
 const alpha=(await screen.findByText(/Alpha/)).closest('div')!.parentElement!;
 const beta=screen.getByText(/Beta/).closest('div')!.parentElement!;
 fireEvent.click(within(alpha).getByRole('button',{name:'Настроить'}));
 fireEvent.click(within(alpha).getByRole('button',{name:'save'}));
 fireEvent.click(within(beta).getByRole('button',{name:'Настроить'}));
 finish(null);
 expect(await within(alpha).findByRole('status')).toBeTruthy();
 expect(within(beta).getByTestId('editor').textContent).toContain('Beta');
});
