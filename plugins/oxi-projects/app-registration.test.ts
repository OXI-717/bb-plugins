// @vitest-environment jsdom
import {expect, it} from 'vitest';
import {loadPluginApp} from '@get-bb/plugin-sdk/testing/app';

it('keeps new-thread compose free of project homepage sections while retaining project entry points', async () => {
  const app = await loadPluginApp(() => import('./app'));

  // The host renders section titles even when the component returns null.
  expect(app.homepageSections).toEqual([]);
  expect(app.navPanels.some(panel => panel.id === 'taskboard')).toBe(true);
  expect(app.threadPanelActions.some(action => action.id === 'project-task-detail')).toBe(true);
  expect(app.newThreadPanelActions).toHaveLength(1);
});
