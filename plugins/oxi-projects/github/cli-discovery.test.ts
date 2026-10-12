import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, writeFile, chmod, rm, symlink, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

let directory = '';
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (directory) await rm(directory, {recursive:true, force:true});
});

it('rediscovers a removed versioned binary without retrying failed executed commands', async () => {
  directory = await mkdtemp(join(tmpdir(), 'projects-gh-upgrade-'));
  const stable = join(directory, 'gh');
  const first = join(directory, 'gh-v1');
  const next = join(directory, 'gh-v2');
  const count = join(directory, 'executions');
  await writeFile(first, '#!/bin/sh\necho v1\n');
  await writeFile(next, `#!/bin/sh
if [ "$1" = "--version" ]; then echo v2; exit 0; fi
if [ "$1" = "fail" ]; then echo call >> '${count}'; echo 'sensitive response' >&2; exit 1; fi
echo v2
`);
  await chmod(first, 0o700); await chmod(next, 0o700);
  await symlink(first, stable);
  vi.stubEnv('GH_PATH', stable);
  vi.stubEnv('PATH', '/usr/bin:/bin');
  const {makeRunner, cleanEnv} = await import('./api');
  const run = makeRunner();
  expect(await run(['api'], cleanEnv())).toBe('v1\n');
  await unlink(first); await unlink(stable); await symlink(next, stable);
  expect(await run(['api'], cleanEnv())).toBe('v2\n');
  await expect(run(['fail'], cleanEnv())).rejects.toThrow('запрос не выполнен');
  const {readFile} = await import('node:fs/promises');
  expect(await readFile(count, 'utf8')).toBe('call\n');
});

it('discovers CLI outside GUI PATH and keeps simultaneous repository accounts isolated', async () => {
  directory = await mkdtemp(join(tmpdir(), 'projects-gh-'));
  const binary = join(directory, 'gh');
  await writeFile(binary, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'gh version fixture'; exit 0; fi
if [ "$1" = "auth" ]; then
  if [ -n "$GH_TOKEN$GITHUB_TOKEN$GH_ENTERPRISE_TOKEN$GITHUB_ENTERPRISE_TOKEN" ]; then exit 9; fi
  if [ "$2" = "status" ]; then echo '{"hosts":{"github.com":[{"login":"one"},{"login":"two"}]}}'; exit 0; fi
  if [ "$2" = "token" ]; then printf 'fixture-%s' "$6"; exit 0; fi
fi
if [ "$1" = "api" ]; then printf '%s' "$GH_TOKEN"; exit 0; fi
exit 2
`);
  await chmod(binary, 0o700);
  vi.stubEnv('PATH', '/usr/bin:/bin');
  vi.stubEnv('GH_PATH', binary);
  vi.stubEnv('GH_TOKEN', 'ambient-must-not-be-used');
  vi.stubEnv('GITHUB_TOKEN', 'ambient-other');
  const {accounts, accountClient} = await import('./api');
  expect(await accounts()).toEqual(['one', 'two']);
  const clients = await Promise.all(['one', 'two'].map(account => accountClient(account)));
  expect(await Promise.all(clients.map(client => client(['api','user'])))).toEqual(['fixture-one','fixture-two']);
});
