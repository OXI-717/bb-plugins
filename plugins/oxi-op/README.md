# OXI OP

Native BB tools for project-scoped 1Password credential intake and configured credential use. Requires 1Password CLI on the selected enrolled host and BB SDK 0.6.104 or newer.

`oxi_op_store` opens a password form in BB, writes a Login item through JSON stdin, independently reads it back and compares both fields. The password stays out of model arguments, command arguments, transcript history and local temporary files. It passes through BB's server memory and the selected host. Repeating the same title and values recovers an uncertain write; an existing differing item is never overwritten.

`oxi_op_run` executes an owner-configured command using `op run`. The agent selects an operation name, never command arguments or secret references. Command stdout and stderr are discarded; only completion is returned. Approval is required by default. Disable approval only for routine operations you intend to run unattended.

## Configuration

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
    "tokenSetting": "serviceAccountToken",
    "requireApproval": true,
    "operations": []
  }
]
```

Choose an explicit supported `op` authentication mode. `desktop` requires `accountId` and uses the installed 1Password app's CLI integration and its owner approval. `service-account` requires either `tokenSetting: "serviceAccountToken"` (the native BB secret setting) or `tokenEnvironment` (the name of a variable provisioned securely to the host worker). Never put a token in routes JSON. A missing or expired service token fails without falling back to a personal account. The plugin never reads macOS Keychain directly or asks for the Mac login password. Tokens are never tool results.

The host daemon must be able to find `op` on its PATH, or the route can specify `opBinary` with its installed executable path. `bb oxi-op check --profile <profile>` explicitly checks the configured vault and can open the normal desktop CLI authorization dialog. Intake always shows the BB form first; cancellation makes no `op` call. The form identifies the configured project label, session, profile, host, vault, item and field. Optional `hostLabel` and `vaultLabel` give readable names alongside the exact identifiers. `bb oxi-op store <title> --username <name> --profile <profile>` opens the same native form used by the agent tool.

`bb oxi-op verify --profile <profile>` creates a uniquely named synthetic Login, compares its fields by a separate read and removes that test item. It returns only verification and cleanup status. Successful results, including their time, appear in `bb oxi-op status` so a disconnected caller can check before repeating a write. JSON templates are passed through `/dev/stdin`; no plaintext template file is created. The host implementation targets macOS and Linux.

Each operation has `name`, optional `purpose` (a readable reason shown before approval), `argv` (the fixed executable and arguments) and `references` (environment variable names mapped to `op://<vaultId>/<item>/<field>`). Approval shows every exact reference from the owner configuration before contacting `op`; it never obtains these labels by reading credentials. References must use the route's exact vault ID; `OP_*` overrides are forbidden. Provision service accounts with the least required vault permissions. Writing requires read permission in 1Password. Keep administrative vaults separate and use expiring credentials for them.

This plugin does not create service accounts or grant vault access. Configure those through 1Password's supported owner workflow. It does not isolate other processes running as the same OS user. BB confirmation governs this plugin's operations; service-account permissions and host isolation define the underlying security boundary. Desktop CLI approval authorizes a terminal session to the account and is broader than one item; the BB form is not a replacement for that account-level authorization.

## Development

Run `npm ci`, `npm run typecheck`, `npm test` and `bb plugin build .` in this directory. Tests use synthetic values. Install with `bb plugin install <source> --subdirectory plugins/oxi-op`. A local path must be readable by the BB server; a Mac path cannot be installed directly by a remote Linux server.
