# Updating Account Pool Balanced

Run on the BB server host, from a checkout of this repository:

```sh
git pull --ff-only
bash scripts/upgrade-pool.sh --check
bash scripts/upgrade-pool.sh
```

Requirements: `bb`, `git`, Python 3.9+ and a local BB connection. The entrypoint
supports system Bash 3.2 on macOS. Keep both script files together; do not pipe
only the shell file into Bash. State is located using `bb status --json`.

The script verifies the installed source and the latest compatible immutable
GitHub release. Supported ranges: caret, tilde and exact stable versions. Other
ranges fail before mutation. An unchanged installed version and SHA return
`ALREADY_CURRENT` without reloading.

- `--check`: validate the installation and release without waiting or updating.
- `--version X.Y.Z`: require the latest compatible release to equal this version.
  This is an assertion, not an arbitrary version/downgrade selector: BB's update
  command has no version flag. A mismatch stops before update.
- `--interrupt-now`: offer the interruption question immediately if busy.
  The flag itself does not authorize interruption.

Updates require three consecutive idle checks. Status is printed each minute.
After five minutes, interruption of all remaining pool requests is offered; only
`yes` or `да` entered on the terminal within a minute confirms it. No answer or
no terminal means continue waiting up to fifteen minutes, then cancel. Last-used
hosts and active BB thread IDs are hints, not exact request ownership. Threads
are not stopped separately.

Before update, a private directory under BB's backups contains an online SQLite
backup, copied secrets, account/routing inventory, configuration and previous
source metadata. A process lock prevents simultaneous updater runs. Source,
release, configuration and idle state are rechecked immediately before update.
New traffic can still arrive after that check; BB owns reload and draining.
A release published between final validation and BB's resolution cannot be pinned
with the current CLI; a different resulting SHA fails post-update verification.

After update, version/SHA, account policies, priorities, roles, routing, previous
configuration values and database integrity are checked. Live quota counters are
not compared. Quota refresh is not an update gate. The run directory contains a
final `PASS`, `PREFLIGHT_PASS`, `ALREADY_CURRENT` or `FAILED`. Errors appear in the
terminal; command diagnostics stay in the private log. Never publish backups.

## Recovery

Failures retain the backup and its `RECOVERY.txt`. The updater never removes the
plugin or restores a database over a running server. BB removal deletes state,
and the CLI has no arbitrary-version downgrade command. Stop BB through normal
host service controls before restoring data; preserve the failed directory and
restore the database and secrets with a compatible previous plugin build. Use
saved source/configuration metadata and supported BB recovery tooling. If the
necessary downgrade is unavailable, keep BB stopped and obtain BB support.
A data-only restore is not a code rollback.

If the highest compatible numeric tag has no immutable stable release (including
a numeric tag marked prerelease in GitHub), the updater stops. It cannot safely
fall back to an older release: BB resolves Git tags independently and has no
version-selection option. Publish the intended immutable stable release or resolve
the source/tag issue before retrying; the updater does not change remote tags.
