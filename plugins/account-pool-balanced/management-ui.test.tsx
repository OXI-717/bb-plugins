// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';

const app = await loadPluginApp(() => import('./app'));
let active: ReturnType<typeof renderSlot> | null = null;
afterEach(async () => {
  const lock = active?.queryByRole('button', { name: 'Заблокировать управление' });
  if (lock) fireEvent.click(lock);
  cleanup(); active = null; localStorage.clear();
});

it('does not read inventory while locked and removes the old browser metadata cache', () => {
  localStorage.setItem('account-pool:status', JSON.stringify({ accounts: [{ email: 'private@example.com' }] }));
  active = renderSlot(app.settingsSections[0]!, {}, { rpc: {} });
  expect(active.getByRole('button', { name: 'Разблокировать' })).toBeTruthy();
  expect(active.queryByText('private@example.com')).toBeNull();
  expect(active.rpcCalls).toEqual([]);
  expect(localStorage.getItem('account-pool:status')).toBeNull();
});

it('keeps the operator input and grant out of persistent browser storage and hides content on lock', async () => {
  const key = 'synthetic-operator-input';
  const grant = { token: 'G'.repeat(43), scope: 'manage', expiresAt: Date.now() + 60_000 };
  active = renderSlot(app.settingsSections[0]!, {}, { rpc: {
    'management.unlock': () => grant,
    'management.lock': () => null,
    'management.call': () => Promise.reject(new Error('Synthetic unavailable read')),
  } });
  fireEvent.change(active.getByLabelText('Ключ администратора'), { target: { value: key } });
  fireEvent.click(active.getByRole('button', { name: 'Разблокировать' }));
  await active.findByRole('button', { name: 'Заблокировать управление' });
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  fireEvent.click(active.getByRole('button', { name: 'Заблокировать управление' }));
  await active.findByRole('button', { name: 'Разблокировать' });
  await waitFor(() => expect(active!.rpcCalls).toContainEqual({ method: 'management.lock', input: { token: grant.token } }));
  expect((active.getByLabelText('Ключ администратора') as HTMLInputElement).value).toBe('');
  expect(active.container.textContent?.includes(key)).toBe(false);
  expect(active.container.textContent?.includes(grant.token)).toBe(false);
});

it('locks the UI when the server refuses a revoked grant', async () => {
  active = renderSlot(app.settingsSections[0]!, {}, { rpc: {
    'management.unlock': () => ({ token: 'G'.repeat(43), scope: 'manage', expiresAt: Date.now() + 60_000 }),
    'management.call': () => ({ ok: false, code: 'pool-management-locked' }),
  } });
  fireEvent.change(active.getByLabelText('Ключ администратора'), { target: { value: 'synthetic-key' } });
  fireEvent.click(active.getByRole('button', { name: 'Разблокировать' }));
  await waitFor(() => expect(active!.rpcCalls.some(call => call.method === 'management.call')).toBe(true));
  await active.findByRole('button', { name: 'Разблокировать' });
  expect(active.queryByText('Управление разблокировано')).toBeNull();
});
