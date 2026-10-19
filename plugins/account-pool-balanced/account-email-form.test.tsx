// @vitest-environment jsdom
import {cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {AccountEmailForm} from './account-email-form';
afterEach(cleanup);
it('validates an email and saves it against the current baseline',async()=>{
 const save=vi.fn(async()=>{}),unsaved=vi.fn();const ui=render(<AccountEmailForm email={null} save={save} onUnsavedChange={unsaved}/>);
 fireEvent.change(ui.getByRole('textbox',{name:'Email аккаунта'}),{target:{value:'bad'}});fireEvent.click(ui.getByRole('button',{name:'Сохранить email'}));
 expect((await ui.findByRole('alert')).textContent).toContain('Укажите корректный email.');expect(save).not.toHaveBeenCalled();
 fireEvent.change(ui.getByRole('textbox',{name:'Email аккаунта'}),{target:{value:'account@example.com'}});fireEvent.click(ui.getByRole('button',{name:'Сохранить email'}));
 await waitFor(()=>expect(save).toHaveBeenCalledExactlyOnceWith('account@example.com',null));
});
it('preserves an edited draft across a remote change and permits an explicit reset',async()=>{
 const save=vi.fn(async()=>{throw Error('conflict');});const onUnsavedChange=vi.fn();
 const ui=render(<AccountEmailForm email={'old@example.com'} save={save} onUnsavedChange={onUnsavedChange}/>);
 fireEvent.change(ui.getByRole('textbox',{name:'Email аккаунта'}),{target:{value:'mine@example.com'}});
 ui.rerender(<AccountEmailForm email={'remote@example.com'} save={save} onUnsavedChange={onUnsavedChange}/>);
 expect((ui.getByRole('textbox') as HTMLInputElement).value).toBe('mine@example.com');
 fireEvent.click(ui.getByRole('button',{name:'Сохранить email'}));await ui.findByRole('alert');
 expect(save).toHaveBeenCalledWith('mine@example.com','old@example.com');
 fireEvent.click(ui.getByRole('button',{name:'Сбросить'}));expect((ui.getByRole('textbox') as HTMLInputElement).value).toBe('remote@example.com');
});
