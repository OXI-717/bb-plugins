## What you get

See personal and team automations from different hosts in one BB panel. Filter by source, host, scope, project or state, and inspect execution history without moving jobs between schedulers.

The catalog separates live state, declared state and source freshness. Failed collection retains the last successful snapshot. Missing outcomes and timestamps remain explicitly unavailable.

## How it works

Sources publish validated JSON snapshots into plugin-owned storage. Optional Python collectors support BB schedules, selected macOS launchd and cron jobs, JSON registries and the external aim-auto CLI. Collection and display never invoke a model.

Inspect entries with `bb automation-catalog list` and history with `bb automation-catalog detail`. The panel starts empty until you connect a source. No jobs are started or rescheduled.

## Requirements

BB 0.43.3 with Plugin SDK 0.4.104 or compatible later versions within the declared ranges. Git installs require Node/npm. Optional collectors require Python 3; launchd collection requires macOS, and aim-auto collection requires that separately installed CLI. Configure collection frequency in your own scheduler. No hosted service or paid account is required by the catalog itself.
