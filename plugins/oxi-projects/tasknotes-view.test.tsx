// @vitest-environment jsdom
import React from 'react';
import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent,within} from '@testing-library/react';
const {rpc}=vi.hoisted(()=>({rpc:{call:vi.fn()}}));
vi.mock('@get-bb/plugin-sdk/app',()=>({useRpc:()=>rpc,Markdown:({content}:any)=><div>{content}</div>}));
vi.mock('./work-actions',()=>({WorkActions:()=> <button>Подготовить тред</button>}));
import {TaskNotesView} from './tasknotes-view';
it('opens details inside the clicked card before subsequent tasks, with local loading and collapse',async()=>{
 const rows=Array.from({length:100},(_,i)=>({path:`task-${i}.md`,title:`Задача ${i}`,status:'open',tags:[]}));
 rpc.call.mockImplementation(async(method:string,input:any)=>method==='notesList'?rows:{...rows.find(n=>n.path===input.path),details:`Описание ${input.path}`});
 render(<TaskNotesView projectId="p" connections={[{id:'notes',label:'Заметки'}]}/>);
 const first=await screen.findByRole('button',{name:/^Задача 0 open/});
 fireEvent.click(first);
 expect(within(first.closest('section')!).getByRole('status').textContent).toContain('Загружаем');
 const detail=await screen.findByRole('article',{name:'Подробности: Задача 0'});
 expect(first.closest('section')!.contains(detail)).toBe(true);
 expect(detail.compareDocumentPosition(screen.getByRole('button',{name:/^Задача 1 open/})) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/^Задача 1 open/}));
 await screen.findByRole('article',{name:'Подробности: Задача 1'});
 expect(screen.queryByText('Описание task-0.md')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/^Задача 1 open/}));
 expect(screen.queryByRole('article')).toBeNull();
});
