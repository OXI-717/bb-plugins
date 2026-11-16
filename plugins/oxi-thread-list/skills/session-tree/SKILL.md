---
name: session-tree
description: Inspect or adjust OXI Session Tree's optional machine groups inside projects, per-project overrides and saved collapse state.
---

Use `bb oxi-thread-list prefs list --json` to inspect this sidebar provider.
The native `bb thread-list` command controls a different provider; do not change
it when adjusting OXI Session Tree.

- `projectMachineGrouping`: boolean global switch, effective in project mode.
- `projectMachineOverrides`: map of project ID to `machines` or `plain`.
  Remove one entry to restore inheritance; preserve other project entries.
- `collapsedProjectMachines`: internal structured keys; prefer the UI buttons.

Write one preference with `bb oxi-thread-list prefs set <key> '<JSON>' --json`.
Read back the value. Check the selected sidebar provider before diagnosing a
setting that appears ineffective. Grouping never changes thread hosts or parents.
A child on a different host stays under its parent.

The first load imports native settings once through supported RPC and keeps the
native provider unchanged. Read README.md for import failure and fallback details.
