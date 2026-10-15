import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  availableContextProjectId,
  contextSelectionToken,
  previousProjectRouteContext,
  projectRouteContext,
  shouldApplyContextProject
} from '../project-selection.ts';

const projects = [
  { id: 'proj_alpha', name: 'Alpha' },
  { id: 'proj_beta', name: 'Beta' }
];

test('selects the active thread project only when it still exists', () => {
  assert.equal(
    availableContextProjectId(projects, 'proj_beta'),
    'proj_beta'
  );
  assert.equal(availableContextProjectId(projects, 'proj_missing'), null);
  assert.equal(availableContextProjectId(undefined, 'proj_beta'), null);
});

test('treats a different thread in the same project as new context', () => {
  assert.notEqual(
    contextSelectionToken('thread_one', 'proj_alpha', 'proj_alpha'),
    contextSelectionToken('thread_two', 'proj_alpha', 'proj_alpha')
  );
  assert.notEqual(
    contextSelectionToken('thread_one', 'proj_alpha', null),
    contextSelectionToken('thread_one', 'proj_alpha', 'proj_alpha')
  );
});

test('reads the project and thread from a BB project route', () => {
  assert.deepEqual(
    projectRouteContext(
      'https://bb.test/projects/proj_alpha/threads/thread_one',
      'https://bb.test'
    ),
    { projectId: 'proj_alpha', threadId: 'thread_one' }
  );
  assert.deepEqual(
    projectRouteContext(
      'https://bb.test/projects/proj_beta/settings',
      'https://bb.test'
    ),
    { projectId: 'proj_beta', threadId: null }
  );
  assert.equal(
    projectRouteContext(
      'https://another.test/projects/proj_alpha/threads/thread_one',
      'https://bb.test'
    ),
    null
  );
});

test('uses only the immediately previous navigation entry as source context', () => {
  const entries = [
    {
      index: 0,
      url: 'https://bb.test/projects/proj_alpha/threads/thread_one'
    },
    { index: 1, url: 'https://bb.test/settings' },
    { index: 2, url: 'https://bb.test/plugins/taskboard/tasks/proj_beta' }
  ];

  assert.equal(
    previousProjectRouteContext(entries, 2, 'https://bb.test'),
    null
  );
  assert.deepEqual(
    previousProjectRouteContext(entries, 1, 'https://bb.test'),
    { projectId: 'proj_alpha', threadId: 'thread_one' }
  );
});

test('never replaces an explicit Taskboard project selection with route context', () => {
  assert.equal(shouldApplyContextProject({ kind: 'root' }), true);
  assert.equal(
    shouldApplyContextProject({ kind: 'manage', projectId: null }),
    true
  );
  assert.equal(shouldApplyContextProject({ kind: 'all' }), false);
  assert.equal(
    shouldApplyContextProject({ kind: 'project', projectId: 'proj_beta' }),
    false
  );
  assert.equal(
    shouldApplyContextProject({ kind: 'manage', projectId: 'proj_beta' }),
    false
  );
  assert.equal(
    shouldApplyContextProject({ kind: 'item', projectId: 'proj_beta' }),
    false
  );
});
