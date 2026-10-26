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

`bash scripts/upgrade-pool.sh --pause-sessions --version X.Y.Z` is an explicit
maintenance operation affecting **all active or starting BB sessions across all
projects and connected hosts**, including the session that starts maintenance.
It does not change concurrency limits, routing, accounts, or models. Run it in a
separate BB terminal, not an agent-owned shell: stopping that agent must not kill
the maintenance executor. Previously idle sessions are never started.

BB currently exposes stop and follow-up, rather than a transparent active-process
pause. This mode interrupts current turns and releases their runtimes, retaining
thread history and provider settings. Once maintenance ends, it sends a continuation
to each unchanged session it successfully stopped, without model/provider overrides.
An interrupted tool may have already performed an external action; continuation is
not a transaction rollback or instruction replay guarantee.

Release and local-server preflight run before any session is stopped. The complete
unpaginated public `threads.listRunning` API (`GET /api/v1/threads/running`)
includes hidden sessions; the bounded CLI thread list is not used for selection.
Unavailable or malformed inventory fails before any stop. A private,
atomically persisted `sessions.json` records intent and outcome for each command.
The existing upgrade lock, verified backup, immutable release pin, settings checks,
and post-update verification still apply. Forced pool interruption is disabled.
After stopping sessions, the idle wait is bounded to 90 seconds. New sessions,
external clients and continuations are not blocked and can still cause a safe abort.
On ordinary failure or cancellation, continuation is attempted for stopped sessions.
An update failure does not imply the pool is healthy; inspect the existing recovery
receipt when post-update checks fail.

If the executor crashes, restart the continuation step explicitly using
`bash scripts/upgrade-pool.sh --resume-sessions /path/to/upgrade/sessions.json`.
This command shares the upgrade lock, verifies the receipt belongs to this server's
backup directory, and never updates the pool. It continues only sessions still idle
with exactly the post-stop metadata and unchanged project, environment and provider
identity throughout the stop transition. Owner edits, changed sessions and already
completed continuations are skipped. A command whose outcome is uncertain is marked
for inspection rather than repeated, preventing duplicate continuation messages.
There is no automatic recovery while the executor is dead, no watchdog or daemon,
and no promise of recovery after SIGKILL without this explicit step.

BB does not expose an atomic compare-and-stop/send operation: another actor can
change a session between metadata validation and the command. Coordinate a single
maintenance window and avoid manual session operations during it. This mode is an
explicit all-session interruption, not an admission barrier or a way to pause only
provably pool-owned requests. Receipts contain identifiers and timestamps only;
titles, prompts, request bodies and credentials are not copied.
