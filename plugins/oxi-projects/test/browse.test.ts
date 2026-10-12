import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASSIGNEE_AVATAR_TONES,
  DEFAULT_WORKFLOW_STATUS_ORDER,
  NO_LABELS_FILTER,
  NO_PRIORITY_FILTER,
  NO_PROJECT_FILTER,
  UNASSIGNED_ASSIGNEE_FILTER,
  assigneeAvatarIdentity,
  assigneeFilterOptions,
  canonicalizeSelectedFilterOptions,
  filterOptionIdentity,
  filterWorkItemsByAttributes,
  filterWorkItemsByAssignee,
  isFilterOptionSelected,
  labelFilterOptions,
  priorityFilterOptions,
  projectFilterOptions,
  sortWorkItemsByWorkflow,
  statusFilterOptions,
  toggleFilterOptionSelection,
  workflowStatusTone,
  workflowStatusGroups,
  workflowStatusLanes
} from '../browse.ts';
import type {
  WorkItem,
  WorkStateCategory,
  WorkStatusOption
} from '../contract.ts';

test('derives stable Unicode-safe assignee avatar identities', () => {
  const mateo = assigneeAvatarIdentity('  Mateo   Cerquetella  ');
  const normalizedMateo = assigneeAvatarIdentity('mateo cerquetella');

  assert.equal(mateo.initials, 'MC');
  assert.equal(mateo.tone, 'violet');
  assert.equal(mateo.tone, normalizedMateo.tone);
  assert.ok(ASSIGNEE_AVATAR_TONES.includes(mateo.tone));
  assert.deepEqual(assigneeAvatarIdentity('Élodie 王').initials, 'É王');
  assert.equal(assigneeAvatarIdentity('ßeta Müller').initials, 'SM');
  assert.equal(assigneeAvatarIdentity('— 💫').initials, '?');
  assert.deepEqual(
    assigneeAvatarIdentity('Henrique Neves da Silva'),
    assigneeAvatarIdentity('Henrique Neves da Silva')
  );
});

function item(
  key: string,
  status: string,
  stateCategory: WorkStateCategory,
  assignee: string | null = 'Mateo'
): WorkItem {
  return {
    bbProjectId: 'proj_test',
    source: 'linear',
    locator: key,
    key,
    title: key,
    description: '',
    url: `https://linear.app/example/issue/${key}`,
    status,
    stateCategory,
    priority: null,
    assignee,
    project: 'Example',
    labels: [],
    updatedAt: '2026-08-13T12:00:00.000Z'
  };
}

test('uses the backlog-first default before provider-specific states', () => {
  const items = [
    item('DONE-1', 'Done', 'done'),
    item('TRIAGE-1', 'Triage', 'todo'),
    item('BACKLOG-1', 'Backlog', 'backlog'),
    item('TODO-1', 'Todo', 'todo'),
    item('QA-1', 'QA', 'in_progress'),
    item('BLOCKED-1', 'Blocked', 'todo'),
    item('PROGRESS-1', 'In Progress', 'in_progress'),
    item('REVIEW-1', 'In Review', 'in_progress')
  ];

  assert.deepEqual(
    sortWorkItemsByWorkflow(items).map(workItem => workItem.status),
    [
      'Backlog',
      'Todo',
      'In Progress',
      'In Review',
      'QA',
      'Blocked',
      'Triage',
      'Done'
    ]
  );
  assert.deepEqual(
    workflowStatusGroups(items).map(group => group.name),
    [
      'Backlog',
      'Todo',
      'In Progress',
      'In Review',
      'QA',
      'Blocked',
      'Triage',
      'Done'
    ]
  );
});

test('defines the complete backlog-first default status order', () => {
  assert.deepEqual(DEFAULT_WORKFLOW_STATUS_ORDER, [
    'Backlog',
    'Todo',
    'In Progress',
    'In Review',
    'QA',
    'Ready for Release',
    'Blocked',
    'Duplicate',
    'Done',
    'Canceled'
  ]);
});

