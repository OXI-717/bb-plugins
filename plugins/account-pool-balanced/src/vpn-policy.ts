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

/** Open without following symlinks; validate the opened inode before reading. */
export async function readVpnState(file: string, now: number): Promise<VpnState> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 4096) return 'unknown';
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return 'unknown';
    return vpnStateFromPayload(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')), now);
  } catch { return 'unknown'; }
  finally { await handle?.close().catch(() => undefined); }
}

export function createVpnPolicy(
  settings: () => AccountPoolConfig,
  now: () => number,
  injectedState?: () => Promise<VpnState>,
) {
  const readState = injectedState ?? (() => readVpnState(
    settings().vpnStatusFile ?? path.join(homedir(), '.local', 'state', 'vpnks', 'vpn-state.json'), now(),
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
