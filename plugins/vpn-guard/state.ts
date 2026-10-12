import {evaluateVpnEvidence} from './vpn-evidence.js';
export type {VpnState} from './vpn-evidence.js';
export function vpnStateFromPayload(payload:unknown,nowMs:number):import('./vpn-evidence.js').VpnState {return evaluateVpnEvidence(payload,nowMs).state;}

export const PROTECTED_PROVIDERS = ['codex','claude','claude-code','cursor','acp-cursor','acp-oxi-cursor','devin','acp-devin','acp-oxi-devin-pool'];
export function protectedProvider(id: string): boolean {
  return PROTECTED_PROVIDERS.includes(id);
}
