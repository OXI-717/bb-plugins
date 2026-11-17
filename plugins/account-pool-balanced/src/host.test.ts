import {mkdtemp, lstat, mkdir, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {expect, it} from 'vitest';
import {ensureGrokAcpHome} from './grok-acp-home.js';

async function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'pool-grok-host-'));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, {recursive: true, force: true});
  }
}

it('creates a private Grok ACP home inside the plugin data directory', async () => {
  await withDataDir(async (dataDir) => {
    const result = await ensureGrokAcpHome(dataDir);
    expect(result).toBe(path.join(dataDir, 'grok-acp-home'));
    const info = await lstat(result);
    expect(info.isDirectory()).toBe(true);
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.mode & 0o777).toBe(0o700);
  });
});

it('refuses a symlink at the Grok ACP home path', async () => {
  await withDataDir(async (dataDir) => {
    const target = path.join(dataDir, 'elsewhere');
    const grokHome = path.join(dataDir, 'grok-acp-home');
    await mkdir(target);
    await symlink(target, grokHome);
    await expect(ensureGrokAcpHome(dataDir)).rejects.toThrow(
      'Grok ACP config path is not a directory.',
    );
  });
});
