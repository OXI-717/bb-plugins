---
name: automation-catalog
description: Inspect the unified automation inventory, source freshness and execution history across schedulers in BB.
---

Use `bb automation-catalog list --json` to inspect up to 100 entries and the total count.
Use `bb automation-catalog detail <key> --offset 0 --json` for 25 history records.
For the complete inventory, use `bb plugin rpc call automation-catalog catalog_list --json`.

The plugin displays observations. It does not run, pause or modify jobs.
A source's declared state is distinct from its observed live state. Missing times and outcomes must not be inferred.
A stale or failed source retains its last successful inventory; do not treat this as fresh evidence.

Collectors are optional Python scripts in this package. Local collection requires an explicit selection file.
Never scan and publish every local job by default. Do not include private metadata or results without authorization.
Publish a validated snapshot with `bb plugin rpc call automation-catalog catalog_publish --input-file snapshot.json --json`.
Connection settings, snapshots, logs and credentials belong outside the source repository.
