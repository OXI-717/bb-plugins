import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const { parseJiraEnv, readJiraEnv } = await import('../jira-import.ts');
const { startServer } = await import('./fake-bb.ts');

test('parses prefixed jira env', () => {
  const parsed = parseJiraEnv(
    'FIXTURE_JIRA_SITE_URL=https://fixture.atlassian.net\nFIXTURE_JIRA_CLOUD_ID=11111111-2222-4333-8444-555555555555\nFIXTURE_JIRA_EMAIL=e@x\nFIXTURE_JIRA_TOKEN=secret-value\n',
    'FIXTURE_JIRA'
  );
  assert.equal(parsed.baseUrl, 'https://fixture.atlassian.net');
  assert.equal(parsed.token, 'secret-value');
});

test('missing token error does not leak values', () => {
  assert.throws(
    () => parseJiraEnv('FIXTURE_JIRA_SITE_URL=https://x.atlassian.net\nFIXTURE_JIRA_EMAIL=secret@mail\n', 'FIXTURE_JIRA'),
    (error: Error) => /FIXTURE_JIRA_TOKEN/.test(error.message) && !/secret@mail|x\.atlassian/.test(error.message)
  );
});

test('empty token is rejected', () => {
  assert.throws(
    () => parseJiraEnv('P_SITE_URL=https://x.atlassian.net\nP_CLOUD_ID=\nP_EMAIL=e@x\nP_TOKEN=\n', 'P'),
    /P_TOKEN/
  );
});

test('default key names take JIRA_SITE without a scheme', () => {
  const parsed = parseJiraEnv(
    '# comment\nexport JIRA_SITE=fixture.atlassian.net\nJIRA_CLOUD_ID=11111111-2222-4333-8444-555555555555\nJIRA_EMAIL=e@x\nJIRA_API_TOKEN=tok\nJIRA_BASE_URL=https://ignored\n',
    undefined
  );
  assert.equal(parsed.baseUrl, 'https://fixture.atlassian.net');
  assert.equal(parsed.token, 'tok');
});

test('command substitutions are rejected by key name only', () => {
  assert.throws(
    () => parseJiraEnv('P_SITE_URL=https://x.atlassian.net\nP_EMAIL=e@x\nP_TOKEN=$(cat ~/.ssh/secret)\n', 'P'),
    (error: Error) => /P_TOKEN: подстановки не поддерживаются/.test(error.message) && !/ssh|secret/.test(error.message)
  );
});

test('relative env path is rejected', async () => {
  await assert.rejects(
    readJiraEnv('env.sh', 'P', AbortSignal.timeout(1000), tmpdir()),
    /абсолютным внутри \$HOME/
  );
});

test('env path outside $HOME is rejected', async () => {
  const outside = join(tmpdir(), `jira-env-out-${process.pid}.sh`);
  await writeFile(outside, 'P_TOKEN=x\n');
  await assert.rejects(
    readJiraEnv(outside, 'P', AbortSignal.timeout(1000), '/nonexistent-home'),
    /внутри \$HOME|Не удалось прочитать/
  );
});

test('symlink escaping $HOME is rejected', async () => {
  const root = join(tmpdir(), `jira-env-${process.pid}`);
  const home = join(root, 'home');
  const outside = join(root, 'outside');
  await mkdir(home, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'real.sh'), 'P_TOKEN=x\n');
  await symlink(join(outside, 'real.sh'), join(home, 'link.sh'));
  await assert.rejects(
    readJiraEnv(join(home, 'link.sh'), 'P', AbortSignal.timeout(1000), home),
    /внутри \$HOME/
  );
});

test('jira import requires --jql', async () => {
  const { cli, dispose } = await startServer({
    catalog: [{ id: 'e1', bbProjectId: 'proj_a', repos: [] }]
  });
  try {
    const result = await cli([
      'jira',
      'import',
      '--project',
      'proj_a',
      '--env',
      '/tmp/env.sh'
    ]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--jql/);
  } finally {
    await dispose();
  }
});
