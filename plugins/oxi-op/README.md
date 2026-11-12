# OXI 1Password

Native BB tools for project-scoped 1Password credential intake and configured credential use. Requires 1Password CLI on the selected enrolled host and BB SDK 0.6.104 or newer.

`oxi_op_store` opens a password form in BB, writes a Login item through JSON stdin, independently reads it back and compares both fields. The password stays out of model arguments, command arguments, transcript history and local temporary files. It passes through BB's server memory and the selected host. Repeating the same title and values recovers an uncertain write; an existing differing item is never overwritten.

`oxi_op_run` executes an owner-configured command using `op run`. The agent selects an operation name, never command arguments or secret references. Command stdout and stderr are discarded; only completion is returned. Approval is required by default. Disable approval only for routine operations you intend to run unattended.

`bb oxi-op run <operation> --profile <profile>` uses the same project scope and approval gate as `oxi_op_run`, including when newly registered agent tools are not yet available in an existing provider session. It accepts only a configured operation name.

Forms resolve the current project, thread and execution machine names directly from BB metadata before contacting 1Password. The invoking project and the configured access label are displayed separately. Unavailable names are explicit. IDs and exact secret references are collapsed under technical details. Set an operation's `label` and `referenceLabels` (environment name mapped to `{ "item": "Example server", "field": "Password" }`) for readable operation and record names; these labels stay in private plugin settings alongside the exact references.

## Configuration

For owner setup, `oxi_op_inventory` or `bb oxi-op inventory --profile <registry-profile> --title <registry-item-title>` first displays a contextual BB approval. Only after submission does it use desktop CLI access to read the configured service registry and return vault metadata matching the registry's IDs. Cancellation never invokes `op`. Prefer native tools: BB resumes the requesting agent when their form completes. A CLI caller must remain connected; a persistent BB terminal preserves the form but does not itself resume an idle agent.

When native tools are unavailable in an older provider session, interactive CLI commands accept `--notify`. Every BB approval and intake form, native or CLI, expires after 60 seconds. An expired request is cancelled before any credential call; it is never retried automatically. Completion sends a value-free notice through the BB SDK to the same invoking thread, queued if it is active. Success, cancellation and failure all direct the agent to inspect the durable history; notification failure never retries a credential operation. Stopped requests and moved, archived or deleted threads are not resumed. Ordinary CLI calls omit this flag and never start an agent turn.

`oxi_op_history` and `bb oxi-op history` recover the latest 30 operations for the invoking project and thread without contacting 1Password. The server persists preparation, approval, execution and completion states and strictly validated non-secret results. Cancellation records retain only a fixed reason code (for example, `timeout` or `user`); timeout is not a user rejection and does not prove the client displayed the form. Older records may have no reason. Form values, service tokens, command output and exception text are never journaled. Records survive plugin reload and server restart; unfinished records from a previous plugin instance are shown as `interrupted`, not as completed or undone. Check these records before repeating an uncertain write. Failed native operations return an explicit `completed: false` result so BB can deliver failure to an idle agent as well as success.

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

