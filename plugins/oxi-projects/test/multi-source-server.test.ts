import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deferred,
  githubItem,
  startServer
} from './fake-bb.ts';

test('connected sources are synced independently', async () => {
  const { rpc, dispose } = await startServer({
    catalog: [{ id: 'e1', bbProjectId: 'proj_a', repos: ['o/r'] }]
  });
  try {
    await rpc.saveProjectSource({
      projectId: 'proj_a',
      source: 'linear',
      teamKey: 'DEMO',
      credential: { operation: 'set', value: 'k' }
    });
    const { sources } = (await rpc.listProjectSources({
      projectId: 'proj_a'
    })) as { sources: { source: string }[] };
    assert.deepEqual(sources.map(s => s.source), ['linear', 'github']); // github из bootstrap
    const status = (await rpc.status({ projectId: 'proj_a' })) as {
      sources: { source: string }[];
    };
    assert.deepEqual(status.sources.map(s => s.source), ['linear', 'github']);
  } finally {
    await dispose();
  }
});

test('project without sources returns empty lists', async () => {
  const { rpc, dispose } = await startServer({ catalog: [] });
  try {
    assert.deepEqual(
      ((await rpc.status({ projectId: 'proj_a' })) as { sources: unknown[] })
        .sources,
      []
    );
    assert.deepEqual(
      (
        (await rpc.listItems({ projectId: 'proj_a', limit: 10 })) as {
          providers: unknown[];
        }
      ).providers,
      []
    );
    const { context } = (await rpc.getCreateIssueContext({
      projectId: 'proj_a'
    })) as { context: { available: boolean } };
    assert.equal(context.available, false);
  } finally {
    await dispose();
  }
});

test('disconnect during sync does not restore cache', async () => {
  const gate = deferred<unknown[]>();
  const { rpc, store, dispose } = await startServer({
    catalog: [{ id: 'e1', bbProjectId: 'proj_a', repos: ['o/r'] }],
    githubList: () => gate.promise
  });
  try {
    const refreshing = rpc.refresh({ projectId: 'proj_a', source: 'github' });
    await rpc.disconnectProjectSource({ projectId: 'proj_a', source: 'github' });
    gate.resolve([githubItem('o/r#1')]);
    await refreshing.catch(() => undefined);
    assert.deepEqual(store.list({ projectId: 'proj_a', limit: 10 }), []);
  } finally {
    await dispose();
  }
});

test('dedupes catalog repos across entries', async () => {
  const seen: string[][] = [];
  const { rpc, dispose } = await startServer({
    catalog: [
      { id: 'e1', bbProjectId: 'proj_a', repos: ['o/r'] },
      { id: 'e2', bbProjectId: 'proj_a', repos: ['O/R', 'o/s'] }
    ],
    onGithubRepos: repos => seen.push(repos)
  });
  try {
    await rpc.refresh({ projectId: 'proj_a', source: 'github' });
    assert.deepEqual(seen.at(-1)?.map(r => r.toLowerCase()).sort(), [
      'o/r',
      'o/s'
    ]);
  } finally {
    await dispose();
  }
});

test('refresh of a not connected source is rejected in Russian', async () => {
  const { rpc, dispose } = await startServer({ catalog: [] });
  try {
    await assert.rejects(
      rpc.refresh({ projectId: 'proj_a', source: 'jira' }),
      /Jira не подключена к проекту/
    );
  } finally {
    await dispose();
  }
});

const JIRA = {
  projectId: 'proj_a',
  source: 'jira',
  baseUrl: 'https://a.atlassian.net',
  cloudId: '',
  email: 'e@x',
  jql: 'project = DEMO'
} as const;
const LEGACY_DEFAULT_JQL =
  'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';

test('legacy saveProjectConfig applies each credential to its own source', async () => {
  const { rpc, dispose } = await startServer({ catalog: [] });
  try {
    await rpc.saveProjectSource({
      ...JIRA,
      credential: { operation: 'set', value: 'jira-token' }
    });
    await rpc.saveProjectSource({
      projectId: 'proj_a',
      source: 'linear',
      teamKey: 'DEMO',
      credential: { operation: 'set', value: 'linear-key' }
    });
    await rpc.saveProjectConfig({
      projectId: 'proj_a',
      source: 'linear',
      linearTeamKey: 'DEMO',
      jiraBaseUrl: '',
      jiraEmail: '',
      jiraJql: LEGACY_DEFAULT_JQL,
      linearCredential: { operation: 'keep' },
      jiraCredential: { operation: 'clear' }
    });
    const { sources } = (await rpc.listProjectSources({
      projectId: 'proj_a'
    })) as { sources: { source: string; credentialConfigured: boolean }[] };
    assert.equal(
      sources.find(s => s.source === 'linear')?.credentialConfigured,
      true
    );
    assert.equal(
      sources.find(s => s.source === 'jira')?.credentialConfigured,
      false
    );
  } finally {
    await dispose();
  }
});

