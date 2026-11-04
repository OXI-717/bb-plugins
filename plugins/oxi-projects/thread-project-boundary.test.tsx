// @vitest-environment jsdom
import React from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, waitFor} from '@testing-library/react';
import {loadPluginApp, renderSlot} from '@get-bb/plugin-sdk/testing/app';

const {showError} = vi.hoisted(() => ({showError: vi.fn()}));
vi.mock('sonner', () => ({toast: {error: showError}}));
const app = await loadPluginApp(() => import('./app'));
const {ThreadProjectBoundary} = await import('./thread-project-boundary');
const panel = app.threadPanelActions.find(action => action.id === 'taskboard-panel')!;
const header = app.threadHeaderActions.find(action => action.id === 'open-taskboard-panel')!;
const refusal = () => Object.assign(new Error('Remote plugin refused'), {
  code: 'unknown_error', serverCode: 'federation_plugin_not_federated', status: 409
});
const context = {projectId: 'proj_example', threadId: 'thr_example'};
const probe = {component: ({threadId}: {threadId: string}) =>
  <ThreadProjectBoundary threadId={threadId} fallbackProjectId="proj_example">
    {projectId => <p>Loaded {projectId}</p>}
  </ThreadProjectBoundary>};
afterEach(() => {cleanup(); showError.mockReset(); localStorage.clear(); vi.useRealTimers();});

it('renders the actual remote thread panel as one quiet unavailable state', async () => {
  const slot = renderSlot(panel, {threadId: 'thr_example', params: null}, {
    context, rpc: {threadProject: () => {throw refusal();}}
  });
  await slot.findByText('Проект недоступен через федерацию');
  expect(slot.inspection.rpcCalls.map(call => call.method)).toEqual(['threadProject']);
  expect(showError).not.toHaveBeenCalled();
  expect(slot.queryByRole('button', {name: /try again|обновить/i})).toBeNull();
});

it('does not mount task loaders while resolving the project', async () => {
  let resolve!: (value: {projectId: string}) => void;
  const slot = renderSlot(probe, {threadId: 'thr_example'}, {
    rpc: {threadProject: () => new Promise(done => {resolve = done;})}
  });
  expect(slot.getByRole('status').textContent).toContain('Загрузка');
  expect(slot.queryByText(/Loaded/)).toBeNull();
  resolve({projectId: 'proj_resolved'});
  await slot.findByText('Loaded proj_resolved');
});

it('keeps ordinary errors visible and preserves local project fallback', async () => {
  const slot = renderSlot(probe, {threadId: 'thr_example'}, {
    rpc: {threadProject: () => {throw new Error('ordinary outage');}}
  });
  await slot.findByText('Loaded proj_example');
  expect(showError).toHaveBeenCalledOnce();
  expect(slot.queryByText('Проект недоступен через федерацию')).toBeNull();
});

it('ignores a stale refusal when switching to a local thread', async () => {
  let reject!: (error: Error) => void;
  const slot = renderSlot(probe, {threadId: 'thr_remote'}, {
    rpc: {threadProject: (input: {threadId: string}) => input.threadId === 'thr_remote'
      ? new Promise((_done, fail) => {reject = fail;}) : {projectId: 'proj_local'}}
  });
  slot.rerender(<probe.component threadId="thr_local"/>);
  await slot.findByText('Loaded proj_local');
  reject(refusal());
  await waitFor(() => expect(slot.queryByText('Проект недоступен через федерацию')).toBeNull());
  expect(showError).not.toHaveBeenCalled();
});

it.each([true, false])('restores a pinned panel only on a wide viewport (compact=%s)', async compact => {
  expect(header).toBeTruthy();
  localStorage.setItem('bb-taskboard:right-panel-pinned', 'true');
  vi.useFakeTimers();
  const slot = renderSlot(header, {...context, isCompactViewport: compact}, {openThreadPanel: () => true});
  await vi.runAllTimersAsync();
  expect(slot.inspection.navigateCalls.filter(call => call.method === 'openThreadPanel')).toHaveLength(compact ? 0 : 1);
  expect(localStorage.getItem('bb-taskboard:right-panel-pinned')).toBe('true');
});