test('builds case-insensitive assignee choices including Unassigned', () => {
  const items = [
    item('ONE', 'Todo', 'todo', 'Mateo Cerquetella'),
    item('TWO', 'Todo', 'todo', 'mateo cerquetella'),
    item('THREE', 'Todo', 'todo', 'Sam Rivera'),
    item('FOUR', 'Todo', 'todo', null),
    item('FIVE', 'Todo', 'todo', 'Unassigned')
  ];

  assert.deepEqual(assigneeFilterOptions(items), [
    { value: 'Mateo Cerquetella', label: 'Mateo Cerquetella' },
    { value: 'Sam Rivera', label: 'Sam Rivera' },
    { value: UNASSIGNED_ASSIGNEE_FILTER, label: 'Unassigned' }
  ]);
  assert.deepEqual(
    filterWorkItemsByAssignee(items, ['MATEO CERQUETELLA']).map(
      workItem => workItem.key
    ),
    ['ONE', 'TWO']
  );
  assert.deepEqual(
    filterWorkItemsByAssignee(items, [UNASSIGNED_ASSIGNEE_FILTER]).map(
      workItem => workItem.key
    ),
    ['FOUR', 'FIVE']
  );
});

test('keeps selected assignees available when other filters return no items', () => {
  assert.deepEqual(assigneeFilterOptions([], ['Mateo Cerquetella']), [
    { value: 'Mateo Cerquetella', label: 'Mateo Cerquetella' }
  ]);
});

test('canonicalizes facet selections and toggles every case variant', () => {
  const options = [
    { value: 'In Review', label: 'In Review' },
    { value: 'Mateo', label: 'Mateo' }
  ];

  assert.equal(
    filterOptionIdentity('IN REVIEW'),
    filterOptionIdentity('In Review')
  );
  assert.deepEqual(
    canonicalizeSelectedFilterOptions(
      ['in review', 'IN REVIEW', 'Legacy value', 'LEGACY VALUE'],
      options
    ),
    ['In Review', 'Legacy value']
  );
  assert.equal(isFilterOptionSelected(['IN REVIEW'], 'In Review'), true);
  assert.equal(isFilterOptionSelected(['Todo'], 'In Review'), false);
  assert.deepEqual(
    toggleFilterOptionSelection(
      ['IN REVIEW', 'in review', 'Legacy value'],
      'In Review'
    ),
    ['Legacy value']
  );
  assert.deepEqual(
    toggleFilterOptionSelection(['Legacy value'], 'In Review'),
    ['Legacy value', 'In Review']
  );
});

test('uses a configurable exact workflow order', () => {
  const items = [
    item('TODO', 'Todo', 'todo'),
    item('REVIEW', 'In Review', 'in_progress'),
    item('BLOCKED', 'Blocked', 'todo')
  ];

  assert.deepEqual(
    sortWorkItemsByWorkflow(items, ['Blocked', 'Todo', 'In Review']).map(
      workItem => workItem.status
    ),
    ['Blocked', 'Todo', 'In Review']
  );
});

test('keeps the complete provider workflow ordered before and after a move', () => {
  const items = [
    item('REVIEW', 'In Review', 'in_progress'),
    item('BACKLOG', 'Backlog', 'backlog')
  ];
  const statuses: WorkStatusOption[] = (
    [
      ['Ready for Release', 'in_progress'],
      ['QA', 'in_progress'],
      ['In Progress', 'in_progress'],
      ['Canceled', 'canceled'],
      ['Done', 'done'],
      ['Backlog', 'backlog'],
      ['Todo', 'todo'],
      ['In Review', 'in_progress'],
      ['Duplicate', 'todo']
    ] satisfies Array<[string, WorkStateCategory]>
  ).map(([name, stateCategory], index) => ({
    id: `status-${index}`,
    name,
    stateCategory,
    current: name === 'In Review'
  }));
  const expected = [
    'Backlog',
    'Todo',
    'In Progress',
    'In Review',
    'QA',
    'Ready for Release',
    'Duplicate',
    'Done',
    'Canceled'
  ];

  assert.deepEqual(
    workflowStatusLanes(items, statuses).map(lane => lane.name),
    expected
  );
  assert.deepEqual(
    workflowStatusLanes(
      items.map(workItem =>
        workItem.key === 'REVIEW'
          ? {
              ...workItem,
              status: 'In Progress',
              stateCategory: 'in_progress'
            }
          : workItem
      ),
      statuses
    ).map(lane => lane.name),
    expected
  );
  const customOrder = [
    'Backlog',
    'Todo',
    'In Progress',
    'In Review',
    'QA',
    'Ready for Release',
    'Done',
    'Canceled',
    'Duplicate'
  ];
  assert.deepEqual(
    workflowStatusLanes(items, statuses, customOrder).map(lane => lane.name),
    customOrder
  );
});

