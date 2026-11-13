# External client account scope

An operator may narrow an external project-bound credential using
`bb pool client add <name> --project <project-id> --output <new-private-file> --account-scope-json <json>`.
The JSON contains authority metadata, never a credential:

```json
{
  "schema": "bb-account-pool/client-account-scope/1",
  "accountIds": ["11111111-1111-4111-8111-111111111111"],
  "egress": {"id": "dedicated-vpn", "version": 1}
}
```

The strict server schema accepts at most 32 UUIDs, deduplicates and sorts them.
An empty array denies every account. Missing, disabled or ineligible accounts
never widen the scope. Existing project, purpose, schedule, quota, routing,
network and maintenance restrictions still apply. Legacy credentials without a
scope retain their existing behavior.

Only operator issuance supplies this authority. Request bodies, headers, model
names, client names and affinity cannot grant it. The namespace includes the
server-owned client identity, project, purpose and scope. Scoped clients never
write the legacy persisted active-account cursor. Scope changes require revoke
and new issuance. Rotation and grace credentials preserve scope. Malformed
stored scope is a load failure, never an unscoped credential.

Model calls and enumeration use the same selection and final dispatch fence.
Token revocation is checked synchronously inside the account metadata snapshot
immediately before transport starts. Already dispatched work may finish.
Cursor's local exchange returns only the same pool credential. Native executor
endpoints reject scoped credentials because their account and lease authority
differs. Budget services expose only scoped accounts and report route readiness
as false: these read-only services do not prove VPN egress.

Each scoped request requires an actual assigned route matching the exact
profile ID and immutable version, with `closed` failure and an available
transport. The existing `ssh-connect` branch requires `proxy-enforced` assurance.
An ordinary `http-connect` profile is denied. The HTTP branch additionally
requires a server-owned account/host/profile-fingerprint-bound acceptance and
a separate code-owned live VPN enforcement source. Assignment is checked before
credential refresh or dispatch. Assigned-route errors return without fallback
or replay. The existing registry supports Claude and Codex accounts; this
change does not expand its provider inventory.

## Managed HTTP CONNECT acceptance

`management.call` with a short-lived **manage** grant exposes `egress.scopeAccept`
and `egress.scopeRevoke`. Direct client/plugin RPC calls and read grants cannot
write this authority. Accept records are separate from immutable profiles;
neither `configureProxy`, readiness nor client request fields create them.
Acceptance requires account ID, pool host ID, exact profile ID/version and SHA256
of the schema-parsed profile (including endpoint and immutable secret reference),
receipt/config digests, auth generation, expected IPv4 exits and checked/expiry
times. Maximum declaration lifetime is fifteen minutes. Accept returns its
server-generated ID and whether the independent source currently permits it.
Revoke uses the same binding/fingerprint and expected acceptance ID. A stale
revoke cannot revoke a replacement record. Restart preserves declarations and
revocation; malformed persisted records fail closed.

A declaration and its timestamps do **not** prove VPN. Production uses the on-demand Fleet managed CONNECT adapter. Its fixed root-owned
helper must be installed and independently accepted for the exact runtime. Missing
helper, permission, timeout or unknown runtime keeps HTTP scope denied. The adapter
prepares observations asynchronously before secret access/transport and supplies
them to the synchronous final fence; it is not an RPC/config setting; it must supply
independently accepted fail-closed VPN enforcement for the same account, pool
host, profile fingerprint, receipt, gateway config and auth generation. It must
confirm remote DNS, IPv6 deny, tunnel-loss closure, no direct fallback and the
actual accepted IPv4 exit. Its observation must be current (maximum thirty
seconds) and unexpired. Unknown, invalid, absent, mismatched or throwing sources
deny. A recent receipt file or global Guard readiness cannot implement this
capability. The Fleet companion tool supplies readback, preflight and isolated
process checks; current bm4/kz compatibility is unverified because the LW
management route to those hosts is unavailable. No network path is activated.

HTTP acceptance is checked before provider-secret access, at the final metadata
snapshot and immediately before assigned transport starts (including refresh,
after asynchronous host validation). Loss/expiry/revocation fails without
fallback/replay. The proxy dispatcher and legacy routes are retained. Already
sent requests may finish. Future acceptance must verify the actual VPN loss
case while the proxy remains reachable, not just stop/restart of the proxy.

## Before issuing a pilot credential

Tests and profile metadata do not establish that an exit is a VPN. Independently
accept a dedicated VPN egress: verify the actual exit, DNS and IPv4/IPv6 behavior,
kill switch and loss-of-tunnel failure, including credential refresh, model
enumeration and model dispatch. `direct`, `observe` and `outside_scope` guard
results are not VPN evidence. Do not repurpose the operator's personal network.

Check the selected account and project server-side, with exactly one account in
the pilot scope and no personal fallback. Review and accept final code and
public checks before installation. Only then authorize issuance into a new
private server file and a separately authorized minimal client smoke test.
Installation, network configuration, live key issuance and live inference are
outside this code preparation change. No Team Access UI or new resource/session
budget system is included.
