import { describe, expect, it } from 'vitest';
import { vpnStateFromPayload, protectedProvider } from './state.js';

const now = 1_800_000_000_000;
const payload = (state: string, updated_unix = now / 1000) => ({schema:'oxi-vpnks/vpn-state/1',state,updated_unix});
describe('VPN state contract', () => {
  it('accepts fresh connected and disconnected', () => {
    expect(vpnStateFromPayload(payload('connected', now / 1000 - 60), now)).toBe('connected');
    expect(vpnStateFromPayload(payload('disconnected'), now)).toBe('disconnected');
  });
  it.each([null, {}, payload('connected', now / 1000 - 61), payload('connected', now / 1000 + 1), {...payload('connected'),schema:'wrong'},payload('unknown')])('fails closed for missing, stale, future, or tampered content', value => {
    expect(vpnStateFromPayload(value, now)).toBe('unknown');
  });
  it('protects only named provider families', () => {
    expect(['codex','claude-code','cursor','acp-cursor','devin','acp-devin'].every(protectedProvider)).toBe(true);
    expect(['kimi','zai','z-ai','opencode-go'].some(protectedProvider)).toBe(false);
  });
});
