// Adapted from account-pool-balanced/src/vpn-policy.ts in this repository (MIT).
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {evaluateVpnEvidence,type VpnState,type VpnEvidence} from './vpn-evidence.js';

type Opener = typeof open;
const pending = new Map<string, Promise<unknown>>();
const MAX_PENDING = 16;
export async function trustedRead(file: string, opener: Opener = open): Promise<unknown> {
  let handle: Awaited<ReturnType<Opener>> | undefined;
  try {
    handle = await opener(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 4096) return null;
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return null;
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { return null; }
  finally { await handle?.close().catch(()=>undefined); }
}
export async function readVpnEvidence(file: string, now: () => number = Date.now, opener: Opener = open): Promise<VpnEvidence> {
  let result = pending.get(file);
  if (!result) {
    if (pending.size >= MAX_PENDING) return evaluateVpnEvidence(null,now());
    const reading = trustedRead(file, opener);
    let timer: ReturnType<typeof setTimeout>;
    result = Promise.race([reading, new Promise<null>(resolve => { timer = setTimeout(()=>resolve(null), 1000); })]);
    pending.set(file, result);
    const current = result;
    void reading.finally(() => {
      clearTimeout(timer);
      if (pending.get(file) === current) pending.delete(file);
    }).catch(()=>undefined);
  }
  return evaluateVpnEvidence(await result, now());
}

export async function readVpnState(file:string,now:()=>number=Date.now,opener:Opener=open):Promise<VpnState> {return (await readVpnEvidence(file,now,opener)).state;}
