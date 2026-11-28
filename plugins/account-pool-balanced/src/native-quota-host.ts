import {execFile} from 'node:child_process';
import {homedir, platform} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {nativeQuotaReportSchema, type NativeQuotaTarget} from './native-quota-wire.js';

const run = promisify(execFile);
export async function collectNativeQuota(target: NativeQuotaTarget, signal: AbortSignal) {
  if (platform() !== 'linux') throw Error('Native quota collector requires a managed Linux runtime.');
  signal.throwIfAborted();
  try {
    const {stdout} = await run(path.join(homedir(), '.local/bin/agy-managed'), ['quota', target.executorId], {
      signal, timeout: 75_000, maxBuffer: 128 * 1024, encoding: 'utf8',
      env: {PATH:'/usr/bin:/bin', LANG:'C.UTF-8', HOME:homedir()},
    });
    const report = nativeQuotaReportSchema.parse(JSON.parse(stdout));
    if(report.hostId !== target.hostId || report.executorId !== target.executorId || report.accountId !== target.accountId)
      throw Error();
    return report;
  } catch {
    // Child errors may include official-client output. Never forward it.
    throw Error('The managed host did not confirm Antigravity quota for this account.');
  }
}
