import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertExpectedConnectorRevision,
  assertExpectedIssueSource,
  createSafeIssueMetadataFailure,
  reconcileIssueCreation
} from '../create-issue.ts';
import type {
  ExternalWorkItemCreateResult,
  ExternalWorkItemDetail
} from '../sources/types.ts';
import { withoutComments } from '../sources/types.ts';
import { jiraProjectKeysFromJql } from '../sources/jira-scope.ts';

test('cached summaries never retain provider comments', () => {
  const detail: ExternalWorkItemDetail = {
    source: 'linear',
    locator: 'TASK-42',
    key: 'TASK-42',
    title: 'Polish the Taskboard release',
    description: 'Prepare the public launch.',
    url: 'https://linear.app/example/issue/TASK-42',
    status: 'In progress',
    stateCategory: 'in_progress',
    priority: 'High',
    assignee: 'Mateo',
    project: 'Taskboard',
    labels: ['release'],
    updatedAt: '2026-08-11T12:00:00.000Z',
    comments: [
      {
        author: 'Review bot',
        body: 'This stays in the live detail response only.',
        createdAt: '2026-08-11T12:05:00.000Z'
      }
    ]
  };

  const summary = withoutComments(detail);

  assert.equal('comments' in summary, false);
  assert.equal(summary.key, 'TASK-42');
  assert.deepEqual(summary.labels, ['release']);
});

test('provider creation results carry strict native assignee confirmation', () => {
  const result: ExternalWorkItemCreateResult = {
    item: {
      source: 'linear',
      locator: 'issue-42',
      key: 'TASK-42',
      title: 'Confirm native identity',
      description: '',
      url: 'https://linear.app/example/issue/TASK-42',
      status: 'Todo',
      stateCategory: 'todo',
      priority: null,
      assignee: null,
      project: 'Taskboard',
      labels: [],
      updatedAt: '2026-08-26T12:00:00.000Z',
      comments: []
    },
    warnings: [],
    assigneeConfirmation: { confirmed: true, id: null }
  };

  assert.deepEqual(result.assigneeConfirmation, {
    confirmed: true,
    id: null
  });
});

test('metadata failures expose only a fixed server-safe message', () => {
  const providerFailure = Object.assign(
    new Error(
      'Authorization token lin_api_secret failed for https://provider.invalid/options?api_token=url_query_secret and query project = PRIVATE'
    ),
    { stack: 'provider stack with lin_api_secret' }
  );
  const safe = createSafeIssueMetadataFailure('linear', providerFailure);

  assert.equal(
    safe.error.safeMessage,
    'Linear could not load issue creation options. Check the connection and try again.'
  );
  assert.equal(safe.error.code, 'metadata_unavailable');
  assert.doesNotMatch(
    JSON.stringify(safe),
    /lin_api_secret|url_query_secret|provider\.invalid|PRIVATE|Authorization token|provider stack/u
  );
  assert.deepEqual(Object.keys(safe).sort(), ['error', 'ok']);
  assert.deepEqual(Object.keys(safe.error).sort(), ['code', 'safeMessage']);
});

test('finds Jira project keys from common configured JQL scopes', () => {
  assert.deepEqual(
    jiraProjectKeysFromJql(
      'project = eng OR project in ("Web", mobile) ORDER BY updated DESC'
    ),
    ['ENG', 'WEB', 'MOBILE']
  );
  assert.deepEqual(
    jiraProjectKeysFromJql(
      'assignee = currentUser() AND resolution = Unresolved'
    ),
    []
  );
  assert.deepEqual(jiraProjectKeysFromJql('project = "Engineering Team"'), []);
});

test('binds issue creation to the tracker reviewed in the modal', () => {
  assert.equal(assertExpectedIssueSource('linear', 'linear'), 'linear');
  assert.throws(
    () => assertExpectedIssueSource('linear', 'jira'),
    /changed from Linear to Jira/u
  );
  assert.equal(assertExpectedConnectorRevision(4, 4, 'jira'), 4);
  assert.throws(
    () => assertExpectedConnectorRevision(4, 5, 'jira'),
    /Jira connection changed/u
  );
});

test('refreshes authoritative provider data after successful issue creation', async () => {
  const refreshModes: boolean[] = [];

  await reconcileIssueCreation(Promise.resolve('created'), async forceRefresh => {
    refreshModes.push(forceRefresh);
  });

  assert.deepEqual(refreshModes, [true]);
});

test('refreshes authoritative provider data after ambiguous issue creation failure', async () => {
  const refreshModes: boolean[] = [];

  await reconcileIssueCreation(
    Promise.reject(new Error('creation failed')),
    async forceRefresh => {
      refreshModes.push(forceRefresh);
    }
  );

  assert.deepEqual(refreshModes, [true]);
});