test('assigns distinct stable tones to the active workflow statuses', () => {
  const statuses: readonly [string, WorkStateCategory][] = [
    ['In Review', 'in_progress'],
    ['In Progress', 'in_progress'],
    ['Blocked', 'todo'],
    ['QA', 'in_progress'],
    ['Todo', 'todo'],
    ['Duplicate', 'todo'],
    ['Triage', 'todo'],
    ['Backlog', 'backlog'],
    ['Done', 'done'],
    ['Canceled', 'canceled']
  ];
  const tones = statuses.map(([name, category]) =>
    workflowStatusTone(name, category)
  );

  assert.equal(new Set(tones).size, statuses.length);
  assert.equal(
    workflowStatusTone('Provider custom state', 'todo'),
    workflowStatusTone('Provider custom state', 'todo')
  );
});

test('builds Linear-style field options including empty values', () => {
  const urgent = {
    ...item('URGENT', 'In Review', 'in_progress', 'Mateo'),
    priority: 'Urgent',
    project: 'Website',
    labels: ['Bug', 'Customer']
  };
  const empty = {
    ...item('EMPTY', 'Todo', 'todo', null),
    priority: null,
    project: null,
    labels: []
  };
  const high = {
    ...item('HIGH', 'Blocked', 'todo', 'Sam'),
    priority: 'High',
    project: 'Mobile',
    labels: ['bug']
  };
  const items = [urgent, empty, high];

  assert.deepEqual(statusFilterOptions(items).map(option => option.label), [
    'Todo',
    'In Review',
    'Blocked'
  ]);
  assert.deepEqual(priorityFilterOptions(items), [
    { value: 'Urgent', label: 'Urgent' },
    { value: 'High', label: 'High' },
    { value: NO_PRIORITY_FILTER, label: 'No priority' }
  ]);
  assert.deepEqual(projectFilterOptions(items), [
    { value: 'Mobile', label: 'Mobile' },
    { value: 'Website', label: 'Website' },
    { value: NO_PROJECT_FILTER, label: 'No project' }
  ]);
  assert.deepEqual(labelFilterOptions(items), [
    { value: 'Bug', label: 'Bug' },
    { value: 'Customer', label: 'Customer' },
    { value: NO_LABELS_FILTER, label: 'No labels' }
  ]);
});

test('combines different filter fields with AND and values within a field with OR', () => {
  const items = [
    {
      ...item('MATCH', 'In Review', 'in_progress', 'Mateo'),
      priority: 'Urgent',
      project: 'Website',
      labels: ['Bug']
    },
    {
      ...item('WRONG-ASSIGNEE', 'In Review', 'in_progress', 'Sam'),
      priority: 'Urgent',
      project: 'Website',
      labels: ['Bug']
    },
    {
      ...item('NO-METADATA', 'Todo', 'todo', null),
      priority: null,
      project: null,
      labels: []
    }
  ];

  assert.deepEqual(
    filterWorkItemsByAttributes(items, {
      statuses: ['in review', 'Blocked'],
      assignees: ['MATEO'],
      priorities: ['urgent'],
      projects: ['website'],
      labels: ['bug']
    }).map(workItem => workItem.key),
    ['MATCH']
  );
  assert.deepEqual(
    filterWorkItemsByAttributes(items, {
      statuses: [],
      assignees: [UNASSIGNED_ASSIGNEE_FILTER],
      priorities: [NO_PRIORITY_FILTER],
      projects: [NO_PROJECT_FILTER],
      labels: [NO_LABELS_FILTER]
    }).map(workItem => workItem.key),
    ['NO-METADATA']
  );
});
