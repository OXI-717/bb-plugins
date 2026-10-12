import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACROSS_PROJECTS_SCOPE,
  BROWSE_PREFERENCES_VERSION,
  MAX_BROWSE_QUERY_LENGTH,
  browsePreferenceStorageKey,
  clearBrowseFilters,
  createAssigneeScope,
  createAssigneeStorageKey,
  createBrowsePreferenceStore,
  defaultBrowsePreferences,
  isGroupCollapsed,
  parseBrowsePreferencesJson,
  projectBrowseScope,
  readRememberedCreateAssignee,
  reconcileBrowseProvider,
  rememberCreateAssignee,
  rememberCreateAssigneeAfterSuccess,
  restoreRememberedCreateAssignee,
  setGroupCollapsedOverride,
  toggleGroupCollapsedOverride,
  type PreferenceStorage
} from '../browse-preferences.ts';

class MemoryStorage implements PreferenceStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class ThrowingStorage implements PreferenceStorage {
  getItem(): string | null {
    throw new Error('storage unavailable');
  }

  setItem(): void {
    throw new Error('storage unavailable');
  }

  removeItem(): void {
    throw new Error('storage unavailable');
  }
}

test('parses only strict version-1 browse records and normalizes values', () => {
  const valid = {
    version: BROWSE_PREFERENCES_VERSION,
    provider: 'linear',
    source: 'all',
    view: 'kanban',
    stateCategories: ['done', 'done'],
    statuses: ['  In Review  ', 'In Review'],
    assignees: ['Mateo'],
    priorities: [],
    externalProjects: [],
    labels: ['frontend'],
    collapsedGroups: { 'done:done': false }
  };

  assert.deepEqual(parseBrowsePreferencesJson(JSON.stringify(valid)), {
    ...valid,
    query: '',
    stateCategories: ['done'],
    statuses: ['In Review']
  });

  assert.equal(
    parseBrowsePreferencesJson(
      JSON.stringify({ ...valid, query: 'a'.repeat(MAX_BROWSE_QUERY_LENGTH) })
    ).query.length,
    MAX_BROWSE_QUERY_LENGTH
  );

  const fallback = defaultBrowsePreferences({
    provider: 'jira',
    view: 'kanban'
  });
  assert.deepEqual(
    parseBrowsePreferencesJson(
      JSON.stringify({ ...valid, version: 2 }),
      fallback
    ),
    fallback
  );
  assert.deepEqual(
    parseBrowsePreferencesJson(
      JSON.stringify({ ...valid, unexpected: true }),
      fallback
    ),
    fallback
  );
  assert.deepEqual(parseBrowsePreferencesJson('{nope', fallback), fallback);
  assert.deepEqual(
    parseBrowsePreferencesJson(
      JSON.stringify({
        ...valid,
        query: 'a'.repeat(MAX_BROWSE_QUERY_LENGTH + 1)
      }),
      fallback
    ),
    fallback
  );
});

test('restores project and Across-project preferences without scope leakage', () => {
  const storage = new MemoryStorage();
  const projectA = projectBrowseScope('proj_a');
  const projectB = projectBrowseScope('proj_b');
  const writer = createBrowsePreferenceStore({ storage });

  writer.update(projectA, current => ({
    ...current,
    provider: 'linear',
    query: 'project A search',
    assignees: ['Mateo'],
    statuses: ['In Review']
  }));
  writer.update(projectB, current => ({
    ...current,
    provider: 'github',
    query: 'project B search',
    view: 'kanban'
  }));
  writer.update(ACROSS_PROJECTS_SCOPE, current => ({
    ...current,
    source: 'jira',
    query: 'across search',
    labels: ['backend']
  }));

  const reloaded = createBrowsePreferenceStore({ storage });
  assert.deepEqual(reloaded.get(projectA).assignees, ['Mateo']);
  assert.equal(reloaded.get(projectA).query, 'project A search');
  assert.deepEqual(reloaded.get(projectA).statuses, ['In Review']);
  assert.equal(reloaded.get(projectB).view, 'kanban');
  assert.equal(reloaded.get(projectB).query, 'project B search');
  assert.deepEqual(reloaded.get(projectB).assignees, []);
  assert.equal(reloaded.get(ACROSS_PROJECTS_SCOPE).source, 'jira');
  assert.equal(reloaded.get(ACROSS_PROJECTS_SCOPE).query, 'across search');
  assert.deepEqual(reloaded.get(ACROSS_PROJECTS_SCOPE).labels, ['backend']);
});

