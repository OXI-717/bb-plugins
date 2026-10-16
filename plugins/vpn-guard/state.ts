import {evaluateVpnEvidence} from './vpn-evidence.js';
export type {VpnState} from './vpn-evidence.js';
export function vpnStateFromPayload(payload:unknown,nowMs:number):import('./vpn-evidence.js').VpnState {return evaluateVpnEvidence(payload,nowMs).state;}

export const PROTECTED_PROVIDERS = ['codex','claude','claude-code','cursor','acp-cursor','acp-oxi-cursor','devin','acp-devin','acp-oxi-devin-pool','pi','acp-grok','acp-agy','acp-opencode','acp-opencode-go','acp-opencode-neuraldeep'];
// Exact routes only: generic ACP engines may run arbitrary providers.
export const VPN_EXEMPT_PROVIDERS = ['kimi','zai','z-ai','acp-opencode-kimi','acp-opencode-zai'] as const;
export function protectedProvider(id: string): boolean {
  return !VPN_EXEMPT_PROVIDERS.some(exempt=>exempt===id);
}
