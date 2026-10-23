# Host-scoped direct egress and Mac account browser staging

Host policy and browser preparation. Publishing these plugins does not authorize a
server move or change existing host policy.

## Accepted design

Guard owns explicit `directHostIds` (empty by default), restricted to selected enrolled hosts. Manual block and restore ownership override direct mode. Unknown/unavailable hosts never gain direct permission. VPN proof remains unchanged for all other selected hosts. Network readiness is separate from VPN evidence: direct mode must not manufacture connected/verified VPN proof.

Pooler obtains a versioned, host-bound network decision for its actual primary host, never from HTTP input. Only explicit direct permission bypasses the local VPN proof; outside-scope/observe/legacy responses do not. No successful permission cache. Existing VPN/IPv4 transport and Chinese-provider behavior remain. Older peers must fail closed for the new direct feature.

Account browsers remain on an explicitly configured Mac host. Server sends only bounded account metadata and a validated launch URL over authenticated host RPC; no API token, cookie or Keychain material. Host verifies its own fresh VPN evidence. Offline/error never falls back to server-local launch. User authorizes web login in Mac Helium; existing PKCE/device flow completes against authoritative server-side session. Cookies remain on Mac. Uncertain launch outcome is reported; no automatic retry opening duplicate windows.

## Implementation/validation sequence

1. Add failing host-policy and bound-decision tests (direct server, VPN-required Mac, manual block, missing host, stale/revoked policy).
2. Implement opt-in Guard policy and Pooler decision validation; verify focused tests on Linux.
3. Add host browser contract/dispatch tests (target binding, no fallback, VPN-off and offline refusal, no secret fields); implement isolated host adapter and document pre-move registry preparation.
4. Sequential live canaries from VM with source-IP-bound HTTPS and one access/API credential in stdin memory. No Claude, no refresh tokens, no timer/server, no paid fallback. Track catalog, model output, streaming, native CLI and refresh separately.
5. Independent review of frozen source/test delta before any rollout. Keep real profiles/production untouched.

## Remaining deployment gates

Owner-confirmed server move; accepted remote browser registry preparation; current Node/SDK compatibility; real model acceptance per provider; migration verification and rollback. This branch alone does not authorize a production policy change.

## Browser registry and authentication boundaries

The remote host entry supports macOS with the retained default BB data root `~/.bb`.
It requires the existing `~/.bb/plugins/account-pool-balanced/browser-profiles/registry.json`
before opening; a missing registry is an error, not permission to create fresh profiles.
Custom BB data roots are not supported by this staging adapter. Do not delete the old
Mac server copy after a move: its registry is still required. Moving that registry to
a dedicated Mac store needs a separately accepted migration recipe. Profile directories,
cookies and Keychain material stay on the Mac and are never host-RPC arguments.

Configure the selected enrolled browser host with `bb pool config set browserHostId <host-id>`;
`local` retains legacy server-local behavior. Both panel and CLI use the same host router.
Remote mode has no automatic retry/fallback on an uncertain launch. Host RPC and local
browser admission both check the Mac's own VPN evidence; the VM direct grant is irrelevant.
A connected host means the daemon is reachable, not that its GUI login session is usable.

Browser opening/profile management is separate from subscription token enrollment:

- Current Codex Pooler device login polls on the server and exchanges its authorization
  code with the hosted `/deviceauth/callback` redirect. It has no Mac localhost callback.
- Current Claude Pooler flow uses the hosted console code callback; the user submits its
  code/state to the same Pooler login session, which retains the PKCE verifier. This is
  source inspection only, not authorization to contact Claude or attest its login.
- API-key accounts retain the existing secure entry flow. Opening a logged-in web page
  does not import a key, native CLI login, or helper authentication into the server.

Actual provider login, refresh, native Mac GUI acceptance, Keychain behavior and real
profile session restoration are not proven by synthetic host-RPC tests. No live profile
or production plugin is changed by this staging work.

## Version ordering and policy limits

New Pooler requires Guard `networkDecisionV2`; old Guard fails closed for linked protected
requests. Deploy accepted Guard first, then Pooler; roll back coherently. This document
is not rollout authorization. A direct grant is explicit selected/enrolled-host policy,
not evidence of VPN or provider acceptance. Global native-plugin suspension cannot coexist
with mixed direct hosts. Mac dispatch/reconciliation uses trusted BB execution-host metadata
and host-local evidence. Existing exact Kimi/Z.ai admission exemptions remain unchanged;
protected sessions and all shared account browsers on Mac still require VPN. Send-now,
already-running scripts and packet-level isolation retain the documented Guard limitations.

## Automation controller host

The automation controller can be pinned independently of the BB server with
`bb vpn-guard automation-host <selected-host-id>`. Pin the existing Mac before
moving the server; its controller path and jobs then remain on that Mac through
authenticated host RPC. `automation-host server` restores legacy primary-host
selection. Existing installations remain in that legacy mode until explicitly
configured. Status exposes `automationHostId`; null means follow the server.

The target must be selected and enrolled. A controller hold or running controller
operation prevents changing its host. A linked pinned host cannot be deselected
until coordination is disconnected. VPN failure on the pinned Mac continues to
hold its jobs even when the server has direct egress. The direct server grant
does not grant permission to resume Mac jobs. This is one controller binding,
not a new Linux scheduler or a migration of the Mac jobs.

Release order: Guard 0.1.16 first, Pooler 0.4.33 second. Keep enforcement enabled;
use an agreed idle/reload window and preserve existing state. Configure the
controller pin, selected hosts, direct grant and browser host explicitly before
the separately authorized server move. Do not delete the retained Mac registry.
