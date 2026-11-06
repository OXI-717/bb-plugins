# OXI OP

Native BB tools for project-scoped 1Password credential intake and configured credential use. Requires 1Password CLI on the selected enrolled host and BB SDK 0.6.104 or newer.

`oxi_op_store` opens a password form in BB, writes a Login item through JSON stdin, independently reads it back and compares both fields. The password stays out of model arguments, command arguments, transcript history and local temporary files. It passes through BB's server memory and the selected host. Repeating the same title and values recovers an uncertain write; an existing differing item is never overwritten.

`oxi_op_run` executes an owner-configured command using `op run`. The agent selects an operation name, never command arguments or secret references. Command stdout and stderr are discarded; only completion is returned. Approval is required by default. Disable approval only for routine operations you intend to run unattended.

`bb oxi-op run <operation> --profile <profile>` uses the same project scope and approval gate as `oxi_op_run`, including when newly registered agent tools are not yet available in an existing provider session. It accepts only a configured operation name.

Forms resolve the current project, thread and execution machine names directly from BB metadata before contacting 1Password. The invoking project and the configured access label are displayed separately. Unavailable names are explicit. IDs and exact secret references are collapsed under technical details. Set an operation's `label` and `referenceLabels` (environment name mapped to `{ "item": "Example server", "field": "Password" }`) for readable operation and record names; these labels stay in private plugin settings alongside the exact references.

## Configuration

For owner setup, `oxi_op_inventory` or `bb oxi-op inventory --profile <registry-profile> --title <registry-item-title>` first displays a contextual BB approval. Only after submission does it use desktop CLI access to read the configured service registry and return vault metadata matching the registry's IDs. Cancellation never invokes `op`. Prefer native tools: BB resumes the requesting agent when their form completes. A CLI caller must remain connected; a persistent BB terminal preserves the form but does not itself resume an idle agent.

When native tools are unavailable in an older provider session, interactive CLI commands accept `--notify`. Every BB approval and intake form, native or CLI, expires after 60 seconds. An expired request is cancelled before any credential call; it is never retried automatically. Completion sends a value-free notice through the BB SDK to the same invoking thread, queued if it is active. Success, cancellation and failure all direct the agent to inspect the durable history; notification failure never retries a credential operation. Stopped requests and moved, archived or deleted threads are not resumed. Ordinary CLI calls omit this flag and never start an agent turn.

`oxi_op_history` and `bb oxi-op history` recover the latest 30 operations for the invoking project and thread without contacting 1Password. The server persists preparation, approval, execution and completion states and strictly validated non-secret results. Form values, service tokens, command output and exception text are never journaled. Records survive plugin reload and server restart; unfinished records from a previous plugin instance are shown as `interrupted`, not as completed or undone. Check these records before repeating an uncertain write. Failed native operations return an explicit `completed: false` result so BB can deliver failure to an idle agent as well as success.

Configure `routes` in BB plugin settings, outside the source repository. Each project and access profile pair must have exactly one route. Omitted `profile` means `default`. Use separate profiles for routine API access and administrative credentials, with separate vault permissions. Example with synthetic identifiers:

```json
[
  {
    "projectId": "example-project",
    "profile": "routine",
    "label": "Example project: routine API access",
    "hostId": "example-host",
    "vaultId": "example-vault",
    "authentication": "service-account",
    "tokenSetting": "projectServiceAccounts",
    "requireApproval": true,
    "operations": []
  }
]
```

Choose an explicit supported `op` authentication mode. `desktop` requires `accountId` and uses the installed 1Password app's CLI integration and its owner approval. For `service-account`, prefer `tokenSetting: "projectServiceAccounts"`: the native encrypted secret setting holds a JSON object mapping project IDs to profile objects, each containing its own service token. For example, use the shape `{"example-project":{"routine":"<scoped-service-token>"}}` in the secret setting, never in routes JSON. A missing project/profile entry fails without a shared-token or desktop fallback. The legacy single `serviceAccountToken` setting remains supported for existing installations; a route can alternatively name a securely provisioned host variable with `tokenEnvironment`. Provision each account with the corresponding vault permissions; the map selects tokens but does not narrow their provider-side grants. A missing or expired service token fails without falling back to a personal account. The plugin never reads macOS Keychain directly or asks for the Mac login password. Tokens are never tool results.

A desktop route can set `credentialHostId` to the enrolled machine running the owner's 1Password app while `hostId` identifies a different execution machine. These routes always require BB approval. The form names the execution machine and describes where desktop authorization occurs. After approval, the credential host resolves only the configured references; the backend forwards their values through internal host RPC to the fixed command's environment on the execution machine. Values never become tool results, CLI arguments, files or journal entries. The execution machine needs no service token for that administrative vault. Intake and vault checks run on the credential host. Both hosts and the BB server must be trusted and available. This is a BB-mediated operation, not a remote biometric approval feature supplied by 1Password.

The host daemon must be able to find `op` on its PATH, or the route can specify `opBinary` with its installed executable path. `bb oxi-op check --profile <profile>` explicitly checks the configured vault. Desktop checks and synthetic verification require a contextual BB form before any CLI authorization dialog; automatic service-account checks follow the configured approval policy. Intake always shows the BB form first; cancellation makes no `op` call. The form identifies the configured project label, session, profile, host, vault, item and field. Optional `hostLabel` and `vaultLabel` give readable names alongside the exact identifiers. `bb oxi-op store <title> --username <name> --profile <profile>` opens the same native form used by the agent tool.

`bb oxi-op verify --profile <profile>` creates a uniquely named synthetic Login, compares its fields by a separate read and removes that test item. It returns only verification and cleanup status. Successful results, including their time, appear in `bb oxi-op status` so a disconnected caller can check before repeating a write. JSON templates are passed through `/dev/stdin`; no plaintext template file is created. The host implementation targets macOS and Linux.

Each operation has `name`, optional `purpose` (a readable reason shown before approval), `argv` (the fixed executable and arguments) and `references` (environment variable names mapped to `op://<vaultId>/<item>/<field>`). Approval shows every exact reference from the owner configuration before contacting `op`; it never obtains these labels by reading credentials. References must use the route's exact vault ID; `OP_*` overrides are forbidden. Provision service accounts with the least required vault permissions. Writing requires read permission in 1Password. Keep administrative vaults separate and use expiring credentials for them.

This plugin does not create service accounts or grant vault access. Configure those through 1Password's supported owner workflow. It does not isolate other processes running as the same OS user. BB confirmation governs this plugin's operations; service-account permissions and host isolation define the underlying security boundary. Desktop CLI approval authorizes a terminal session to the account and is broader than one item; the BB form is not a replacement for that account-level authorization.

## Development

Run `npm ci`, `npm run typecheck`, `npm test` and `bb plugin build .` in this directory. Tests use synthetic values. Install with `bb plugin install <source> --subdirectory plugins/oxi-op`. A local path must be readable by the BB server; a Mac path cannot be installed directly by a remote Linux server.

Owner-requested project onboarding uses `bb oxi-op connect --project <project-id> --profile <desktop-setup-profile>` from an already configured setup session. It shows a 60-second BB approval before desktop authorization, creates one project vault with an exact project marker, independently reads it back, and adds a default desktop route. Existing routes are preserved; an existing default or an unmarked namesake fails closed. No automatic read operations or service tokens are granted. After interruption, inspect history and settings before retrying; a created vault may remain and can be recovered by its exact marker. Use `--notify` in a persistent terminal when native tool lifecycle is unavailable.
