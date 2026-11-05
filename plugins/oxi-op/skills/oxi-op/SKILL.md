---
name: oxi-op
description: Store project credentials in 1Password through a private BB form, or execute configured operations with project secrets.
---

Use the native `oxi_op_store` tool to request a new credential. Supply only its title and account name. Never request passwords in chat or pass a password in tool arguments. BB determines the project from the invoking session; an unknown project fails closed.

If routing is missing or ambiguous, use only an explicitly configured profile for this same BB project. If none exists, report that this project needs to be connected in Oxi Op settings before intake. Never switch to another project's route or propose macOS Keychain, `security` commands, chat, shell arguments or terminal history as an alternative password intake. An absent route is a configuration problem, not permission to move credentials elsewhere.

Use `oxi_op_run` with an owner-configured operation name. Secrets and command output are never returned to the model. For available operation names and route metadata use `bb oxi-op status`. For credential intake from CLI use `bb oxi-op store <title> --username <name>` inside a BB thread.

Choose only a configured access `profile` for the current project. Routine and administrative profiles can use different vaults and approval policies. Include `--profile <profile>` in CLI calls when no default route exists. Never put a service token in routes JSON; use the native secret setting or the configured host environment variable. Intake shows its contextual BB form before contacting `op`; do not preflight with `bb oxi-op check` before opening that form. `bb oxi-op verify` performs a synthetic write/read/cleanup check; inspect the saved verification result in status before repeating an interrupted check.

After an uncertain store, retry the same title and value. A matching item is verified without creating a duplicate; a differing item requires owner review. Cancellation can occur after a remote write, so do not assume cancellation proves no item exists.