test('restores collapsed groups from storage with the rest of a project view', () => {
  const storage = new MemoryStorage();
  const scope = projectBrowseScope('proj_collapsed');
  const writer = createBrowsePreferenceStore({ storage });
  writer.update(scope, current => ({
    ...current,
    collapsedGroups: {
      'todo:blocked': true,
      'done:done': false
    }
  }));

  const reloaded = createBrowsePreferenceStore({ storage });
  assert.deepEqual(reloaded.get(scope).collapsedGroups, {
    'todo:blocked': true,
    'done:done': false
  });
});

test('board-setting seeds initialize only untouched preference scopes', () => {
  const storage = new MemoryStorage();
  const storedScope = projectBrowseScope('proj_stored_seed');
  storage.setItem(
    browsePreferenceStorageKey(storedScope),
    JSON.stringify(defaultBrowsePreferences({ view: 'kanban' }))
  );
  const store = createBrowsePreferenceStore({ storage });

  const stored = store.get(storedScope);
  assert.equal(store.seed(storedScope, { view: 'list' }), stored);
  assert.equal(store.get(storedScope).view, 'kanban');

  const untouchedScope = projectBrowseScope('proj_untouched_seed');
  store.get(untouchedScope);
  assert.equal(store.seed(untouchedScope, { view: 'kanban' }).view, 'kanban');

  const updatedScope = projectBrowseScope('proj_updated_seed');
  store.update(updatedScope, current => ({ ...current, view: 'kanban' }));
  store.seed(updatedScope, { view: 'list' });
  assert.equal(store.get(updatedScope).view, 'kanban');
});

test('storage failures fall back safely while in-window updates remain usable', () => {
  const scope = projectBrowseScope('proj_storage_failure');
  const store = createBrowsePreferenceStore({
    storage: new ThrowingStorage()
  });

  assert.deepEqual(
    store.get(scope, { provider: 'github', view: 'kanban' }),
    defaultBrowsePreferences({ provider: 'github', view: 'kanban' })
  );
  assert.doesNotThrow(() => {
    store.update(scope, current => ({ ...current, labels: ['still works'] }));
  });
  assert.deepEqual(store.get(scope).labels, ['still works']);
  assert.doesNotThrow(() => store.reset(scope));
});

test('one observable store notifies every surface and reloads external writes', () => {
  const storage = new MemoryStorage();
  const scope = projectBrowseScope('proj_shared');
  let externalListener: ((key: string | null) => void) | undefined;
  const store = createBrowsePreferenceStore({
    storage,
    subscribeToStorage(listener) {
      externalListener = listener;
      return () => {
        externalListener = undefined;
      };
    }
  });
  let fullNotifications = 0;
  let rightNotifications = 0;
  store.subscribe(scope, () => fullNotifications++);
  store.subscribe(scope, () => rightNotifications++);

  store.update(scope, current => ({ ...current, priorities: ['High'] }));
  assert.equal(fullNotifications, 1);
  assert.equal(rightNotifications, 1);
  assert.deepEqual(store.get(scope).priorities, ['High']);

  const external = {
    ...defaultBrowsePreferences({ provider: 'github' }),
    labels: ['external']
  };
  storage.setItem(browsePreferenceStorageKey(scope), JSON.stringify(external));
  externalListener?.(browsePreferenceStorageKey(scope));
  assert.equal(fullNotifications, 2);
  assert.equal(rightNotifications, 2);
  assert.deepEqual(store.get(scope).labels, ['external']);
});

test('structurally equal writes keep a stable snapshot and do not notify', () => {
  const scope = projectBrowseScope('proj_equal');
  const store = createBrowsePreferenceStore({ storage: new MemoryStorage() });
  const initial = store.get(scope);
  let notifications = 0;
  store.subscribe(scope, () => notifications++);

  const returned = store.set(scope, { ...initial });
  assert.equal(returned, initial);
  assert.equal(store.get(scope), initial);
  assert.equal(notifications, 0);
});

