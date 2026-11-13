---
name: account-pool
description: "Configure or diagnose Account Pooler accounts, authentication, quota routing, and failover through bb pool."
---

# Account Pooler

Use `bb pool` for this plugin's accounts and routes. Inspect current state with
`bb pool status --json` and `bb pool account list --json` before changing routing.
Use `bb pool --help` for available commands.

Use `bb pool readiness --project <project-id> --json` for a bounded, read-only
snapshot of the nine pooled routes. It applies existing project, schedule,
quota, cooldown, network and stored-credential checks without refreshing quotas
or contacting a provider. Readiness is advisory; actual dispatch checks again.
It does not prove that a model request will succeed or that a launcher exists
on a particular machine. Native BB provider states check that installation.

For account login/import, secret handling, quota refresh, routing settings,
ordering, or failover, read
[references/accounts-and-routing.md](references/accounts-and-routing.md).

Use stdin or supported login/import flows for credentials; never put secret values
in command arguments or chat. Confirm the resulting account and routing state.
Do not enable the plugin or change accounts unless the requested task calls for it.

For external clients (including agents launched in Orca), use
`bb pool client add <name> --output <new-private-file-on-server>` and
`bb pool client revoke <name>`. The token file is on the BB server; transfer it
privately, never print its contents. Client credentials follow their server-side
project binding and account policies. Use `--project <project-id>` when creating
a project-bound client token. See [external clients](../../docs/external-clients.md)
for standalone startup, process-scoped CLI setup and the separate Devin cloud API.

For VPN-only provider switches, local status-writer requirements, and temporary
network recovery, see [VPN policy](../../docs/vpn-policy.md). Protected
providers deny every upstream operation when the server VPN state is unknown.

Pooler 0.4.14+: `bb pool config set vpnGuardEnabled true` enables a fail-closed link to Guard 0.1.2+ on the pool server. This setting is also available in the UI. Removing Guard does not unblock traffic for a linked pool; removing or disabling the link explicitly removes this additional barrier. Kimi and Z.AI are independent.

For a purpose-bound automation client, add `--project <project-id> --purpose autopilot`
to the existing client issuance command. Only explicitly opted-in accounts are
selectable; project policies and quota guards still apply. Existing credentials
remain legacy. A client name or request header cannot supply the trusted purpose.
Do not choose or enable accounts without the operator's policy instruction.


## Concurrent Guard reads and interrupted Cursor streams

Pending Guard permission checks share one in-flight read per provider. The
completed decision is never cached: the next call starts a fresh read, with the
same host binding/recheck and two-attempt timeout budget. Explicit denial and
RPC/validation failures remain final. Probe invocations have independent checks
and cannot delay or change production permission checks.

A failed background permission check still aborts active streams for that
provider. Body failures log a safe `response_body` stage, request UUID, bytes read,
fixed error category and optional Guard failure reason. No body bytes, URLs or
raw error messages are logged. Match that UUID to request observations before
attributing an `incomplete envelope` to Guard. A nearby Guard timeout alone is
not proof. Success and ordinary caller cancellations produce no body warning.


Cursor's local RPC gateway limits connection/header waits to 120 seconds. An
accepted response body follows the client's lifetime, so long model/tool waits
do not truncate it. Disconnecting the local client shuts down its upstream
socket. A silent upstream can remain open while the client is still waiting;
the gateway does not invent a Connect end frame or replay inference.


For an explicitly authorized synthetic recovery test, inspect one thread with
`bb pool stream-probe --thread <thread-id> --json`. Interrupt only an exact observed
model response using `--interrupt-request <request-uuid> --confirm`; both identities
must match. It does not change Guard, replay requests, or interrupt neighbours.
See [controlled stream recovery](../../docs/cursor-paths.md#controlled-stream-recovery-check).
