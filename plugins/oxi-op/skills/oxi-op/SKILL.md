---
name: oxi-op
description: Store project credentials in 1Password through a private BB form, or execute configured operations with project secrets.
---

Use the native `oxi_op_store` tool to request a new credential. Supply only its title and account name. Never request passwords in chat or pass a password in tool arguments. BB determines the project from the invoking session; an unknown project fails closed.

If routing is missing or ambiguous, use only an explicitly configured profile for this same BB project. If none exists, report that this project needs to be connected in Oxi Op settings before intake. Never switch to another project's route or propose macOS Keychain, `security` commands, chat, shell arguments or terminal history as an alternative password intake. An absent route is a configuration problem, not permission to move credentials elsewhere.

Use `oxi_op_run` with an owner-configured operation name. Secrets and command output are never returned to the model. For available operation names and route metadata use `bb oxi-op status`. For credential intake from CLI use `bb oxi-op store <title> --username <name>` inside a BB thread.

Prefer native tools for requests with forms: BB delivers their final result and resumes the requesting session. A persistent CLI terminal keeps a form alive but does not resume an idle agent. After confirmation, interruption or restart, inspect `oxi_op_history` or `bb oxi-op history` before repeating an operation. `running`, `interrupted` and `needs-review` do not prove an uncertain write was undone. History contains only states and validated metadata, never submitted credential values. An explicit `completed: false` tool result is a failure, even though the tool transport fulfilled. Use `oxi_op_inventory` only for an owner-configured service registry; it requests BB approval before desktop authorization.

If native tools are missing from an older session, run its interactive CLI request in a persistent BB terminal with `--notify`. BB then returns a value-free completion notice to this same session; inspect history to distinguish success, cancellation and failure. Use this flag only for an interactive request whose continuation the user expects, not unattended scripts or routine checks. Never recreate a request merely because a notice or terminal output is missing.

For critical remote operations, the owner may configure a desktop `credentialHostId` separately from the execution `hostId`. Approval identifies the target operation and the machine where desktop authorization occurs. The password goes only to the fixed remote command's environment through internal host RPC; the agent receives completion status. Do not request or install a permanent administrative service token as a workaround when the desktop host is unavailable.

Choose only a configured access `profile` for the current project. Routine and administrative profiles can use different vaults and approval policies. Include `--profile <profile>` in CLI calls when no default route exists. Never put a service token in routes JSON; use the native secret setting or the configured host environment variable. Intake shows its contextual BB form before contacting `op`; do not preflight with `bb oxi-op check` before opening that form. `bb oxi-op verify` performs a synthetic write/read/cleanup check; inspect the saved verification result in status before repeating an interrupted check.

For automatic access, prefer owner-provisioned project/profile tokens in the encrypted `projectServiceAccounts` setting. Missing entries are setup failures, never permission to reuse another profile's or project's token. The provider-side account must itself have suitably restricted vault permissions; the token map alone is not a vault access boundary.

After an uncertain store, retry the same title and value. A matching item is verified without creating a duplicate; a differing item requires owner review. Cancellation can occur after a remote write, so do not assume cancellation proves no item exists.

All BB confirmation and intake forms expire after 60 seconds. Timeout is cancellation, not approval. Do not automatically reopen an expired request.

Owner-requested project onboarding uses `bb oxi-op connect --project <project-id> --profile <desktop-setup-profile>` from an already configured setup session. It shows a 60-second BB approval before desktop authorization, creates one project vault with an exact project marker, independently reads it back, and adds a default desktop route. Existing routes are preserved; an existing default or an unmarked namesake fails closed. No automatic read operations or service tokens are granted. After interruption, inspect history and settings before retrying; a created vault may remain and can be recovered by its exact marker. Use `--notify` in a persistent terminal when native tool lifecycle is unavailable.
