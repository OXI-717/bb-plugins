import {vpnProof} from './vpn-test-fixture.js';
import { describe, expect, it } from 'vitest';
import { vpnStateFromPayload, protectedProvider } from './state.js';

const now = 1_800_000_000_000;
const payload = (state: string, updated_unix = now / 1000) => ({...vpnProof(now),state,reason:state==='disconnected'?'probe_failed':'ok',updated_unix,traffic_probe_unix:updated_unix,last_probe_attempt:{ts:updated_unix,ok:true}});
describe('VPN state contract', () => {
  it('accepts fresh connected and disconnected', () => {
    expect(vpnStateFromPayload(payload('connected', now / 1000 - 90), now)).toBe('connected');
    expect(vpnStateFromPayload(payload('disconnected'), now)).toBe('disconnected');
  });
  it.each([null, {}, payload('connected', now / 1000 - 91), payload('connected', now / 1000 + 1), {...payload('connected'),schema:'wrong'},payload('unknown')])('fails closed for missing, stale, future, or tampered content', value => {
    expect(vpnStateFromPayload(value, now)).toBe('unknown');
  });
  it('protects only named provider families', () => {
    expect(['codex','claude-code','cursor','acp-cursor','devin','acp-devin'].every(protectedProvider)).toBe(true);
    expect(['kimi','zai','z-ai','opencode-go'].some(protectedProvider)).toBe(false);
  });
});

it('protects pool aliases without changing Chinese providers',()=>{
  for(const id of ['acp-oxi-cursor','acp-oxi-devin-pool']) expect(protectedProvider(id)).toBe(true);
  for(const id of ['acp-opencode-zai','acp-opencode-kimi','acp-opencode']) expect(protectedProvider(id)).toBe(false);
});
