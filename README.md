# OXI Public Plugins for BB

Open-source plugins for [BB](https://github.com/get-bb/bb). Each plugin has its own directory, version and immutable release tags. This repository currently ships **Account Pool Balanced**.

## Account Pool Balanced

Use multiple accounts of the same provider, track available quota and switch accounts when needed. Sequential and balanced routing, primary/reserve accounts, per-account caps and session affinity are supported.

Adapters exist for Claude, Codex, Kimi, Z.AI, OpenCode Go and Cursor. Authentication and model availability depend on each provider. Claude and Codex support subscription login flows; other adapters use their supported provider keys. This does not turn every consumer subscription into an API account.

The pool is a BB plugin, not a standalone server or a hosted subscription service. It starts empty; you add your own accounts. Cursor additionally requires an operator-configured ACP provider and wrapper; see [Cursor routing](plugins/account-pool-balanced/docs/cursor-paths.md). Devin is not a supported pool client.

## Install

Install BB 0.43.1+ and Node/npm first. The release is checked with BB 0.43.3 and Node 22.

```sh
bb marketplace add git:https://github.com/OXI-717/bb-plugins@main
bb plugin install account-pool-balanced@oxi-public
```

Or install the release directly:

```sh
bb plugin install git:https://github.com/OXI-717/bb-plugins.git@^0.2.4 --subdirectory plugins/account-pool-balanced --tag-prefix account-pool-balanced/
```

Do not enable BB's built-in `account-pool` at the same time: both register `bb pool` and provider routes. If replacing an existing installation, preserve its data and use source replacement through `bb plugin install`; do not remove it just to update.

Add accounts through the pool settings in BB or run `bb pool --help`. For example, `bb pool account add --provider codex --login` starts a device login. Follow the returned instructions, then repeat to add another account. `bb pool status` shows the resulting pool. Browser login can be completed on a different device from the BB server.

Access from a computer or phone is provided by BB and its authenticated remote access. The plugin does not ship a separate mobile app. See [setup guidance](docs/setup.md).

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
