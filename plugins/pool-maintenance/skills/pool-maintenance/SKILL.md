---
name: pool-maintenance
description: Inspect or hold the session queue for a bounded pool update.
---
Use `bb pool-maintenance status --json` for metadata. For authorized maintenance use
the accepted updater `--pause-sessions` from a separate terminal; it owns acquire,
release and recovery. Do not test a live pause or change concurrency settings.
All new dispatches on all hosts wait; external HTTP clients are outside this queue.
