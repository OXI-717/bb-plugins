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

Before using the agent composer, configure a live parent discussion thread in the plugin's
settings, or run `bb plugin config automation-catalog set parentThreadId <thread-id>`.
New discussions are children of this thread and have an editable descriptive title.
For a locally managed BB automation the composer seeds its project; otherwise it seeds
the parent's project. The user can explicitly choose a different project before submitting.
The plugin preserves that choice, model, workspace and scheduled send time.
Opening a draft never starts a thread or invokes a model. An unavailable or archived parent
blocks submission rather than creating an orphan. Existing automation discussions carry
their catalog task key in the plugin's thread metadata.

For a locally managed BB automation, the history row's “Открыть результат” reads
that exact run from BB on demand (up to the 200 latest retained runs). Only status,
output availability and native navigation are returned to the panel; raw stdout and
stderr stay server-side and are not added to catalog snapshots or storage. Agent
runs open their corresponding thread. Script output opens in the native BB history,
where the user selects the matching timestamp (BB has no per-run deep link). External and deleted tasks retain their existing source-specific paths.
Local launchd collection distinguishes explicit disabled overrides from an
unloaded or inaccessible service; an inaccessible override database does not imply
that a task is disabled.

Collectors accept `--host-prefix` for project-qualified display names. Snapshots
may carry `hostLabel`; raw `host` remains the scheduler identity. Display labels
appear in cards and host filters and are searchable without rewriting run keys.

The overview’s “Разобрать проблемы” button opens a parent-bound draft for problem diagnosis and cleanup, without starting an agent. It respects search/source/host/project/scope filters across all status sections and pages. The draft includes at most 40 metadata records and asks the agent to re-read the current inventory before changes; an intentional pause alone is not a cleanup reason. Model and project remain editable before submission.
