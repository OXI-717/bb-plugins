# OXI OP

Native BB tools for project-scoped 1Password credential intake and configured credential use. Requires 1Password CLI on the selected enrolled host and BB SDK 0.6.104 or newer.

`oxi_op_store` opens a password form in BB, writes a Login item through JSON stdin, independently reads it back and compares both fields. The password stays out of model arguments, command arguments, transcript history and local temporary files. It passes through BB's server memory and the selected host. Repeating the same title and values recovers an uncertain write; an existing differing item is never overwritten.

`oxi_op_run` executes an owner-configured command using `op run`. The agent selects an operation name, never command arguments or secret references. Command stdout and stderr are discarded; only completion is returned. Approval is required by default. Disable approval only for routine operations you intend to run unattended.

## Configuration

Configure `routes` in BB plugin settings, outside the source repository. Each BB project must have exactly one route. Example with synthetic identifiers:

```json
[
  {
    "projectId": "example-project",
    "hostId": "example-host",
    "vaultId": "example-vault",
    "keychainAccount": "example-service-account",
    "requireApproval": true,
    "operations": []
  }
]
```

On macOS the service-account token is read from Keychain service `oxi.op.agent-service-account`, with the configured account name. Alternatively use `tokenEnvironment` to name an environment variable supplied securely to the host worker, including on Linux. Exactly one credential source is required. Tokens are never plugin settings or tool results. A missing or expired token fails without falling back to a personal account.

Each operation has `name`, `argv` (the fixed executable and arguments) and `references` (environment variable names mapped to `op://<vaultId>/<item>/<field>`). References must use the route's exact vault ID; `OP_*` overrides are forbidden. Provision service accounts with the least required vault permissions. Writing requires read permission in 1Password. Keep administrative vaults separate and use expiring credentials for them.

This plugin does not create service accounts, bootstrap Keychain tokens or grant vault access. Configure those through 1Password's supported owner workflow. It does not isolate other processes running as the same OS user. BB confirmation governs this plugin's operations; service-account permissions and host isolation define the underlying security boundary.

## Development

Run `npm ci`, `npm run typecheck`, `npm test` and `bb plugin build .` in this directory. Tests use synthetic values. Install with `bb plugin install <source> --subdirectory plugins/oxi-op`. A local path must be readable by the BB server; a Mac path cannot be installed directly by a remote Linux server.
