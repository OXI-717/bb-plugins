# Projects visual release check

Run this as a separate acceptance step for a Projects UI change, after typecheck,
focused tests and build. Unit tests cannot verify host chrome, real routing,
CSS, drawers or empty homepage headings. A release is not visually verified
until the changed surfaces have been inspected in the running BB app.

Use an isolated headless Browser Automation session on an explicitly selected
host. Do not use personal browser tabs. Record the plugin version/source,
BB version, viewport, scenario, expected/observed result and screenshot path
in a private acceptance report. Production screenshots and account inventories
must never be committed here or attached to public PRs.

| Surface | Modes and checks |
| --- | --- |
| New thread | No project and selected project; no Projects heading or shortcut block below the composer; project action remains available in the panel launcher. |
| Project page | Project picker and settings are usable; switch projects without stale details; list and Kanban with a long task list. |
| Task detail | Select first and later items, switch and close; details stay visible beside/inside the selected item, including loading and errors. |
| Current thread | Open a task in the side panel; original thread remains selected, composer draft remains intact; preparing a thread starts no work. |
| Size and theme | Wide (at least 1280 px) and narrow (390 px); light and dark; drawers, scroll regions, controls and error text remain visible without clipping. |
| Data states | Loading, loaded, successful empty result, disconnected tracker and failed request are distinct; retry recovers without stale details. |
| Optional integrations | Fresh defaults off; explicitly enabled integrations; unavailable integration; disabling preserves saved settings and hides its controls. |

Do not mutate real tasks, credentials, project bindings, integration flags or
shared preferences merely to stage a screenshot. Use synthetic fixtures or an
isolated test installation for failure/empty/optional-integration variants.
Mark a scenario `PASS`, `FAIL` or `NOT RUN` with a reason; a mocked component
test is supporting evidence, not a live visual pass. Any failure blocks the
affected surface; explicitly record coverage gaps for unrelated modes.

Close the browser session after saving the evidence. Restore any test-only
display preferences. Recheck the installed release's changed surface after
delivery: testing a worktree alone does not prove what the user is running.
