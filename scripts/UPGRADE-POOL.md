# Updating Account Pool Balanced

Run on the BB server host, from a checkout of this repository:

```sh
git pull --ff-only
bash scripts/upgrade-pool.sh --sandbox
bash scripts/upgrade-pool.sh --check
bash scripts/upgrade-pool.sh --pause-sessions
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
dispatches across **all projects and hosts**, then snapshot active/starting
sessions through the unpaginated public threads.listRunning API. Stop current
turns with history/provider settings retained. Only after that saved stop does the
updater acquire the model hold, which interrupts model and auxiliary traffic.
The hook queues starts, follow-ups,
steers and retries, instead of rejecting them. Queue cards and sidebar clocks
show the reason. No concurrency limits change.

The existing upgrade lock, verified backup, immutable release/source verification,
settings and post-update checks remain mandatory. Forced pool interruption stays
disabled; drain is bounded to 90 seconds. Before wait, backup and update, the owned
hold must have 15 minutes remaining. Missing/foreign/expiring hold refuses update.
The pool admission hold covers external clients as well as BB: new model calls
return a provider-native 503 with `x-bb-pool-error: POOL_MAINTENANCE` and
`Retry-After: 30`. Budget/readiness routes report paused. Routing, account opt-ins,
scheduler state and VPN policy remain unchanged. External schedulers can still
tick; their pool model requests cannot dispatch. Direct traffic outside this pool
is outside this boundary.

Admission rechecks immediately before every upstream send. Acquisition cancels
old admission generations, active streams and auxiliary transport; queued or
half-prepared inference cannot redispatch after release. The updater also waits
for credential/quota work and native leases to finish. Native acquisition, poll
and unlock admission refuse, but confirmed release/cancellation remains available.
An unconfirmed native process stops the update; its lease is never force-cleared.
A request already sent can have an ambiguous outcome and is never replayed by
this updater. The model hold is persisted before acknowledgement and loaded before
new routes are exposed after reload. Missing or malformed ownership evidence
refuses the update.
Do not unload this plugin during an operation: core may clear orphaned waits.

On success or ordinary failure, release only the owned model hold, then queue continuations for unchanged stopped sessions
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


## Update from the pool interface

Pooler 0.4.79+ includes **Обновить Pooler** in its settings. It launches the same
accepted `--pause-sessions` updater in a BB machine terminal on the server host.
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
previously accepted updater and a coordinated idle window once. The new updater
refuses the missing API before stopping sessions; it never claims that old external
clients were paused. Subsequent CLI and interface updates use both barriers.

## Natural completion without interruption

Use `--drain-sessions --grant-file "$GRANT_FILE"` in an independent machine
terminal. The grant is operator-issued JSON, mode 0600; it is read privately and
sent through stdin. The updater no longer discovers a management root key.
The coordinator revokes the grant when the operation finishes.
The dispatch queue is held for at most 30 minutes; natural completion waits up
to 600 seconds (`--drain-timeout`). No thread stop, continuation, model interrupt
or concurrency change occurs. Three complete empty inventories are required.
The owned all-client barrier uses `acquire-graceful`, which blocks admission
without aborting existing transport. The usual backup, idle checks and source,
account, routing and integrity validation still run. Release and recovery retain
ownership checks; the private receipt has no stopped sessions to restart.

Bootstrap: installations without `acquire-graceful` cannot use that API. There is
no fallback to cancelling `acquire`. Coordinate a separately proven idle window
with external admission controlled before first installation. Active external
requests are a blocker, even when BB sessions have finished.

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
