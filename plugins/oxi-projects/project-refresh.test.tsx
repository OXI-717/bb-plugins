// @vitest-environment jsdom
import React from 'react';
import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
const {call}=vi.hoisted(()=>({call:vi.fn()}));
vi.mock('@get-bb/plugin-sdk/app',()=>{const rpc={call};return {useRpc:()=>rpc};});
import {ProjectRefresh} from './project-refresh';
it('reads freshness without syncing and refreshes only the selected project, preserving the previous timestamp on failure',async()=>{
 let rejectRefresh!:(e:Error)=>void;
 call.mockImplementation((method:string)=>method==='status'?Promise.resolve({sources:[{lastSyncedAt:'2026-09-21T10:00:00Z',message:null}]}):new Promise((_,reject)=>{rejectRefresh=reject;}));
 render(<ProjectRefresh projectId="exampleProject"/>);
 await screen.findByText(/Данные:/);
 expect(call.mock.calls.every(([method])=>method==='status')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Обновить проект exampleProject'}));
 expect(call).toHaveBeenCalledWith('refresh',{projectId:'exampleProject'});
 expect(screen.getByText('Обновляется…').closest('button')?.disabled).toBe(true);
 rejectRefresh(Error('Source offline'));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Source offline'));
 expect(screen.getByText(/Данные:/)).toBeTruthy();
});
