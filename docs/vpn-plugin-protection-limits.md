# Plugin-only protection / Защита без изменения BB

## Реализовано / Implemented

- Guard covers native Codex/Claude/Cursor/Devin IDs and Cursor Pool/Devin Pool aliases for ordinary dispatch and selected-host running-turn cleanup.
- Pooler persisted `vpnGuardEnabled` opt-in checks Guard for the pool server host before every owned protected outbound call. No allow cache. Invalid/missing/timed-out Guard fails closed; unrelated Chinese traffic is allowed.
- Models, login/OAuth, token renewal, usage/profile/reset and owned background calls share Pooler gating. Open owned requests/streams are cancelled on policy denial at the next periodic check.
- Native Codex/Claude plugin suspension remains an explicit global opt-in with ownership journal and manual restore. It removes registrations but does not prove termination of all existing bridges/connections.

## Что плагинами закрыть нельзя

1. **Send-now:** BB deliberately skips `message.dispatch`. Direct/native provisioning may start; reconciliation stops the thread later. Pooler-owned network calls still enforce the linked gate, but direct clients may contact upstream first.
2. **Native maintenance:** native BB usage/model/OAuth requests do not use Pooler transport. Without separately enabled global native suspension they continue; suspension does not prove all in-flight activity cancelled.
3. **Arbitrary scripts/CLI sockets:** a plugin cannot intercept another plugin's fetch, third-party CLI sockets or arbitrary agent shell commands. Existing scripts are outside admission.
4. **Detection latency:** running-thread cleanup is periodic (5 s plus host/stop latency); owned network cancellation is periodic (1 s plus decision latency). A change can race a request already permitted. Previously sent bytes cannot be recalled.
5. **Scope and lifecycle:** only selected hosts and documented provider IDs are covered. Disabling/removing Guard removes its BB hook and can release orphaned queued messages; linked Pooler still refuses protected upstream calls because Guard is unavailable. Pool integration disabled explicitly removes that extra gate.
6. **Standalone:** `vpnGuardEnabled` has no BB client in standalone mode and therefore refuses protected traffic; default standalone VPN policy remains independent. Separate standalone integration is not claimed.

## English

Send-now bypass, direct/native maintenance, third-party CLI sockets, active scripts, previously sent packets and orphaned queue release cannot be fully controlled by the public plugin SDK. Global native suspension helps registration lifecycle but is not packet isolation. Selected scope, explicit linkage and periodic detection remain operational requirements. Full mandatory admission needs BB core changes; absolute process/network isolation needs an OS or isolated runtime boundary. Neither is part of this release.

## Приёмка

Verify protected calls with synthetic upstream counters (zero while denied), Guard outage/malformed decisions, Chinese allow, alias admission/stop, unblock recovery, cancellation/cleanup and status. Do not call successful unit tests proof of native network isolation. Record exact tested SHA, independent review and CI; test production toggles only on owner instruction.

## Обновление / Upgrade

Run `bash scripts/upgrade-protection.sh` from this repository. It requires Guard in Observe with manual/global blocking off and reviewed ownership journals. Before changing either plugin it waits for three idle Pooler checks; expiration leaves both versions unchanged. It then upgrades Guard, verifies the selected pool server host, runs the existing idle/backup Pooler updater, and enables persisted linkage. The Pooler updater rechecks idleness before mutation. `--sandbox` and `--check` delegate to the existing Pooler dry workflow before any Guard writes. The script never silently releases a block. Production pool reload should run from a terminal after agent requests have finished. New requests arriving after the initial idle check can still prevent the second update: this is not an atomic paired upgrade. BB has no supported arbitrary-version downgrade; do not use a destructive reinstall as automatic rollback.

Guard status includes up to 100 persisted `stopHistory` observations: thread, host, time and a fixed reason code. `host_rpc_failed` means the host status could not be read; it is distinct from a reported `probe_failed`, stale evidence, and `manual_block`. No upstream payloads or exception text are stored. Historical stopped IDs without observations have no inferred cause; the journal does not enable automatic thread replay.
