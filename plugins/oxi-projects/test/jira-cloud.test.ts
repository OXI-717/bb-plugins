import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

const { jiraApiBase, createJiraAdapter } = await import('../sources/jira.ts');

test('jira api base uses cloud id when present', () => {
  assert.equal(jiraApiBase('https://fixture.atlassian.net', ''), 'https://fixture.atlassian.net');
  assert.equal(
    jiraApiBase('https://fixture.atlassian.net', '11111111-2222-4333-8444-555555555555'),
    'https://api.atlassian.com/ex/jira/11111111-2222-4333-8444-555555555555'
  );
});

test('jira adapter calls cloud api and links to site', async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ issues: [{ id: '1', key: 'DEMO-1', fields: {
      summary: 'x', description: null, updated: '2026-09-25T00:00:00.000+0000',
      status: { id: '3', name: 'Готово', statusCategory: { key: 'done' } }, priority: null, assignee: null,
      project: { key: 'DEMO', name: 'Company' }, labels: []
    } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const adapter = createJiraAdapter({
      enabled: true, baseUrl: 'https://fixture.atlassian.net',
      cloudId: '11111111-2222-4333-8444-555555555555', email: 'e@x', apiToken: 't', jql: 'project = DEMO'
    });
    const [item] = await adapter.list({ refresh: true });
    assert.ok(calls[0]!.startsWith('https://api.atlassian.com/ex/jira/11111111-2222-4333-8444-555555555555/rest/api/3/'));
    assert.equal(item!.url, 'https://fixture.atlassian.net/browse/DEMO-1');
  } finally {
    globalThis.fetch = original;
  }
});
