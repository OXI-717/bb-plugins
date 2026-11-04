# Official Antigravity processes managed by Pooler

This is a separate, opt-in execution mode. It does not add an OAuth account or
claim successful native sign-in. Other providers and existing settings are unchanged.

The official CLI owns Google authentication, storage, refresh and model traffic.
Pooler admits an explicitly registered host/project executor, serializes access
to an operator-declared subscription across hosts and purposes, and records only
bounded admission metadata. This is an execution queue, not a model HTTP proxy.
No Google tokens, authorization codes, prompts, tools or raw provider errors are
accepted by the admission endpoint. Native model selection and advertised editor
identity are forwarded unchanged; there is no client impersonation.

Official reference: [ACP](https://antigravity.google/docs/cli/acp/) and
[headless execution](https://antigravity.google/docs/cli/headless/).
These documented interfaces are not a guarantee against account restrictions.

## Registration and activation

Registration is an operator operation, disabled by default:

```sh
bb pool native configure '{"id":"native-mac","accountId":"subscription-one","hostId":"host-one","callerIds":["host-one"],"projectIds":["project-one"],"enabled":false,"autopilotAllowed":false}'
bb pool native status --json
```

Use the SAME subscription identifier for executors sharing one real Google
account; do not infer identity from a path or copy a native profile. Only one
enabled executor may match a host/project for BB auto-selection. Additional
standalone callers require existing server-issued project/purpose-bound clients;
project IDs and caller-provided host headers do not create authority. Every
executor host must be enrolled. Machine login contexts remain host-local.

Model discovery has no BB thread or project. An explicit `catalogCallerIds` list
authorizes separate existing project-bound catalog clients, never task clients.
The private host profile supplies that catalog credential; no null-project task
token is minted. The wrapper's catalog-only ACP allows initialize/new/list/close,
blocks prompt/auth/resume/tool callbacks and MCP servers, and stops within 30s.
The server binds catalog leases to kind=catalog; that credential or lease cannot
be upgraded into task admission. Ambiguous/missing host configuration refuses.

Enable a validated executor by configuring that complete record with enabled=true.
After host setup and live acceptance, `bb pool native mode managed` activates the
new provider environment and disables the legacy AGY OAuth/model-proxy paths and
their background refresh. `off` restores the previous mode and is not an automatic
error fallback. Do not switch modes during an active session.

Managed mode requires routing to remain enabled. Bypass or a missing/ambiguous
executor fails closed. Guard is checked for the EXECUTOR host, including each
heartbeat, without changing its policy. A VPN-only native executor without the
Guard host decision is refused. No server VPN evidence is substituted for a
remote machine's egress.

## Lease protocol

POST `/native/agy` uses the existing project/purpose bearer. Actions:

- `acquire`: executorId, a fresh UUID sessionId and kind=task (default) or catalog;
  returns queued or active,
  leaseId, hostId, accountId, ttlMs=30000 and heartbeatMs=5000.
- `poll`: leaseId; repeats authorization and host network checks.
- `release`: leaseId and exactly one of stopped=true or completed=true.
  Completion acknowledges an ACP response; stopped acknowledges process cleanup.

One subscription lane covers interactive ACP prompts and native headless tasks.
This one-at-a-time starting policy is an operational choice, not a Google limit.
ACP initialization is admitted separately, then releases its slot. The official
process stays warm while idle, and each prompt reacquires a slot. A queued prompt
is never forwarded; cancellation never replays it. Headless holds its lease until
the owned process group has stopped. The wrapper must stop on failed/changed
admission and never choose another account or native executable.

Expiry or a plugin restart quarantines ACTIVE leases; it never proves process
termination. Queued leases expire normally. A disconnected active process keeps
its slot unavailable until the same caller confirms termination. If the wrapper
has died, an operator must first establish actual process cleanup, then use
`bb pool native attest-stopped <lease-id> --confirmed`. An expired active lease
cannot be freed by completed=true. There is no automatic uncertain-slot reset.

Registry: at most 32 executors, 128 leases, 256 events retained for 14 days.
Metadata serialization is bounded independently of request history. No additional
scheduler, account policy toggle or model request is introduced.

## Readiness and acceptance limits

Configured/installed does not mean authenticated, quota-ready or working. Native
subscription headroom is UNKNOWN unless an official supported source is provided;
local usage counters are not a substitute. Autopilot's existing budget floors,
project rules, isolation and explicit opt-ins remain mandatory. Do not enable it
when required budget or executor evidence is unavailable. A native account is not
an OAuth account in the old model-proxy inventory.

Host rollout requires the reviewed native wrapper and private host-bound launch
profile, installed official CLI, explicit native login, successful ACP file/tool
and continuation checks, and one ordinary headless acceptance in its intended
isolated user/workspace. No copying native credentials to containers, no disabling
container isolation and no automatic Google consent. Synthetic tests and CLI help
checks do not establish those live results.
