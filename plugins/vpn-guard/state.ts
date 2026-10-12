import { z } from 'zod';

export type VpnState = 'connected' | 'disconnected' | 'unknown';
const schema = z.object({
  schema: z.literal('oxi-vpnks/vpn-state/1'),
  updated_unix: z.number().int().nonnegative(),
  state: z.enum(['connected', 'disconnected']),
});

export function vpnStateFromPayload(payload: unknown, nowMs: number): VpnState {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return 'unknown';
  const age = nowMs - parsed.data.updated_unix * 1000;
  return age >= 0 && age <= 60_000 ? parsed.data.state : 'unknown';
}

export const PROTECTED_PROVIDERS = ['codex','claude','claude-code','cursor','acp-cursor','acp-oxi-cursor','devin','acp-devin','acp-oxi-devin-pool'];
export function protectedProvider(id: string): boolean {
  return PROTECTED_PROVIDERS.includes(id);
}
