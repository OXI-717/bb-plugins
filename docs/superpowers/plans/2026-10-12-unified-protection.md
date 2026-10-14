# Unified Protection Implementation Plan

> For agentic workers: execute inline using superpowers:executing-plans; do not change live BB, VPN, accounts or automation state.

**Goal:** Coordinate VPN evidence, provider network admission and automation pauses without rebuilding BB.

**Architecture:** Guard owns selected-host protection decisions. Pooler enforces its own outgoing calls. A versioned host controller adapter delegates automation holds to the operator's existing controller. Manual, emergency, Guard and pending-recovery reasons are independent; clearing one never clears the others. Restoration requires an explicit action.

**Tech Stack:** TypeScript plugin SDK; Python controller; atomic local JSON journals; focused Vitest/pytest and isolated BB.

## 1. VPN evidence

- [ ] Add dependency-free `shared/vpn-evidence.ts`, imported by both plugin readers, with `evaluateVpnEvidence(payload, nowMs)`.
- [ ] Validate v2 required fields, known reason, coverage ipv4, fixed 90/390 upper bounds, nonfuture timestamps, utun244, positive core PID and matching nonempty epoch hashes for connected. Retired evidence is always rejected.
- [ ] Require verified evidence and expose evidence status in both plugins. Protected owned Pooler traffic always uses an IPv4-only dispatcher; Chinese traffic keeps its ordinary transport. Native/ACP IPv6 coverage is explicitly outside guarantee.
- [ ] Run state/read/transport/CLI/UI regressions and builds. Use producer output from an isolated writer snapshot in integration fixtures.

## 2. Controller reasons

- [ ] In a private controller worktree add `oxi_tr/protection.py`: atomic, locked versioned hold journal; idempotent hold/release for Guard; legacy/manual/emergency/recovery reasons independent.
- [ ] Add strict local v2 preflight before provider connectivity checks; no provider probe on missing/invalid evidence. Remove retired migration opt-outs.
- [ ] Add bounded JSON CLI `oxi-auto protection status|hold|release|pause|resume`. Capture enabled BB schedules when holding; never resume previously disabled schedules or replay runs. Report ongoing runs and incomplete actions.
- [ ] Raycast stop/start use the same controller state; start cannot clear Guard holds. After Guard release, recovery remains pending until explicit resume.
- [ ] Test restart, overlapping holds, malformed journals, failed pause/resume, repeated reconciliation and future/stale VPN samples without live subprocesses.

## 3. Guard coordination

- [ ] Opt-in automation adapter via host SDK and bounded executable commands, disabled by default. Only the selected pool/server host manages server-side BB schedules; other hosts report their local controller independently.
- [ ] Manual Guard block or enforced VPN denial acquires its hold; removal releases only that hold. No automatic kill-all, service unload or native restoration.
- [ ] Host/controller failures remain visible and prevent claimed complete blocking. Observe alone never creates automation holds.
- [ ] Add bilingual uniform panel rows for VPN evidence, Pooler linkage, automation reasons, paused schedules, active runs, incomplete actions and pending restore. Provide pause/resume controls with the same controller as Raycast.

## 4. Acceptance

- [ ] Full focused and isolated flow: Raycast pause + Guard block + VPN recovery cannot clear the manual reason; unblock leaves pending recovery; explicit resume restores only owned schedules; China exemptions remain separate from master automation pause.
- [ ] Visual check desktop/mobile and honest boundaries (Send-now, native maintenance, IPv6 and arbitrary scripts).
- [ ] Independent exact-SHA review, publication gates, remote CI and per-plugin release. Prepare deployment/rollback instructions; no production activation in this cycle.
