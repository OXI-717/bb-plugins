/** Shared admission semantics. File trust is enforced by each host-side reader. */
export type VpnState = 'connected' | 'disconnected' | 'unknown';
export type VpnEvidence = {
  state: VpnState;
  assurance: 'verified_ipv4' | 'unverified' | 'invalid';
  reason: string;
  updatedAt: number | null;
  probeAt: number | null;
};
const reasons = new Set(['ok','no_route','no_core','probe_failed','probe_stale','healing']);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const fresh = (v: unknown, now: number, ttl: number) => integer(v) && now-v*1000 >= 0 && now-v*1000 <= ttl*1000;

export function evaluateVpnEvidence(payload: unknown, nowMs: number): VpnEvidence {
  const invalid = (reason = 'invalid_evidence'): VpnEvidence => ({state:'unknown',assurance:'invalid',reason,updatedAt:null,probeAt:null});
  if (!Number.isFinite(nowMs) || !object(payload) || !integer(payload.updated_unix) || typeof payload.state !== 'string' || !['connected','disconnected'].includes(payload.state)) return invalid();
  if (payload.schema !== 'oxi-vpnks/vpn-state/2' || !fresh(payload.updated_unix,nowMs,90)) return invalid('file_stale_or_schema');
  const tunnel = payload.tunnel, attempt = payload.last_probe_attempt;
  if (!text(payload.reason) || !reasons.has(payload.reason) || payload.coverage !== 'ipv4' ||
      !text(payload.guard_version,64) || !object(tunnel) || !text(tunnel.iface,64) || !integer(tunnel.core_pid) ||
      !text(payload.epoch_hash) || !text(payload.traffic_probe_epoch_hash) || typeof payload.traffic_probe_ok !== 'boolean' ||
      (payload.traffic_probe_unix !== null && !integer(payload.traffic_probe_unix)) ||
      !object(attempt) || (attempt.ts !== null && !integer(attempt.ts)) || (attempt.ok !== null && typeof attempt.ok !== 'boolean') ||
      (integer(attempt.ts) && attempt.ts*1000 > nowMs) || (attempt.ts === null && attempt.ok !== null) ||
      payload.traffic_probe_max_age !== 390 || payload.file_ttl !== 90 ||
      (payload.state === 'connected') !== (payload.reason === 'ok')) return invalid();
  const evidence: VpnEvidence = {state:payload.state as VpnState,assurance:'unverified',reason:payload.reason,updatedAt:payload.updated_unix*1000,probeAt:integer(payload.traffic_probe_unix)?payload.traffic_probe_unix*1000:null};
  if (payload.state === 'disconnected') return evidence;
  if (tunnel.iface !== 'utun244' || tunnel.core_pid <= 0 || !payload.traffic_probe_ok ||
      payload.epoch_hash !== payload.traffic_probe_epoch_hash || !fresh(payload.traffic_probe_unix,nowMs,390) ||
      (payload.traffic_probe_unix as number) > payload.updated_unix) return invalid('probe_unverified');
  return {...evidence,assurance:'verified_ipv4'};
}
