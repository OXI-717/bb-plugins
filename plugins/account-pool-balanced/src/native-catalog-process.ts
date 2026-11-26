import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativeCatalogBootIdSchema,type NativeCatalogProcess} from './native-probe-wire.js';

const run = promisify(execFile);

/** Read only. A different boot or ESRCH for the entire group proves the old process is gone. */
export async function isNativeCatalogProcessStopped(binding: NativeCatalogProcess): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  let boot: string;
  try {
    const {stdout} = await run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      encoding: 'utf8', timeout: 1500, maxBuffer: 1024,
    });
    boot = nativeCatalogBootIdSchema.parse(stdout.trim().toLowerCase());
  } catch {
    return false;
  }
  if (boot !== binding.bootId) return true;
  try {
    process.kill(-binding.groupId, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  return false;
}
