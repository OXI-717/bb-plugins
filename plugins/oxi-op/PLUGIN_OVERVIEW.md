# Project-scoped 1Password access

Save credentials through a native BB form and use them in owner-configured operations. The agent chooses a project access profile and operation, while passwords stay out of model arguments and conversation history.

- Writes go through `op` JSON stdin and are verified by a separate read.
- Routine API access can run unattended with a scoped service account.
- Administrative access can require a BB confirmation and 1Password desktop authorization.
- Commands and vault references are configured by the owner; agents cannot supply arbitrary commands.

Install 1Password CLI on the enrolled host and configure project routes in BB settings. Service tokens use a native secret setting or a host environment variable. No direct Keychain access is used. See [setup and security boundaries](README.md).
