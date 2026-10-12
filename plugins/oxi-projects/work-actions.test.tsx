// @vitest-environment jsdom
import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
const {rpc,navigate,composer}=vi.hoisted(()=>({rpc:{call:vi.fn()},navigate:{toThread:vi.fn()},composer:{props:null as any}}));
vi.mock('@get-bb/plugin-sdk/app',()=>({useRpc:()=>({call:rpc.call}),useBbContext:()=>({}),useBbNavigate:()=>navigate,experimental_NewThreadComposer:(props:any)=>{composer.props=props;return <button onClick={()=>props.onSubmit({projectId:'p',model:'cheap'}).catch(()=>{})}>Отправить выбранной моделью</button>;}}));
import {WorkActions} from './work-actions';
afterEach(()=>cleanup());
it('prepares without launching, embeds a project-scoped persistent composer, and binds on explicit submit',async()=>{
 const reference={projectId:'p',source:'github' as const,kind:'issue' as const,locator:'a/b#1'};
 rpc.call.mockImplementation(async(method:string)=>method==='workLinks'?[]:method==='prepareWork'?{id:'d',title:'Task',prompt:'Facts',reference}: {threadId:'t',reference,status:'active'});
 render(<WorkActions reference={reference}/>);
 fireEvent.click(screen.getByRole('button',{name:'Подготовить тред'}));
 await screen.findByRole('button',{name:'Отправить выбранной моделью'});
 expect(rpc.call.mock.calls.some(([m])=>m==='launchWork')).toBe(false);
 expect(composer.props).toMatchObject({defaultProjectId:'p',draftKey:'work/d',initialPrompt:'Facts'});
 fireEvent.click(screen.getByRole('button',{name:'Отправить выбранной моделью'}));
 await waitFor(()=>expect(navigate.toThread).toHaveBeenCalledWith('t'));
 expect(rpc.call).toHaveBeenCalledWith('launchWork',{reference,draftId:'d',request:{projectId:'p',model:'cheap'}});
});
it('shows a purpose-specific acceptance label without starting a thread',async()=>{
 const reference={projectId:'p',source:'autopilot-acceptance' as const,kind:'epic' as const,locator:'["mac","projectBeta"]'};
 rpc.call.mockClear();
 rpc.call.mockResolvedValue([]);
 render(<WorkActions reference={reference} label="Подготовить приёмку PR"/>);
 expect(await screen.findByRole('button',{name:'Подготовить приёмку PR'})).toBeTruthy();
 expect(rpc.call.mock.calls.some(([m])=>m==='launchWork')).toBe(false);
});
it('keeps an acceptance draft visible but blocks submit while PR data is incomplete',async()=>{
 const reference={projectId:'p',source:'autopilot-acceptance' as const,kind:'epic' as const,locator:'["mac","projectBeta"]'};
 rpc.call.mockClear();
 rpc.call.mockImplementation(async(method:string)=>method==='workLinks'?[]:method==='prepareWork'?{id:'d',title:'Acceptance',prompt:'PR facts',reference}:null);
 const view=render(<WorkActions reference={reference} canPrepare={true}/>);
 fireEvent.click(screen.getByRole('button',{name:'Подготовить тред'}));
 await screen.findByRole('button',{name:'Отправить выбранной моделью'});
 view.rerender(<WorkActions reference={reference} canPrepare={false}/>);
 expect(screen.getByText(/Отправка приостановлена/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Отправить выбранной моделью'}));
 await waitFor(()=>expect(screen.getByText(/Список PR обновляется или изменился/)).toBeTruthy());
 expect(rpc.call.mock.calls.some(([method])=>method==='launchWork')).toBe(false);
});
it('shows a linked-thread read error even when no new PR can be prepared',async()=>{
 const reference={projectId:'p',source:'autopilot-acceptance' as const,kind:'epic' as const,locator:'["mac","projectBeta"]'};
 rpc.call.mockReset();
 rpc.call.mockRejectedValue(Error('links unavailable'));
 render(<WorkActions reference={reference} canPrepare={false}/>);
 expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('links unavailable'));
});
