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

const { parseTaskboardCliArguments, formatProjectSources } = await import('../server.ts');

test('config accepts --disconnect', () => {
  const parsed = parseTaskboardCliArguments('config', [
    '--project',
    'proj_a',
    '--disconnect',
    'jira'
  ]);
  assert.equal(parsed.disconnect, 'jira');
});

test('sources are printed as a list without secrets', () => {
  const text = formatProjectSources(
    [
      { projectId: 'proj_a', source: 'jira', baseUrl: 'https://o.atlassian.net', cloudId: '11111111-2222-4333-8444-555555555555', email: 'e@x', jql: 'project = DEMO', credentialConfigured: true },
      { projectId: 'proj_a', source: 'github', credentialConfigured: true }
    ],
    ['o/r']
  );
  assert.match(text, /^Jira\tDEMO · o\.atlassian\.net · cloudId 11111111/m);
  assert.match(text, /^GitHub Issues\t1 репо/m);
  assert.doesNotMatch(text, /token/i);
});

const { startServer } = await import('./fake-bb.ts');

test('config --source github connects GitHub Issues', async () => {
  const { cli, dispose } = await startServer({
    catalog: [{ id: 'e1', bbProjectId: 'proj_a', repos: ['o/r'] }]
  });
  try {
    const result = await cli([
      'config',
      '--project',
      'proj_a',
      '--source',
      'github'
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^GitHub Issues\t1 репо/m);
  } finally {
    await dispose();
  }
});

test('config --source linear|jira without fields fails with field hints', async () => {
  const { cli, dispose } = await startServer({
    catalog: [{ id: 'e1', bbProjectId: 'proj_a', repos: ['o/r'] }]
  });
  try {
    for (const source of ['linear', 'jira']) {
      const result = await cli([
        'config',
        '--project',
        'proj_a',
        '--source',
        source
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /укажи поля/);
    }
  } finally {
    await dispose();
  }
});
