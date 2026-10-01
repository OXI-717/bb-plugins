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
  fireEvent.click(screen.getByText('Сохранить настройки'));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ enabled:false, weeklyKeep:50 })));
  await screen.findByText('Настройки сохранены');
});
it('retains draft and displays failure instead of claiming save succeeded', async () => {
  const save = vi.fn().mockRejectedValue(new Error('offline'));
  render(<AccountPolicyForm account={account} threshold={.98} drainHours={24} save={save} />);
  fireEvent.click(screen.getByText('Сохранить настройки'));
  await screen.findByRole('alert');
  expect(screen.queryByText('Настройки сохранены')).toBeNull();
  expect(screen.getByDisplayValue('50')).toBeTruthy();
});
