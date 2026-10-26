# Pool Maintenance

Install the accepted release with `bb plugin install pool-maintenance@oxi-public`.
Run the accepted updater with `--pause-sessions` in a separate BB terminal.

All new BB dispatches on every host/project wait in the native queue, including
follow-ups, steers and retries. Current turns are stopped once with history retained.
Continuation messages are queued before releasing the hold. Already queued user work
is preserved without adding redundant continuation. External HTTP clients remain
outside this queue: the updater still requires pool idle, verified backup and source.

Commands: `bb pool-maintenance status --json`, `acquire --owner <operation-uuid> --json`,
`release --owner <operation-uuid> --json` (the latter two use the same command prefix).
Acquisition is exclusive and lasts at most 30 minutes. Repeating an owner does not
extend it. A foreign owner cannot acquire or release a live pause. Release rechecks
native queued messages. Output contains operation metadata, never message content.

The finite lease persists in plugin KV and is validated on startup. Queued messages
carry its deadline as sendAt; the core clock re-attempts after expiry without a new
watchdog/daemon/cron. Plugin unload may clear orphan waits: do not unload this plugin
during maintenance. No global settings, concurrency limits, accounts, models or BB
core change. After executor death, stopped sessions without queued work still need
the updater's explicit private-receipt recovery. The updater requires 15 minutes of
hold remaining before idle wait, backup and update. Release is not update success;
read the updater result separately. Do not acquire a live hold as a test.