test('clearing filters changes only the active scope and preserves its view and collapse state', () => {
  const storage = new MemoryStorage();
  const projectA = projectBrowseScope('proj_a');
  const projectB = projectBrowseScope('proj_b');
  const store = createBrowsePreferenceStore({ storage });
  const populated = {
    ...defaultBrowsePreferences({ provider: 'linear', view: 'kanban' }),
    source: 'linear' as const,
    query: 'release',
    stateCategories: ['done' as const],
    statuses: ['Done'],
    assignees: ['Mateo'],
    priorities: ['High'],
    externalProjects: ['Platform'],
    labels: ['bug'],
    collapsedGroups: { 'done:done': false }
  };
  store.set(projectA, populated);
  store.update(projectB, current => ({
    ...current,
    query: 'keep query',
    labels: ['keep']
  }));

  const cleared = store.clearFilters(projectA);
  assert.deepEqual(cleared, {
    ...populated,
    source: 'all',
    query: '',
    stateCategories: [],
    statuses: [],
    assignees: [],
    priorities: [],
    externalProjects: [],
    labels: []
  });
  assert.equal(cleared.view, 'kanban');
  assert.deepEqual(cleared.collapsedGroups, { 'done:done': false });
  assert.deepEqual(store.get(projectB).labels, ['keep']);
  assert.equal(store.get(projectB).query, 'keep query');
  assert.deepEqual(clearBrowseFilters(populated), cleared);
});

test('provider reconciliation preserves view but drops provider-derived state', () => {
  const current = {
    ...defaultBrowsePreferences({ provider: 'linear', view: 'kanban' }),
    source: 'linear' as const,
    query: 'provider-specific search',
    statuses: ['In Review'],
    assignees: ['Mateo'],
    priorities: ['Urgent'],
    externalProjects: ['Mobile'],
    labels: ['linear-label'],
    collapsedGroups: { 'done:done': false }
  };

  assert.deepEqual(reconcileBrowseProvider(current, 'github'),
    defaultBrowsePreferences({ provider: 'github', view: 'kanban' }));
  const alreadyCurrent = reconcileBrowseProvider(current, 'linear');
  assert.deepEqual(alreadyCurrent, current);
});

test('terminal collapse defaults use sparse overrides and search opens matches temporarily', () => {
  assert.equal(
    isGroupCollapsed({
      overrides: {},
      groupKey: 'done:done',
      category: 'done'
    }),
    true
  );
  assert.equal(
    isGroupCollapsed({
      overrides: {},
      groupKey: 'todo:todo',
      category: 'todo'
    }),
    false
  );

  const opened = toggleGroupCollapsedOverride({}, 'done:done', 'done');
  assert.deepEqual(opened, { 'done:done': false });
  assert.equal(
    isGroupCollapsed({
      overrides: opened,
      groupKey: 'done:done',
      category: 'done'
    }),
    false
  );
  assert.deepEqual(
    setGroupCollapsedOverride(opened, 'done:done', 'done', true),
    {}
  );

  const explicitlyCollapsed = { 'todo:todo': true };
  assert.equal(
    isGroupCollapsed({
      overrides: explicitlyCollapsed,
      groupKey: 'todo:todo',
      category: 'todo',
      searchActive: true,
      hasSearchMatch: true
    }),
    false
  );
  assert.equal(
    isGroupCollapsed({
      overrides: explicitlyCollapsed,
      groupKey: 'todo:todo',
      category: 'todo',
      searchActive: true,
      hasSearchMatch: false
    }),
    true
  );
});

test('create assignee defaults are versioned, fully scoped, and restored only from fresh options', () => {
  const storage = new MemoryStorage();
  const scope = createAssigneeScope(
    'proj_a',
    'jira',
    'PLATFORM',
    'Story'
  );
  rememberCreateAssignee(scope, 'account-42', storage);

  assert.equal(readRememberedCreateAssignee(scope, storage), 'account-42');
  assert.equal(
    restoreRememberedCreateAssignee(
      scope,
      [{ id: 'account-42' }, { id: 'account-99' }],
      storage
    ),
    'account-42'
  );
  assert.equal(
    restoreRememberedCreateAssignee(scope, [{ id: 'account-99' }], storage),
    null
  );

  for (const otherScope of [
    createAssigneeScope('proj_b', 'jira', 'PLATFORM', 'Story'),
    createAssigneeScope('proj_a', 'linear', 'PLATFORM', 'Story'),
    createAssigneeScope('proj_a', 'jira', 'MOBILE', 'Story'),
    createAssigneeScope('proj_a', 'jira', 'PLATFORM', 'Bug')
  ]) {
    assert.notEqual(
      createAssigneeStorageKey(otherScope),
      createAssigneeStorageKey(scope)
    );
    assert.equal(readRememberedCreateAssignee(otherScope, storage), null);
  }

  storage.setItem(
    createAssigneeStorageKey(scope),
    JSON.stringify({ version: 2, assigneeId: 'stale' })
  );
  assert.equal(readRememberedCreateAssignee(scope, storage), null);

  rememberCreateAssignee(scope, 'account-42', storage);
  rememberCreateAssignee(scope, null, storage);
  assert.equal(readRememberedCreateAssignee(scope, storage), null);
});

