# OXI Public Plugins for BB

Open-source plugins for [BB](https://github.com/get-bb/bb). Each plugin has its own directory and versioned release tags. GitHub Release immutability is enabled for releases published after 0.3.0; the earlier 0.3.0 release is not protected retroactively. This repository ships **Account Pool Balanced**. **Automation Catalog** adds a unified view across schedulers.

## Account Pool Balanced

Use multiple accounts of the same provider, track available quota and switch accounts when needed. Sequential and balanced routing, primary/reserve accounts, per-account caps and session affinity are supported.

Adapters exist for Claude, Codex, Kimi, Z.AI, OpenCode Go, Cursor and Devin Local CLI. Authentication and model availability depend on each provider. Claude and Codex support subscription login flows; other adapters use their supported provider keys. This does not turn every consumer subscription into an API account.

Version 0.4.1 preserves the native 1M Opus context window for Claude Code threads routed through the BB pool. Version 0.4.0 adds experimental Devin Local CLI proxying with server-side PAT storage and an isolated launcher for `devin -p` and ACP: see [external clients and standalone setup](plugins/account-pool-balanced/docs/external-clients.md). Both modes start with your own accounts; no credentials are distributed. Cursor additionally requires an operator-configured ACP provider and wrapper; see [Cursor routing](plugins/account-pool-balanced/docs/cursor-paths.md). Devin cloud sessions continue to use their separate API.

## Install

Install BB 0.43.1+ and Node/npm first. The release is checked with BB 0.43.3 and Node 22.

```sh
bb marketplace add git:https://github.com/OXI-717/bb-plugins@main
bb plugin install account-pool-balanced@oxi-public
```

Or install the release directly:

```sh
bb plugin install git:https://github.com/OXI-717/bb-plugins.git@^0.4.1 --subdirectory plugins/account-pool-balanced --tag-prefix account-pool-balanced/
```

Do not enable BB's built-in `account-pool` at the same time: both register `bb pool` and provider routes. These install commands are for new installations. BB 0.43.3 rejects replacing an existing plugin's Git source. If migrating from another repository, keep the existing installation until you have a supported migration procedure with verified backup and restore; do not remove a live pool just to change its source.

Add accounts through the pool settings in BB or run `bb pool --help`. For example, `bb pool account add --provider codex --login` starts a device login. Follow the returned instructions, then repeat to add another account. `bb pool status` shows the resulting pool. Browser login can be completed on a different device from the BB server.

Access from a computer or phone is provided by BB and its authenticated remote access. The plugin does not ship a separate mobile app. See [setup guidance](docs/setup.md).

## Use from Orca, terminals and other applications

BB is optional: run the standalone server, or connect external clients to accounts already managed by BB. Claude Code uses Messages; Codex uses Responses. Other clients must support the corresponding native protocol and a configurable base URL/token.

The [external-client quickstart](plugins/account-pool-balanced/docs/external-clients.md) includes copyable Claude/Codex commands, standalone installation, remote access and troubleshooting. No private launcher or custom Orca plugin is required. BB-routed Claude Code threads preserve Opus 5.5's 1M context automatically. For external Claude Code clients, select `claude-opus-5-5[1m]` to avoid the client's 200K context default. Client usage screens do not aggregate pool balances.

## Update

```sh
bb marketplace refresh oxi-public
bb plugin update account-pool-balanced
```

Settings and account material stay in your BB instance. Updating a running pool can interrupt active streams; choose an idle moment.

## Development

```sh
cd plugins/account-pool-balanced
npm ci
npm run typecheck
npm test -- src/balancer.test.ts src/store.test.ts src/server.test.ts app.test.tsx
bb plugin build .
```

CI runs all plugin tests, typechecks and builds on standard GitHub-hosted runners. The repository also checks manifests and scans Git history for secrets. Accounts or live subscriptions are not required for CI.

## License

MIT. Account Pooler and vendored UI derive from `get-bb/bb`; upstream attribution is preserved in [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Automation Catalog

An independent panel for inventory, source freshness and execution history across schedulers. It does not execute jobs or invoke models. See [development and source setup](plugins/automation-catalog/README.md). Install through `bb plugin install automation-catalog@oxi-public`, or use the release command in its README.
