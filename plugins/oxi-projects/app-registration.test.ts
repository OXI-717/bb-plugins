// @vitest-environment jsdom
import {expect, it} from 'vitest';
import {loadPluginApp} from '@get-bb/plugin-sdk/testing/app';

// Load the full entrypoint as fixture setup, outside the timed assertions.
// loadPluginApp installs the pinned SDK's runtime before importing the app.
const app = await loadPluginApp(() => import('./app'));

it('keeps new-thread compose free of project homepage sections while retaining project entry points', () => {
  // The host renders section titles even when the component returns null.
  expect(app.homepageSections).toEqual([]);
  expect(app.navPanels.some(panel => panel.id === 'taskboard')).toBe(true);
  expect(app.threadPanelActions.some(action => action.id === 'project-task-detail')).toBe(true);
  expect(app.threadPanelActions.some(action => action.id === 'taskboard-panel')).toBe(true);
  expect(app.newThreadPanelActions.map(action => action.id)).toEqual(['taskboard-new-thread-panel']);
});
