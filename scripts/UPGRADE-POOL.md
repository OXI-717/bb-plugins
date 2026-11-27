# Updating Account Pool Balanced

Run on the BB server host, from a checkout of this repository:

```sh
git pull --ff-only
bash scripts/upgrade-pool.sh --sandbox
bash scripts/upgrade-pool.sh --check
bash scripts/upgrade-pool.sh --drain-sessions --operator-key-file "$OPERATOR_KEY_FILE"
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
The session-pause mode also holds a persisted all-client admission barrier through
backup, reload and verification. The idle-only mode has no such barrier; BB owns
reload and draining if new traffic arrives after its final check.
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

After release/server preflight and model-pause API validation, hold new BB
dispatches across **all projects and hosts** and acquire the model upgrade hold.
Snapshot active/starting sessions through the unpaginated public threads.listRunning
API and stop current turns with history and provider settings retained. The
dispatch hook queues starts, follow-ups, steers and retries. Queue cards and
sidebar clocks show the reason. No concurrency limits change.

The existing upgrade lock, verified backup, immutable release/source verification,
settings and post-update checks remain mandatory. Forced pool interruption stays
disabled; drain is bounded to 90 seconds. Before wait, backup and update, the owned
hold must have 15 minutes remaining. Missing/foreign/expiring hold refuses update.
The model hold parks new authenticated HTTP requests before they start their
account queue deadline. Requests already admitted can drain. Once model work
drains, the updater seals admission before backup, preventing new auxiliary
transport. Budget and readiness routes report paused. New native leases, queued promotion and unlock admission are refused.
Authenticated polls for existing active leases keep their usual Guard and
route checks during drain. Confirmed release and cancellation remain available. If an unconfirmed native process prevents the update, the failure
lists the executor, lease kind, age and operator confirmation command.
The model hold is persisted and loaded before new routes are exposed after
reload. The updater never resends a request that reached its provider.

Do not unload this plugin during an operation: core may clear orphaned waits.

On failure, release both owned holds before verifying or sending session
continuations. Parked HTTP requests can then enter the account queue with
their full wait budget. On success, release the model hold, queue continuations
for unchanged stopped sessions without provider or model overrides and then
release the dispatch hold. The updater verifies
that each continuation is queued or running. It retries once if the thread still
matches its stopped snapshot and no work was queued. The private session receipt
and update log list uncontinued threads and their reasons.
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


## Update from the pool interface

Pooler 0.4.79+ includes **Обновить Pooler** in its settings. It launches the same
accepted `--drain-sessions --drain-timeout 2400` updater in a BB machine terminal on the server host.
The terminal survives pool reload and does not belong to a stopped agent thread.
Before launch, a private operation directory receives a fixed copy of the updater
and its Python modules. Its working directory is outside the managed Git cache,
so removal of the previous checkout cannot break verification or recovery.
The browser supplies no command, host, version or file path. The installed Git
source must retain this repository's scripts, and `pool-maintenance` must be enabled.
An unchanged immutable release performs only preflight and leaves work running.

A durable operation receipt prevents double-clicks and survives reopening the UI.
After an uncertain terminal-create response, the controller searches only the
operation UUID title on its recorded host; it never automatically starts a second
updater. Missing/ambiguous terminal evidence remains `unknown`, requiring inspection
of the BB machine terminal and private recovery receipt. A failed or disconnected
terminal is not reported as a successful update.

Bootstrapping from an older pool without the model-admission API requires its
previously accepted updater and a coordinated idle window once. The drain updater requires the installed Pooler to advertise native drain support
before taking either hold. The extended mode also requires `pool-maintenance`
with `acquire-drain`. It never falls back to stopping active turns.

## Natural completion without interruption

Use `--drain-sessions --grant-file "$GRANT_FILE"` in an independent machine
terminal. The grant is operator-issued JSON, mode 0600; it is read privately and
sent through stdin. The updater no longer discovers a management root key.
The coordinator revokes the grant when the operation finishes. Short-lived grants
do not survive plugin reload: use `--operator-key-file "$OPERATOR_KEY_FILE"` for
a durable update. This explicit private file is never discovered automatically;
the existing management client issues and revokes a fresh 60-second grant for
each command, including post-reload validation and hold release. The interface
passes only a fixed server-owned file path, never its contents; the browser
cannot choose a path or command. The two credential flags are mutually exclusive.
In CLI mode, the natural drain waits up to 600 seconds by default. The update
button uses 2400 seconds to give BB's default 30-minute idle-provider reaper time
to close warm runtimes. A drain longer than 600 seconds takes a bounded one-hour
dispatch hold instead of the normal 30-minute hold. The updater verifies the
remaining time before sealing and before reload. It never changes BB's idle
timeout. If the configured timeout or remaining work outlasts the drain, both
owned holds are released and the installed plugin stays in place.

BB turns finish under the dispatch hold before the all-client upgrade hold is
taken. Once the second hold starts, no new native lease or queued promotion is
allowed. Existing active native leases can renew with normal Guard and owner
checks. Active and unconfirmed native leases block sealing until the authoritative
release or stop confirmation is durably stored. An ordinary queued native lease
is not permission to run. The updater verifies the sealed hold through backup and
reload before reopening admission. It does not stop BB threads or replay prompts.
Unexpected plugin restart retains the existing quarantine for active leases.

For the first installation on a Pooler without `nativeDrain`, coordinate an idle
window using the existing accepted updater. Install the released extended
queue hold before using the new button. A reaped warm ACP process releases its
lease through the normal launcher cleanup. Unsupported or unconfirmed runtimes
remain blockers, even after BB turns have finished.

## Candidate preflight before publication or installation

`--candidate-preflight "$MANIFEST" --receipt-output "$RECEIPT"` performs no
installation or production writes. The JSON manifest contains `artifacts` (map
of repository-relative paths to SHA256), explicit `tests` (existing relative
`src/*.test.ts` or `.tsx` paths), and optional credential-free HTTPS `network`
endpoints. It runs typecheck, those suites and the plugin build. Private receipt
and command log record UTC timestamps. DNS/TCP/TLS is separate from provider
inference. Missing host bundle, policy preservation, protocol, eligibility and
live provider receipts remain `unknown`; exit 2 means the aggregate is not ready.
A successful fixture suite never establishes live subscription or billing state.
