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

Open the Google subscription card in Accounts to use the existing Projects form.
Choose **All projects** to include future projects, or **Only selected** to limit
execution to the listed projects. As with other accounts, an empty list permits
all projects. Saving applies atomically to every executor sharing the subscription;
active/queued/uncertain leases, ambiguous executor selection and stale forms refuse changes. Native lists are limited to 32 project IDs. Native executors do
not implement project-specific primary/reserve roles, so those controls are hidden.

Legacy registrations retain their `projectIds` allowlist until explicitly changed.
The optional `projects` field uses the existing account projects contract and takes
precedence over that legacy list. Caller/host, catalog-only and automation permissions,
network checks, prepared runtime bindings and host workspace limits still apply.

Use the SAME subscription identifier for executors sharing one real Google
account; do not infer identity from a path or copy a native profile. Multiple
accounts on one host require an explicit preferred executor. Choose **Use** on
the account card or run `bb pool native prefer <executor-id>`. The choice is
stored separately from admitted process bindings, so existing sessions keep
their account and queued work is not rebound. A stale UI revision refuses;
unknown/disabled executors cannot be selected. With no explicit preference,
ambiguous matches still refuse. Optional executor `label` identifies the account
in the UI without exposing private profile paths or caller credentials.

The host launcher must separately contain an explicit private profile reference
for each selected executor. Pooler cannot turn an unprepared host profile into
another account. Selection still filters project, caller, catalog and automation
permissions before considering the preference; it does not grant any access.
This is operator selection for future sessions, without quota-driven rotation.
Additional
standalone callers require existing server-issued project/purpose-bound clients;
project IDs and caller-provided host headers do not create authority. Every
executor host must be enrolled. Machine login contexts remain host-local.

Model discovery has no BB thread or project. An explicit `catalogCallerIds` list
authorizes separate existing project-bound catalog clients, never task clients.
The private host profile supplies that catalog credential; no null-project task
token is minted. The wrapper's catalog-only ACP allows initialize/new/list/close,
blocks prompt/auth/resume/tool callbacks and MCP servers. Admission and metadata
share a 30s deadline, followed by bounded process-stop/release cleanup.
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

## Accounts settings

The Antigravity section displays registered official-client subscriptions directly
from the native registry. Executors with the same `accountId` share one card;
no proxy OAuth account or duplicate Google login is created. The card lists
executor enablement, automation permissions, and active, queued or uncertain
leases. It refreshes every 15 seconds and reports registry read failures.

Registration is configuration evidence only. The card does not claim that a
client is signed in or that a numeric quota is available. In managed mode,
legacy OAuth controls are hidden; routing and VPN controls remain available
for native execution. Official clients retain
ownership of authentication. With managed mode off, registered cards remain
visible with that state, and legacy controls remain available.
