---
name: account-pool
description: "Configure or diagnose Account Pooler accounts, authentication, quota routing, and failover through bb pool."
---

# Account Pooler

Use `bb pool` for this plugin's accounts and routes. Inspect current state with
`bb pool status --json` and `bb pool account list --json` before changing routing.
Use `bb pool --help` for available commands.

For account login/import, secret handling, quota refresh, routing settings,
ordering, or failover, read
[references/accounts-and-routing.md](references/accounts-and-routing.md).

Use stdin or supported login/import flows for credentials; never put secret values
in command arguments or chat. Confirm the resulting account and routing state.
Do not enable the plugin or change accounts unless the requested task calls for it.

For external clients (including agents launched in Orca), use
`bb pool client add <name> --output <new-private-file-on-server>` and
`bb pool client revoke <name>`. The token file is on the BB server; transfer it
privately, never print its contents. Client credentials authorize use of all model
accounts in that pool. See [external clients](../../docs/external-clients.md)
for standalone startup, process-scoped CLI setup and the separate Devin cloud API.
