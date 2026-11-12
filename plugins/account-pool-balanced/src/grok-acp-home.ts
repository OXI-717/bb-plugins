import {chmod, lstat, mkdir} from 'node:fs/promises';
import path from 'node:path';

export async function ensureGrokAcpHome(dataDir: string): Promise<string> {
  const grokHome = path.join(dataDir, 'grok-acp-home');
  await mkdir(grokHome, {recursive: true, mode: 0o700});
  const details = await lstat(grokHome);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw Error('Grok ACP config path is not a directory.');
  }
  await chmod(grokHome, 0o700);
  return grokHome;
}
