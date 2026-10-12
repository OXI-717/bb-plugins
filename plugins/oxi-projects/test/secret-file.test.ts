import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  deleteSecretFile,
  writeSecretFile
} from '../lib/secret-file.ts';

test('writes project credentials atomically with owner-only permissions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'taskboard-secret-'));
  const path = join(directory, 'linear-token');
  t.after(async () => rm(directory, { recursive: true, force: true }));

  await writeSecretFile(path, 'first-token');
  await writeSecretFile(path, 'replacement-token');

  assert.equal(await readFile(path, 'utf8'), 'replacement-token');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('deleting a missing credential is harmless', async () => {
  const path = join(
    tmpdir(),
    `taskboard-missing-secret-${process.pid}-${Date.now()}`
  );
  await deleteSecretFile(path);
});