1Password service-account vault grants and permissions are immutable after creation; plan the required scope before issuing a token. A service token can read the permitted vault, so a route profile is not an item-level permission boundary. Keep unattended API credentials out of a vault containing administrative passwords. Create additional vaults only when that access distinction is actually needed. See the [official service-account setup documentation](https://www.1password.dev/service-accounts/get-started).

This plugin does not create service accounts or grant vault access. Configure those through 1Password's supported owner workflow. It does not isolate other processes running as the same OS user. BB confirmation governs this plugin's operations; service-account permissions and host isolation define the underlying security boundary. Desktop CLI approval authorizes a terminal session to the account and is broader than one item; the BB form is not a replacement for that account-level authorization.

## Development

Run `npm ci`, `npm run typecheck`, `npm test` and `bb plugin build .` in this directory. Tests use synthetic values. Install with `bb plugin install <source> --subdirectory plugins/oxi-op`. A local path must be readable by the BB server; a Mac path cannot be installed directly by a remote Linux server.

Owner-requested project onboarding uses `bb oxi-op connect --project <project-id> --profile <desktop-setup-profile>` from an already configured setup session. It shows a 60-second BB approval before desktop authorization, creates one project vault with an exact project marker, independently reads it back, and adds a default desktop route. Existing routes are preserved; an existing default or an unmarked namesake fails closed. No automatic read operations or service tokens are granted. After interruption, inspect history and settings before retrying; a created vault may remain and can be recovered by its exact marker. Use `--notify` in a persistent terminal when native tool lifecycle is unavailable.

For an owner-approved batch, use `bb oxi-op connect-many --projects '<JSON-array>' --profile <desktop-setup-profile>`. Each target has `projectId` and optionally `existingVaultId` from a verified service inventory and `vaultName` (default: the project name). Targets with the same `vaultName` in one batch share one vault created for the first of them; a later run joins it only through its exact `existingVaultId`. New routes inherit the setup route's owner machines. A tool call in a project without a route returns `project_not_connected` without opening a form. One 60-second BB approval lists every pending project. Existing default routes are skipped; successful routes persist even if a later project fails. Inspect every returned project state and settings after interruption; `needs-review` is not success and must not trigger automatic retries. Existing vault IDs require matching project names and an independent vault read. This configures intake only; it does not grant unattended access, reactivate projects, or automatically onboard future projects.

## Prepared native tasks (optional, Linux, default off)

The ordinary `run` tool/CLI still requires its real BB thread. A prepared native
executor instead uses the existing Account Pooler admission endpoint. There is
no fabricated thread ID and no new daemon. BB must supply verified plugin RPC
attribution and cancellation context (BB 0.48.1+); an older runtime refuses this
optional path. Ordinary operations retain their existing policy.

Only Account Pooler's server plugin can invoke `runPreparedTask({requestId})`.
Oxi Op calls back through the SDK to `claimNativeUnlock`; only Oxi Op's verified
plugin caller can consume it. Account Pooler rechecks the actual admission,
Guard, project, purpose, executor and prepared route, then **persists** one consume
before returning the immutable host/executor/account/runtime/profile/version/
lease/session/caller tuple. A request ID is a locator, never a bearer capability.
Catalog leases cannot issue a request. The deadline is at most 25 seconds and
never beyond the issuing lease. Restart, failure and cancellation retain an
uncertain occupied lease; there is no automatic replay, alternate route or release.

An owner must explicitly prepare all three matching configurations later:

- Pooler executor `unlock: {"profile":"example-unlock","operation":"prepared-native-keyring-unlock"}` alongside its existing prepared `execution`.
- Oxi Op route for that exact admitted project and access profile, exact execution
  host, `authentication: "service-account"`, `tokenSetting: "projectServiceAccounts"`,
  `requireApproval: false`, no credential host, and exactly one named operation
  with empty `references`. Its fixed argv is the installed Python path, `-I`, the
  installed `native_unlock.py` path and `--automatic`.
- Root-owned Fleet unlock authority with matching `automaticProfile`, pinned
  manager binary digest, fixed vault/item and existing prepared runtime identity.
  The new field is absent by default. It does not enable any account or executor.

The encrypted project/profile token needs an owner-created read grant for the
single-purpose unlock vault; the route map cannot narrow a broad provider grant.
Missing configuration refuses without using a desktop route, another project's
mapping, `control-setup`, caller environment or arbitrary secret references. This
source change creates no token, route, grant, root authority or installation.

The actual host entry runs only that fixed operation through the pinned manager's
`run --` interface. A bounded length-prefixed stdin frame conveys the assignment
and expected wrapper PID; token context is confined to the operation chain.
Neither stdout, tool results nor environment passed to the scoped model/tools
contains the unlock value. The existing private Unix channel supplies it to the
launcher, which waits for operation cleanup before launching the native child.
The operation independently polls the real current consumed task before and
throughout lookup. Manual waiting operations refuse an automatic grant.

On Linux, the isolated bootstrap binds wrapper to host, operation to wrapper and
lookup to operation using kernel parent-death signals plus expected-parent checks.
Privileged/capability-bearing manager exec is refused. Abort/deadline also kills
the owned process group. This does not cover arbitrary self-detaching descendants
or same-UID hostile processes. An incompatible installed manager process topology
refuses; its real compatibility still needs a separately approved test window.

`task.test.mjs` exercises actual SDK validation/attribution, Pooler consumption and
Oxi Op server dispatch with synthetic host calls. The companion Fleet integration
uses `test/native-task-host.mjs` to dispatch the **actual host handler**, fake
manager, private Unix channel and existing native supervisor. Set
`OXI_TEST_OP_SOURCE` to this prepared source directory for that optional test after
normal TypeScript test compilation. Root ownership and the loopback test CA are
explicit fixture seams. There is no installed-manager/grant/Google or Mac claim.

Agent access is issued with `bb oxi-op automate --projects <id,id> --profile <desktop-setup-profile> --host <proof-machine-id> --session-hosts '<JSON machine-id to op path>'`. After one 60-second BB approval, the owner desktop account creates or recovers, per project, a dedicated `<Project> — Automation` vault and two service accounts limited to it, without an expiry unless `--expires-in` (for example `90d`) is given: `routine` (read only, no approval form, for agents) (read and write, used by the private intake form). Neither can share items or create vaults. Each token is backed up through stdin into the project's owner-approved default vault before use, so a retry recovers it instead of issuing a duplicate. Tokens are kept only in the encrypted `projectServiceAccounts` setting. Each project's routes are activated only after the proof machine shows that the reader sees exactly that vault and cannot write, and that intake can write and verify a synthetic item. A failed issue or probe is `needs-review` for that project; do not retry automatically. `--reissue` replaces agent access, configured or not: after one approval every existing token backup is set aside under a dated title and new accounts are issued, so a leaked, expired or faulty token is never brought back. The working tokens and routes stay until the replacements prove their scope and are then swapped in one settings write. A failed reissue leaves its new accounts visible through their set-aside backups. Without `--reissue`, existing backups are recovered with the lifetime they were issued with. The replaced accounts remain valid until the owner deletes them in 1Password; the CLI cannot delete service accounts.

Three kinds of access. Agent keys (`routine`): a project's `<Project> — Automation` vault read by a scoped service account; agents use `oxi_op_keys` (titles and field names) and `oxi_op_exec` (command with keys in environment variables) on the machine of their session, without forms, when that machine is listed in the route's `sessionHosts`. The child never receives `OP_*` variables or the service token, and exact key values are replaced in returned output. Key intake (`intake`): the private BB form writes to the same vault with a separate write-capable account. Critical passwords (`default` and other desktop profiles): a BB approval card, then the owner's 1Password confirmation on the first online Mac from `desktopHosts`; agents get these only through an owner-approved card.

**Vault scheme.** Each project has one vault named after the project for critical entries (owner card and 1Password confirmation every time) and, only when agents need keys, one `<Project> — Automation` vault. `OXI.Control` holds the service registry. Agents must never create vaults or items with `op` directly — use `oxi_op_store` (form), `bb oxi-op connect-many` and `bb oxi-op automate`; ad-hoc vaults such as a separate admin vault are what `doctor` reports. `bb oxi-op doctor --profile <setup>` checks the scheme after one approval: routes to missing vaults, routes into another project's vault, several vaults per project, names outside the scheme, unrouted vaults, empty automation vaults and routes pinned to one owner machine.

`bb oxi-op tidy --profile <setup> --plan '<JSON steps>'` applies an ordered clean-up after one ten-minute card: `same` compares two entries by value hash inside 1Password and stops if they differ, `move` moves an entry, `archive` archives it (recoverable), `delete-vault` deletes a vault only if no route uses it and it is empty including the archive. `note` writes a non-secret service note (shown in full on the card) and archives its previous version.

**Broker service (macOS).** An `op` call started by the BB host is attributed by macOS to its parent, and wrappers started from BB are not remembered for app-data access, so every call raised a new prompt. `broker/op_broker.py` runs as a user LaunchAgent wrapped in a named app (for example with a launchd wrapper tool), owns the 1Password and macOS authorisation, and executes owner-approved `op` calls as its children: macOS asks once for the service, and 1Password keeps one authorisation instead of one per call. It listens on a Unix socket in a 0700 directory (socket 0600, same-user peers only), never receives service-account tokens, returns no standard error, and accepts only item, vault, read, service-account create and account commands — `op run` and everything else are refused. Input reaches `op` on a socket, as it does from the BB host, and a call without input gets `/dev/null`: `op` reads a FIFO on standard input as an item template, which breaks `item edit` and `item create --template /dev/stdin`. A macOS app-data prompt that repeats for the service even after it was allowed means the ad-hoc signature is not remembered; grant the wrapper app Full Disk Access once instead. After updating the broker file, restart the service. Point an owner machine at it with `opBroker` (socket path) in the route's `desktopHosts` entry. Example LaunchAgent program: `/usr/bin/python3 -I <dir>/op_broker.py --op /opt/homebrew/bin/op --socket <dir>/run/broker.sock`.

**Migrating local secret files.** `bb oxi-op migrate --profile <setup> --mode import --plan '<JSON [{file, title, kind, vaultId, vaultLabel}]>'` imports files after one ten-minute card that lists every file grouped by target vault: an env file becomes one Secure Note with a concealed field per variable in an "Environment" section, any other file (or an env file the reader cannot parse unambiguously) a document. Every value is read back and compared by hash; a rerun reuses an item only if all values match. `--mode reference` then rewrites each imported value in its file as `op://<vault>/<item>/Environment/<KEY>` (usable with `op run --env-file`) — only where the vault still holds identical values, keeping file mode and layout. Imported key files (documents) are never deleted: with `--archive-dir <absolute folder>` they are moved there under their path relative to home (folders 0700, created without following links — a link in the path fails with `archive-link`; an existing file there is never overwritten, `archive-exists`; on another file system the file is copied exclusively and checked byte for byte before the original is removed), without it they stay in place (`no-archive-dir`). The card names the folder. The env reader is deliberately strict: escapes or `$` expansion in double quotes, `$` outside quotes, unmatched quotes and duplicate keys make the file a document, and such an env file is never removed. The target vault's name is checked against the card before anything is written; titles must be unique per vault; one vault's failure does not hide the others' results. Symbolic and hard links are refused in reference mode so no other path keeps the plaintext; comments, empty values and Windows line endings are kept. A file the system refuses to change — the macOS immutable flag that a frozen project may carry, a read-only folder or volume — fails with `file-locked` and stays exactly as it was, with no rewritten copy left beside it; Oxi Op never unlocks files, that stays the owner's decision. Other file-system failures report `fs-<errno>`. Values never leave the credential machine; the journal keeps states only.

**Critical one-off commands.** `oxi_op_exec` with a critical profile (for example `default`) shows one card with the exact command, the session machine and each requested entry; after the owner approves it and 1Password confirms on the owner Mac, the values are read there, passed only to that command on the session machine, and concealed in its output. For SSH with a password use `sshpass -e` with the `SSHPASS` variable. Keys are taken from the item itself (`op item get --reveal`, item by exact title or ID, field by exact label or ID), not through `op read` references: those reject titles with characters such as Cyrillic letters, which made a correctly stored password unreadable. A missing, empty or ambiguous field fails with `key-field`.

`bb oxi-op overview --profile <desktop-setup-profile> [--registry <title>]` maps service vaults after one approval: which routes use each vault, item titles, categories and dates (never values), empty and unused vaults, and titles repeated across vaults. Items are listed only in vaults named by routes, the service registry or the Oxi Op marker; other vaults the owner account can see appear by name only. Setup cards (connect, automate, inventory, overview) wait ten minutes; cards that reveal, store or use a secret still expire after one minute.

Every approval card is also announced through the `push-notifications` plugin when it is installed: a notice with a link to the session and the card's deadline, without item, vault or project names. The card does not wait for the notice, and a failed notice changes nothing.

`bb oxi-op selftest --hosts <id,id>` proves agent keys of the session's own project end to end: the intake account stores one synthetic key, each listed machine lists it and reads it into a child command without `OP_*` variables, the value is compared by hash and concealed in output, and the key is always removed. Resuming an interrupted `automate` uses saved tokens only with the exact machines and op paths shown on the approved card. Agent commands run in their own process group: a timeout or cancellation ends every descendant. A process that escapes the group does not hold the call open: the command's exit code and output are returned with `escapedProcess: true`, and that process may still hold the keys.

`bb oxi-op diagnose --profile <profile>` inspects configuration and both machine statuses without contacting 1Password or opening a form. It distinguishes the credential machine from the execution machine; seeing the latter connected does not establish credential availability. Token configuration is not a provider authorization check; host-environment token presence is unknown until use. Intake, checks and execution verify machine availability before a form and again after submission. Known pre-dispatch failures carry a fixed failure code; a host transport failure after dispatch remains uncertain and must be inspected before retrying.