test('create assignee scope canonicalizes Jira project keys', () => {
  assert.deepEqual(createAssigneeScope('proj_a', 'jira', ' platform ', 'Story'), {
    projectId: 'proj_a',
    provider: 'jira',
    destinationId: 'PLATFORM',
    issueType: 'Story'
  });
  assert.equal(
    createAssigneeStorageKey(
      createAssigneeScope('proj_a', 'jira', 'platform', 'Story')
    ),
    createAssigneeStorageKey(
      createAssigneeScope('proj_a', 'jira', 'PLATFORM', 'Story')
    )
  );
});

test('remembers only provider-confirmed create assignees and clears confirmed unassigned scopes', async () => {
  const storage = new MemoryStorage();
  const submittedScope = createAssigneeScope(
    'proj_a',
    'linear',
    'ENG',
    null
  );
  const otherScope = createAssigneeScope(
    'proj_a',
    'linear',
    'OPS',
    null
  );
  rememberCreateAssignee(submittedScope, 'member-old', storage);
  rememberCreateAssignee(otherScope, 'member-other', storage);

  await assert.rejects(
    rememberCreateAssigneeAfterSuccess(
      Promise.reject(new Error('provider rejected creation')),
      submittedScope,
      'member-new',
      storage
    ),
    /provider rejected creation/u
  );
  assert.equal(
    readRememberedCreateAssignee(submittedScope, storage),
    'member-old'
  );

  const confirmed = {
    assigneeConfirmation: {
      confirmed: true as const,
      id: 'member-new'
    },
    item: { assignee: 'Member New' }
  };
  assert.equal(
    await rememberCreateAssigneeAfterSuccess(
      Promise.resolve(confirmed),
      submittedScope,
      'member-new',
      storage
    ),
    confirmed
  );
  assert.equal(
    readRememberedCreateAssignee(submittedScope, storage),
    'member-new'
  );

  await rememberCreateAssigneeAfterSuccess(
    Promise.resolve({
      assigneeConfirmation: { confirmed: false as const },
      item: { assignee: 'Provider default' }
    }),
    submittedScope,
    null,
    storage
  );
  assert.equal(
    readRememberedCreateAssignee(submittedScope, storage),
    'member-new'
  );

  await rememberCreateAssigneeAfterSuccess(
    Promise.resolve({
      assigneeConfirmation: { confirmed: true as const, id: null },
      item: { assignee: null }
    }),
    submittedScope,
    null,
    storage
  );
  assert.equal(readRememberedCreateAssignee(submittedScope, storage), null);
  assert.equal(
    readRememberedCreateAssignee(otherScope, storage),
    'member-other'
  );
});

test('keeps the prior assignee when a successful create omits the requested assignment', async () => {
  const storage = new MemoryStorage();
  const scope = createAssigneeScope('proj_a', 'github', 'owner/repo', null);
  rememberCreateAssignee(scope, 'member-old', storage);

  const partial = {
    assigneeConfirmation: { confirmed: true as const, id: null },
    item: { assignee: null }
  };
  assert.equal(
    await rememberCreateAssigneeAfterSuccess(
      Promise.resolve(partial),
      scope,
      'member-new',
      storage
    ),
    partial
  );
  assert.equal(readRememberedCreateAssignee(scope, storage), 'member-old');
});

test('scope helpers reject empty identities', () => {
  assert.throws(() => projectBrowseScope(''));
  assert.throws(() => createAssigneeScope('proj_a', 'github', '', null));
  assert.equal(projectBrowseScope('proj_valid'), 'project:proj_valid');
});

test('storage keys remain collision-free for delimiter and Unicode identities', () => {
  const browseKeys = ['proj:a', 'proj%3Aa', '项目:a'].map(projectId =>
    browsePreferenceStorageKey(projectBrowseScope(projectId))
  );
  assert.equal(new Set(browseKeys).size, browseKeys.length);

  const assigneeKeys = [
    createAssigneeScope('proj:a', 'jira', 'PLATFORM', 'Story:Bug'),
    createAssigneeScope('proj', 'jira', 'A:PLATFORM', 'Story:Bug'),
    createAssigneeScope('项目:a', 'jira', '平台', '故事')
  ].map(createAssigneeStorageKey);
  assert.equal(new Set(assigneeKeys).size, assigneeKeys.length);
});
