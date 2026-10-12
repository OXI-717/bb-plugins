import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && (specifier.endsWith('.js') || !specifier.match(/\.[a-z]+$/i))) {
      const sourceUrl = new URL(
        specifier.endsWith('.js') ? `${specifier.slice(0, -'.js'.length)}.ts` : `${specifier}.ts`,
        context.parentURL
      );
      if (existsSync(fileURLToPath(sourceUrl))) {
        return { shortCircuit: true, url: sourceUrl.href };
      }
    }
    return nextResolve(specifier, context);
  }
});

const { createWorkItemStore } = await import('../store.ts');
type StoreBb = Parameters<typeof createWorkItemStore>[0];
type WorkItemStore = ReturnType<typeof createWorkItemStore>;

function createStore(): { db: Database.Database; store: WorkItemStore } {
  const db = new Database(':memory:');
  const bb = {
    storage: {
      database: () => db,
      migrate(database: Database.Database, migrations: readonly string[]) {
        for (const migration of migrations) database.exec(migration);
      }
    }
  } as unknown as StoreBb;
  return { db, store: createWorkItemStore(bb) };
}

const item = (projectId: string, source: 'github' | 'jira' | 'linear', locator: string) => ({
  bbProjectId: projectId, source, locator, key: locator, title: locator, description: '',
  url: 'https://example.test', status: 'Open', stateCategory: 'todo' as const,
  priority: null, assignee: null, project: null, labels: [], updatedAt: '2026-09-25T00:00:00.000Z'
});

test('migration copies linear and jira, not github', () => {
  const db = new Database(':memory:');
  const bb = { storage: { database: () => db, migrate(d: Database.Database, m: readonly string[]) {
    for (const [index, sql] of m.entries()) {
      if (index === m.length - 1) {
        d.exec(`INSERT INTO project_source_config VALUES
          ('proj_l','linear','DEMO','','','project = X','t'),
          ('proj_g','github','','','','project = X','t'),
          ('proj_j','jira','','https://a.atlassian.net','e@x','project = DEMO','t')`);
      }
      d.exec(sql);
    }
  } } } as unknown as StoreBb;
  const store = createWorkItemStore(bb);
  assert.deepEqual(store.projectSources('proj_l'), [{ projectId: 'proj_l', source: 'linear', teamKey: 'DEMO' }]);
  assert.deepEqual(store.projectSources('proj_g'), []);
  assert.equal(store.projectSources('proj_j')[0]?.source, 'jira');
  const columns = db.prepare("SELECT name FROM pragma_table_info('project_sources')").all() as { name: string }[];
  assert.ok(!columns.some(c => /token|secret|credential|password/i.test(c.name)));
});

test('saveProjectSource keeps other caches', () => {
  const { store } = createStore();
  store.saveProjectSource({ projectId: 'proj_a', source: 'github' });
  store.replaceSource('proj_a', 'github', [item('proj_a', 'github', 'o/r#1')], '2026-09-25T00:00:00.000Z');
  store.saveProjectSource({ projectId: 'proj_a', source: 'jira', baseUrl: 'https://a.atlassian.net', cloudId: '', email: 'e@x', jql: 'project = DEMO' });
  store.replaceSource('proj_a', 'jira', [item('proj_a', 'jira', 'DEMO-1')], '2026-09-25T00:00:00.000Z');
  store.saveProjectSource({ projectId: 'proj_a', source: 'jira', baseUrl: 'https://a.atlassian.net', cloudId: '', email: 'e@x', jql: 'project = DEMO AND x = 1' });
  assert.deepEqual(store.list({ projectId: 'proj_a', limit: 10 }).map(i => i.source).sort(), ['github', 'jira']);
  assert.equal(store.syncState('proj_a', 'github').itemCount, 1);
  assert.deepEqual(store.projectSources('proj_a').map(s => s.source), ['jira', 'github']);
});

test('deleteProjectSource clears only that source', () => {
  const { store } = createStore();
  store.saveProjectSource({ projectId: 'proj_a', source: 'github' });
  store.saveProjectSource({ projectId: 'proj_a', source: 'linear', teamKey: 'DEMO' });
  store.replaceSource('proj_a', 'github', [item('proj_a', 'github', 'o/r#1')], 't');
  store.replaceSource('proj_a', 'linear', [item('proj_a', 'linear', 'DEMO-1')], 't');
  store.deleteProjectSource('proj_a', 'linear');
  assert.deepEqual(store.list({ projectId: 'proj_a', limit: 10 }).map(i => i.source), ['github']);
  assert.equal(store.syncState('proj_a', 'linear').lastSyncedAt, null);
});

test('list hides items of a disconnected source and empty projects are fine', () => {
  const { store } = createStore();
  store.replaceSource('proj_x', 'github', [item('proj_x', 'github', 'o/r#1')], 't');
  assert.deepEqual(store.list({ projectId: 'proj_x', limit: 10 }), []);
  assert.deepEqual(store.projectSources('proj_x'), []);
});

test('bootstrapGithubSources runs once', () => {
  const { store } = createStore();
  assert.deepEqual(store.bootstrapGithubSources(['proj_a', 'proj_b']), ['proj_a', 'proj_b']);
  store.deleteProjectSource('proj_b', 'github');
  assert.deepEqual(store.bootstrapGithubSources(['proj_a', 'proj_b', 'proj_c']), []);
  assert.deepEqual(store.connectedProjectIds('github'), ['proj_a']);
});
