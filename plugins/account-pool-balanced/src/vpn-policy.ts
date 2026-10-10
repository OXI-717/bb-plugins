import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AccountPoolConfig, PoolProvider } from './contracts.js';

export type VpnState = 'connected' | 'disconnected' | 'unknown';
const stateSchema = z.object({
  schema: z.literal('oxi-vpnks/vpn-state/1'),
  updated_unix: z.number().int().nonnegative(),
  state: z.enum(['connected', 'disconnected']),
});
export class VpnRequiredError extends Error {
  readonly code = 'VPN_REQUIRED';
  constructor(readonly provider: PoolProvider) {
    super(`VPN_REQUIRED: ${provider} requires a confirmed VPN connection on the pool server.`);
  }
}

export function vpnStateFromPayload(payload: unknown, now: number): VpnState {
  const parsed = stateSchema.safeParse(payload);
  if (!parsed.success) return 'unknown';
  const age = now - parsed.data.updated_unix * 1000;
  if (age < 0 || age > 60_000) return 'unknown';
  return parsed.data.state;
}

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

export async function readVpnState(file: string, now: number | (() => number)): Promise<VpnState> {
  let result = pendingReads.get(file);
  if (result === undefined) {
    if (pendingReads.size >= MAX_PENDING_READS) return 'unknown';
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
  return vpnStateFromPayload(payload, typeof now === "number" ? now : now());
}

export function createVpnPolicy(
  settings: () => AccountPoolConfig,
  now: () => number,
  injectedState?: () => Promise<VpnState>,
) {
  const readState = injectedState ?? (() => readVpnState(
    settings().vpnStatusFile ?? path.join(homedir(), '.local', 'state', 'vpnks', 'vpn-state.json'), now,
  ));
  const state = async (): Promise<VpnState> => {
    try { return await readState(); } catch { return 'unknown'; }
  };
  return {
    state,
    async assert(provider: PoolProvider) {
      if (!settings().vpnOnlyProviders.some(value => value === provider)) return;
      if (await state() !== 'connected') throw new VpnRequiredError(provider);
    },
  };
}