test('jira retarget clears the token before persisting the new destination', async () => {
  const order: string[] = [];
  (globalThis as { __oxiProjectsOrder?: string[] }).__oxiProjectsOrder =
    order;
  const { rpc, dispose } = await startServer({ catalog: [] });
  try {
    await rpc.saveProjectSource({
      ...JIRA,
      credential: { operation: 'set', value: 'old-token' }
    });
    order.length = 0;
    await rpc.saveProjectSource({
      ...JIRA,
      baseUrl: 'https://b.atlassian.net',
      credential: { operation: 'set', value: 'new-token' }
    });
    assert.deepEqual(order, ['secret:clear', 'store:save', 'secret:set']);
  } finally {
    await dispose();
  }
});


test('jira keep-token save cannot change address, email or cloudId', async () => {
  const { rpc, dispose } = await startServer({ catalog: [] });
  try {
    await rpc.saveProjectSource({
      ...JIRA,
      credential: { operation: 'set', value: 'jira-token' }
    });
    await assert.rejects(
      rpc.saveProjectSource({
        ...JIRA,
        baseUrl: 'https://b.atlassian.net',
        credential: { operation: 'keep' }
      }),
      /Смена адреса, email или cloudId Jira требует нового токена/
    );
    await assert.rejects(
      rpc.saveProjectSource({
        ...JIRA,
        cloudId: '11111111-2222-4333-8444-555555555555',
        credential: { operation: 'keep' }
      }),
      /требует нового токена/
    );
  } finally {
    await dispose();
  }
});

test('legacy saveProjectConfig keeps the stored jira cloudId', async () => {
  const { rpc, dispose } = await startServer({ catalog: [] });
  try {
    await rpc.saveProjectSource({
      ...JIRA,
      cloudId: '11111111-2222-4333-8444-555555555555',
      credential: { operation: 'set', value: 'jira-token' }
    });
    await rpc.saveProjectConfig({
      projectId: 'proj_a',
      source: 'jira',
      linearTeamKey: '',
      jiraBaseUrl: 'https://a.atlassian.net',
      jiraEmail: 'e@x',
      jiraJql: 'project = DEMO',
      linearCredential: { operation: 'keep' },
      jiraCredential: { operation: 'keep' }
    });
    const { sources } = (await rpc.listProjectSources({
      projectId: 'proj_a'
    })) as { sources: { source: string; cloudId?: string }[] };
    assert.equal(
      sources.find(s => s.source === 'jira')?.cloudId,
      '11111111-2222-4333-8444-555555555555'
    );
  } finally {
    await dispose();
  }
});

test('identical save keeps the cached items of that source', async () => {
  const { rpc, store, dispose } = await startServer({
    catalog: [{ id: 'e1', bbProjectId: 'proj_a', repos: ['o/r'] }]
  });
  try {
    await rpc.saveProjectSource({
      ...JIRA,
      credential: { operation: 'set', value: 'jira-token' }
    });
    store.replaceSource(
      'proj_a',
      'jira',
      [
        {
          bbProjectId: 'proj_a',
          source: 'jira',
          locator: 'DEMO-1',
          key: 'DEMO-1',
          title: 'x',
          description: '',
          url: 'https://a.atlassian.net/browse/DEMO-1',
          status: 'Open',
          stateCategory: 'todo',
          priority: null,
          assignee: null,
          project: 'DEMO',
          labels: [],
          updatedAt: '2026-09-25T00:00:00.000Z'
        }
      ],
      '2026-09-25T00:00:00.000Z'
    );
    await rpc.saveProjectSource({
      ...JIRA,
      credential: { operation: 'keep' }
    });
    assert.equal(store.list({ projectId: 'proj_a', limit: 10 }).length, 1);
    assert.equal(
      store.syncState('proj_a', 'jira').lastSyncedAt,
      '2026-09-25T00:00:00.000Z'
    );
  } finally {
    await dispose();
  }
});
