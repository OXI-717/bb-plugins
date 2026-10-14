import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {evaluateVpnEvidence,type VpnEvidence} from './vpn-evidence.js';
import { GUARD_PROVIDERS } from './guard-network.js';
import {GuardRequiredError,VpnRequiredError} from './network-errors.js';
import type { AccountPoolConfig, PoolProvider } from './contracts.js';

export type VpnState = 'connected' | 'disconnected' | 'unknown';
export {VpnRequiredError} from './network-errors.js';
export function vpnStateFromPayload(payload:unknown,now:number):VpnState{return evaluateVpnEvidence(payload,now).state;}

const pendingReads = new Map<string, Promise<unknown>>();
const MAX_PENDING_READS = 16;
const READ_TIMEOUT_MS = 1_000;

/** Open without following symlinks; validate the opened inode before reading. */
async function readTrustedPayload(file: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 4096) return null;
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return null;
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { return null; }
  finally { await handle?.close().catch(() => undefined); }
}

export async function readVpnEvidence(file: string, now: number | (() => number)): Promise<VpnEvidence> {
  let result = pendingReads.get(file);
  if (result === undefined) {
    if (pendingReads.size >= MAX_PENDING_READS) return evaluateVpnEvidence(null,typeof now==='number'?now:now());
    const reading = readTrustedPayload(file);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
    });
    result = Promise.race([reading, timeout]);
    pendingReads.set(file, result);
    const current = result;
    void reading.finally(() => {
      clearTimeout(timer);
      if (pendingReads.get(file) === current) pendingReads.delete(file);
    }).catch(() => undefined);
  }
  const payload = await result;
  return evaluateVpnEvidence(payload, typeof now === "number" ? now : now());
}

export async function readVpnState(file:string,now:number|(()=>number)):Promise<VpnState>{return (await readVpnEvidence(file,now)).state;}

export function createVpnPolicy(
  settings: () => AccountPoolConfig,
  now: () => number,
  injectedPayload?: (nowMs:number) => Promise<unknown>,
  guardCheck?: (provider:PoolProvider)=>Promise<void>,
) {
  const evidence=async():Promise<VpnEvidence>=>{
    try {
      return injectedPayload
        ? evaluateVpnEvidence(await injectedPayload(now()),now())
        : await readVpnEvidence(settings().vpnStatusFile??path.join(homedir(),'.local','state','vpnks','vpn-state.json'),now);
    } catch {return evaluateVpnEvidence(null,now());}
  };
  const state=async():Promise<VpnState>=>(await evidence()).state;
  return {
    state, evidence,
    async assert(provider: PoolProvider) {
      if(settings().vpnGuardEnabled && GUARD_PROVIDERS.some(p=>p===provider)) {
        if(!guardCheck) throw new GuardRequiredError(provider,true);
        await guardCheck(provider);
      }
      if (!settings().vpnOnlyProviders.some(value => value === provider)) return;
      const current=await evidence();
      if(current.state!=='connected'||current.assurance!=='verified_ipv4') throw new VpnRequiredError(provider);
    },
  };
}
