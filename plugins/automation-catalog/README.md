# Automation Catalog

An independent BB inventory and management-entry plugin. No BB fork or patched desktop application is required.

## Use the panel

The table puts blocked tasks and failed executions first. Needs attention includes missing tasks, connection problems, stale data and tasks without live monitoring. Paused schedules have their own view; a previous failure remains visible even when paused. An enabled schedule is not proof of a successful execution.

Create automation selects personal/team ownership and BB/local/server execution, then opens BB's native composer inside the panel with the corresponding setup request and a separate draft for each destination/ownership. Nothing is executed until the user sends that request. Diagnose and Edit use the same explicit handoff to the original scheduler. Optional local/server integrations require their creation skills or clients to be installed; the agent checks availability.

Schedules are human-readable with timezone context. Next execution is shown only when supplied by the scheduler. An overdue indication requires a fresh source and a missed supplied next-run time beyond the source freshness window; it is not inferred from incomplete history. Execution history is compact; source observations are distinguished from execution timestamps. Technical data is expandable.

## Development

```sh
npm ci
npm run typecheck
npm test -- src/catalog.test.ts lib/filters.test.ts
bb plugin build .
```

Local installation, when ready: `bb plugin install .`. The panel is at `/plugins/automation-catalog/catalog`.
Release installation:

```sh
bb plugin install git:https://github.com/OXI-717/bb-plugins.git@^0.1.0 --subdirectory plugins/automation-catalog --tag-prefix automation-catalog/
```

Update with `bb plugin update automation-catalog`.

## Connect BB schedules

Run from the package directory, with BB's CLI available:

```sh
python3 scripts/catalog_collect.py bb --source-id bb-local --name 'BB schedules' --host workstation --bb-server http://127.0.0.1:38886 --publish
```

The source URL is read-only. The selected `BB_SERVER_URL` determines the destination instance. Publishing targets the separate `automation-catalog` plugin, never the built-in scheduler. Connect each server with its own source ID.

## Connect selected local jobs

Create a selection JSON file outside this repository, mapping explicit task IDs to display names:

```json
{"gui/501:org.example.daily-report": "Daily report"}
```

Then run `python3 scripts/catalog_collect.py local --source-id workstation --name 'Workstation' --selection /path/to/selection.json --publish`.
The collector does not alter crontab, start jobs or instrument them. Historical results are limited to evidence provided by the source; a launchd observation is not an exact execution timestamp.

## Periodic collection

Run `python3 scripts/catalog_sync.py --config /path/to/config.json` from your existing script scheduler. No model is called. A sample config (store outside Git):

```json
{
  "enabled": true,
  "serverUrl": "http://127.0.0.1:38886",
  "sources": [{
    "id": "bb-local", "name": "BB schedules", "kind": "bb", "intervalSeconds": 300,
    "options": ["--host", "workstation", "--bb-server", "http://127.0.0.1:38886"]
  }]
}
```

Use `python3 scripts/catalog_collect.py --help` for registry and aim-auto options. Those integrations are optional; there are no built-in server addresses or accounts.

## Custom sources

Publish via `bb plugin rpc call automation-catalog catalog_publish --input-file snapshot.json --json`.
The authoritative schemas are in `src/catalog-types.ts`. Each snapshot contains `source`, millisecond `observedAt`, nullable `error`, `tasks` and `runs`. Inventory is complete per source; run history is incremental and deduplicated. Maximums are 2,000 tasks, 5,000 runs and 4 MB per snapshot. Failed snapshots have empty task/run arrays and preserve previous data. Older snapshots are rejected. Use stable IDs and null for unknown timestamps.

Storage belongs to the plugin. Existing built-in automation definitions are never written. Sources are collected only when explicitly configured; viewing the panel never polls external hosts. Filter choices stay in the current browser tab.

## Privacy and license

The repository contains only code and synthetic fixtures. Hostnames, selection files, snapshots and execution output can be private: keep them in local configuration and BB storage. Run output is excluded by default where supported. BB access controls govern who can see the catalog. `--include-private-metadata` explicitly includes private registry entries; the collector does not verify destination access. Use it only when every reader of the destination BB instance is authorized. BB collection includes the connected instance’s inventory and run status/skip reasons; it does not copy agent prompts or full execution output.

MIT; derived catalog code and vendored UI retain BB's upstream attribution in the repository license and notices.
