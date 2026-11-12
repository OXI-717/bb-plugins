// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ProxyControl} from './account-egress-form';
afterEach(cleanup);
it('masks the URL, submits only explicitly and erases it after saving',async()=>{
 const save=vi.fn(async()=>{});const view=render(<ProxyControl pending={false} save={save}/>);
 const input=view.getByLabelText('Прокси аккаунта') as HTMLInputElement;
 expect(input.type).toBe('password');expect(save).not.toHaveBeenCalled();
 fireEvent.change(input,{target:{value:'https://proxy.example:8443'}});
 fireEvent.click(view.getByText('Сохранить прокси'));
 await waitFor(()=>expect(input.value).toBe(''));expect(save).toHaveBeenCalledExactlyOnceWith('https://proxy.example:8443');
});
it('blocks duplicate submissions while saving',()=>{
 const view=render(<ProxyControl pending={true} save={vi.fn()}/>);
 expect((view.getByLabelText('Прокси аккаунта') as HTMLInputElement).disabled).toBe(true);
 expect((view.getByText('Сохранить прокси') as HTMLButtonElement).disabled).toBe(true);
});
