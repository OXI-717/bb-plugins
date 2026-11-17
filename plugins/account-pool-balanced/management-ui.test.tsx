// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';

const app=await loadPluginApp(()=>import('./app'));
let active:ReturnType<typeof renderSlot>|null=null;
afterEach(()=>{cleanup();active=null;localStorage.clear();sessionStorage.clear();});

it('opens owner settings without requesting an administrator key or management grant',async()=>{
  active=renderSlot(app.settingsSections[0]!,{}, {rpc:{'status.get':()=>Promise.reject(new Error('Synthetic status unavailable'))}});
  await waitFor(()=>expect(active!.rpcCalls.some(call=>call.method==='status.get')).toBe(true));
  expect(active.queryByLabelText('Ключ администратора')).toBeNull();
  expect(active.queryByRole('button',{name:'Разблокировать'})).toBeNull();
  expect(active.rpcCalls.some(call=>call.method.startsWith('management.'))).toBe(false);
});

it('ignores obsolete browser inventory and does not persist credentials or management grants',async()=>{
  localStorage.setItem('account-pool:status',JSON.stringify({accounts:[{email:'cached@example.com'}]}));
  active=renderSlot(app.settingsSections[0]!,{}, {rpc:{'status.get':()=>Promise.reject(new Error('Synthetic status unavailable'))}});
  await waitFor(()=>expect(active!.rpcCalls.some(call=>call.method==='status.get')).toBe(true));
  expect(active.queryByText('cached@example.com')).toBeNull();
  expect(localStorage.length).toBe(1);
  expect(sessionStorage.length).toBe(0);
  expect(active.rpcCalls.some(call=>call.method==='management.unlock')).toBe(false);
});

it('shows an unavailable inventory without replacing owner controls with a key prompt',async()=>{
  active=renderSlot(app.settingsSections[0]!,{}, {rpc:{'status.get':()=>Promise.reject(new Error('Synthetic status unavailable'))}});
  await active.findByText('Synthetic status unavailable');
  expect(active.getAllByRole('button',{name:'Добавить аккаунт'}).length).toBeGreaterThan(0);
  expect(active.rpcCalls.some(call=>call.method.startsWith('management.'))).toBe(false);
  expect(active.queryByLabelText('Ключ администратора')).toBeNull();
});
