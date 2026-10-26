# Updating Account Pool Balanced

Run on the BB server host, from a checkout of this repository:

```sh
git pull --ff-only
bash scripts/upgrade-pool.sh --sandbox
bash scripts/upgrade-pool.sh --check
bash scripts/upgrade-pool.sh
```

Requirements: `bb`, `git`, Python 3.9+ and a local BB connection. The entrypoint
supports system Bash 3.2 on macOS. Keep the shell entrypoint and its Python modules together; do not pipe
only the shell file into Bash. State is located using `bb status --json`.

The script verifies the installed source and the latest compatible immutable
GitHub release. Supported ranges: caret, tilde and exact stable versions. Other
ranges fail before mutation. An unchanged installed version and SHA return
`ALREADY_CURRENT` without reloading.

- `--sandbox`: rehearse the whole workflow on temporary synthetic SQLite state
  and a strict command/HTTP simulator. Executes the real idle reporter, backup
  and post-update checks. Real subprocesses and network connections are blocked.
  No BB installation or credentials are required; temporary files are removed
  afterward. This validates control flow, not live provider availability.
- `--check`: validate the installation, release and live diagnostic report
  without waiting or updating.
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
are not stopped separately in the default idle-only mode.

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

## Stop sessions, update, continue

Install the accepted `pool-maintenance` release separately from the pool. This
independent plugin holds the session queue while the pool itself is reloaded.
Use `bash scripts/upgrade-pool.sh --pause-sessions --version X.Y.Z` from a separate
BB machine terminal. Stopping the initiating session must not kill the executor.

After release/server preflight, acquire an exclusive 30-minute hold on new BB
dispatches across **all projects and hosts**, then snapshot active/starting
sessions through the unpaginated public threads.listRunning API. Stop current
turns with history/provider settings retained. The hook queues starts, follow-ups,
steers and retries, instead of rejecting them. Queue cards and sidebar clocks
show the reason. No concurrency limits change.

The existing upgrade lock, verified backup, immutable release/source verification,
settings and post-update checks remain mandatory. Forced pool interruption stays
disabled; drain is bounded to 90 seconds. Before wait, backup and update, the owned
hold must have 15 minutes remaining. Missing/foreign/expiring hold refuses update.
External HTTP clients are outside the BB queue and can still cause a guarded abort.
Do not unload this plugin during an operation: core may clear orphaned waits.

On success or ordinary failure, queue continuations for unchanged stopped sessions
without provider/model overrides, then release the owned hold and recheck the queue.
Previously idle sessions do not start unless they have real queued user work.
Already queued user work is preserved without adding a redundant continuation.
An ended operation does not imply a successful update; read the result separately.

BB stop interrupts the turn rather than freezing a process. An interrupted tool
may already have performed an external action. Native BB has no atomic compare-
and-stop/send, so use one coordinated window and avoid manual session changes.
Observed identity changes are skipped, not overwritten.

Private atomic/fsynced sessions.json records ownership and command intent/outcome.
After executor death use `--resume-sessions /path/to/upgrade/sessions.json` with
the accepted updater. Recovery shares the upgrade lock, continues only unchanged
sessions, never blindly repeats uncertain sends, and releases only its own hold.
Queued messages carry the finite deadline; core re-attempts after expiry without
a daemon, cron or watchdog. Stopped sessions without queued work need explicit
recovery. Lease state survives plugin restart and expiry is checked at startup.
No recovery is promised while BB is not running. No prompts or credentials in receipts.
