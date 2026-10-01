// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountPolicyForm } from './account-policy-form';
import { accountPolicySchema, type AccountSummary } from './src/contracts.js';
afterEach(cleanup);
const account = { provider: 'codex', fiveHourUtilization: null, limitWindows: [], role: 'primary', policy: accountPolicySchema.parse({ enabled: true, weeklyKeep:50 }) } as unknown as AccountSummary;
it('saves disabled override without losing personal values and hides absent five-hour quota', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<AccountPolicyForm account={account} threshold={.98} drainHours={24} save={save} />);
  expect(screen.queryByText('Оставлять квоту 5 часов, %')).toBeNull();
  fireEvent.click(screen.getByLabelText('Индивидуальные настройки'));

  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ enabled:false, weeklyKeep:50 })));
  await screen.findByText('Настройки сохранены');
});
it('retains draft and displays failure instead of claiming save succeeded', async () => {
  const save = vi.fn().mockRejectedValue(new Error('offline'));
  render(<AccountPolicyForm account={account} threshold={.98} drainHours={24} save={save} />);
  fireEvent.change(screen.getByDisplayValue('50'), { target: { value: '60' } });
  await screen.findByRole('alert');
  expect(screen.queryByText('Настройки сохранены')).toBeNull();
  expect(screen.getByDisplayValue('60')).toBeTruthy();
});

it('coalesces edits, does not save on mount, and retries failed changes', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  render(<AccountPolicyForm account={account} threshold={.98} drainHours={24} save={save} />);
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByText('Сохранить настройки')).toBeNull();
  fireEvent.change(screen.getByDisplayValue('50'), { target: { value: '40' } });
  fireEvent.change(screen.getByDisplayValue('40'), { target: { value: '30' } });
  await screen.findByRole('alert');
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ weeklyKeep: 30 }));
  fireEvent.click(screen.getByText('Повторить сохранение'));
  await screen.findByText('Настройки сохранены');
  expect(save).toHaveBeenCalledTimes(2);
});

it('keeps dismissal guarded until save succeeds or edits are explicitly discarded', async () => {
  const save = vi.fn().mockRejectedValue(new Error('offline'));
  const guard = vi.fn();
  render(<AccountPolicyForm account={account} threshold={.98} drainHours={24} save={save} onUnsavedChange={guard} />);
  fireEvent.change(screen.getByDisplayValue('50'), { target: { value: '20' } });
  expect(guard).toHaveBeenLastCalledWith(true);
  await screen.findByRole('alert');
  expect(guard).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByText('Отменить изменения'));
  expect(guard).toHaveBeenLastCalledWith(false);
  expect(screen.getByDisplayValue('50')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
