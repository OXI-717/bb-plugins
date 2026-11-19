# Plugin CI coverage

Each selected plugin job runs its package's full typecheck, test command and
build with the published BB CLI. Linux means `ubuntu-latest`. Mac means
`macos-latest`. The table describes actual runner coverage.

| Plugin | Job | Platforms | Change triggers and additional coverage |
|---|---|---|---|
| `account-pool-balanced` | `check` | Linux, plus Mac for platform-sensitive changes | Pool files select the package suite. `upgrade-script` rehearses upgrade and restore and tests the Claude host diagnostics. `cursor-gateway` checks the Python launcher on Linux and Mac. See selection rules below. |
| `automation-catalog` | `check` | Linux and Mac | Catalog files select the package suite and Python collector tests. |
| `vpn-guard` | `check` | Linux and Mac | Guard files select the package suite. Shared VPN evidence selects the full matrix. |
| `oxi-projects` | `check` | Linux and Mac | Projects files select package tests and additional Vitest UI and integration tests. Visual acceptance is separate. |
| `model-connections` | `check` | Linux and Mac | Model Connections files select the package suite. |
| `federation-pilot` | `check` | Linux and Mac | Federation files select the policy and Node integration tests in the package suite. |
| `pool-maintenance` | `check` | Linux and Mac | Pool Maintenance files select the package suite. |
| `auto-archive` | `auto-archive` | Linux | Auto Archive files select the package suite. No hosted Mac job. |
| `oxi-op` | `oxi-op` | Linux and Mac | OP files and the six Pool modules loaded by its native-task fixture select the package suite. |
| `oxi-thread-list` | `session-tree` | Linux | Runs on every CI event. No hosted Mac job or Session Tree job in Extended compatibility. |

`plan`, `public-hygiene`, `secrets`, `session-tree` and `release-gate` always
run in CI. Linux and Mac `check` contexts for Pool and Catalog always exist
for branch protection. Their steps run only when selected. Publication hygiene
checks tracked files, manifest identity and release contracts, and doc links.
Secrets scans all fetched history. Each active `check` row also checks the
publication manifests and VPN contract. The separate `Plugin tracking migration`
workflow runs Linux tests on PRs touching its script, tests or workflow, and on
manual request.

## Event rules

| Event | Range and scope |
|---|---|
| Pull request | Compare the tested head with its merge base. Select affected plugin and auxiliary jobs. |
| Push to `main` | Run the established full plugin and upgrade matrix. Select Cursor from the push's before-to-head range. |
| Plugin release tag | Compare against the highest lower reachable version of the same plugin. Select affected jobs and apply the metadata rules below. |
| Manual `CI` | Run all jobs, including Cursor on both platforms and Session Tree on Linux. |
| `Extended compatibility` | Run the cross-platform matrix, upgrade rehearsal, Cursor, Auto Archive, OP, hygiene and secrets on manual request and pushes to `release/account-pool-0.4.x`. The main push does not also trigger this workflow. |

Renames count as deletion and creation. Workflow, planner, shared and unknown
repository paths select full coverage. Markdown outside `.github/` generally
needs only the always-run jobs on PRs. Missing main or tag baselines retain the
full plan. Invalid PR ranges fail planning and therefore the release gate.

For Pool, UI/CSS and an explicit list of portable modules use Linux when CI
selects by path. Browser, host, native, launcher, dependency and other backend
changes keep Mac. Pool changes generally also select the upgrade rehearsal on
the corresponding platforms. The Cursor wrapper remains covered by the Pool
package check and selects the separate gateway job without the rehearsal.

## Cursor and release metadata

`cursor-gateway` imports `plugins/account-pool-balanced/scripts/cursor-route.py`
from `scripts/test_cursor_route.py`. The suite uses Python's standard library,
a synthetic `cursor-agent` and a localhost HTTP server. It needs no Cursor
account, BB process or live provider. Its selection covers the harness, Python
files in Pool's scripts directory (including future local helpers), Cursor-named
Pool source files, and the Pool server and standalone entry points implementing
the HTTP contract. The TypeScript Cursor RPC tests still run in the Pool
package suite. The standalone AGY Python helper tests have no hosted job.
Changes limited to known upgrade tooling leave Cursor out.

Cursor can skip a release range containing unrelated plugin changes and
coherent version bumps. A real Cursor input, relevant CI file, shared or
unknown path in that range selects Cursor. A coherent bump changes only the
package version, lockfile and lock root version, and the matching marketplace
range for each affected plugin. Other fields, schemas and the inventory must
match structurally. Duplicate keys, missing records, dependency changes and
unknown layouts retain full coverage. This Cursor rule does not alter the
existing metadata fallback for other jobs, which recognizes only the strict
single-Pool version vector.

The stable `release-gate` requires every selected job to succeed, including
both Cursor runners when selected. Skipped, cancelled, failed or missing
selected jobs fail the gate. Hygiene and secret checks must always succeed.
See [CI workflow](../.github/workflows/ci.yml) and
[Extended compatibility](../.github/workflows/ci-extended.yml).

Run `python3 -m unittest discover -s scripts -p 'test_ci_*.py' -v` to check
routing with synthetic Git histories and validate the inventory in this table.
