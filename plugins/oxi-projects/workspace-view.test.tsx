// @vitest-environment jsdom
import React from 'react';
import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
const {rpc}=vi.hoisted(()=>({rpc:{call:vi.fn(async(method:string)=>method==='getProjectConfig'?{config:{sources:[{source:'linear'}]}}:{projects:[{id:'demo',name:'Example Team',bbProjectId:'proj_example',repositories:[{repo:'org/site',account:'work'}]}]})}}));
vi.mock('@get-bb/plugin-sdk/app',()=>({useRealtime:()=>{},useRpc:()=>rpc,useBbNavigate:()=>({toPluginPanel:vi.fn()}),useBbContext:()=>({})}));
vi.mock('./github/app',()=>({Editor:()=>null,ProjectView:({project,itemKind}:any)=><div>GitHub {itemKind} {project.id}</div>}));
vi.mock('./notes-settings',()=>({NotesSettings:()=>null}));
vi.mock('./tasknotes-view',()=>({TaskNotesView:()=>null}));
vi.mock('./autopilot/project-panel',()=>({ProjectPanel:()=>null}));
import {WorkspaceFrame} from './workspace-view';
it('keeps Linear and GitHub issues available together without changing the tracker configuration',async()=>{
 render(<WorkspaceFrame projectId="proj_example"><div>Linear task list</div></WorkspaceFrame>);
 expect(await screen.findByRole('button',{name:'Linear'})).toBeTruthy();
 fireEvent.click(await screen.findByRole('button',{name:'GitHub Issues'}));
 expect(screen.getByText('GitHub issue demo')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Linear'}));
 expect(screen.getByText('Linear task list')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'PR',exact:true}));
 expect(screen.getByText('GitHub pr demo')).toBeTruthy();
 expect(rpc.call.mock.calls.some(([method])=>method==='saveProjectConfig')).toBe(false);
});
