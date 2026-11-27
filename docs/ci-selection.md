# Plugin CI coverage

Each selected plugin job runs its package's full typecheck, test command and
build with the published BB CLI. Linux means `ubuntu-latest`. Mac means
`macos-latest`. The table describes actual runner coverage.

| Plugin | Job | Platforms | Change triggers and additional coverage |
|---|---|---|---|
| `account-pool-balanced` | `check` | Linux, plus Mac for platform-sensitive changes | Pool files select the package suite. `upgrade-script` rehearses upgrade and restore and tests the Claude host diagnostics. `cursor-gateway` checks the Python launcher on Linux and Mac. See selection rules below. |
| `automation-catalog` | `check` | Linux and Mac | Catalog files select the package suite and Python collector tests. |
| `vpn-guard` | `check` | Linux and Mac | Guard files select the package suite. Shared VPN evidence selects the full matrix. |
| `oxi-projects` | `check` | Linux and Mac | Projects files select Node tests in `test/` and the separate Vitest UI and integration suite. Vitest excludes `test/`. Visual acceptance is separate. |
| `model-connections` | `check` | Linux and Mac | Model Connections files select the package suite. |
| `federation-pilot` | `check` | Linux and Mac | Federation files select the policy and Node integration tests in the package suite. |
| `pool-maintenance` | `check` | Linux and Mac | Pool Maintenance files select the package suite. |
| `auto-archive` | `auto-archive` | Linux | Auto Archive files select the package suite. No hosted Mac job. |
| `oxi-op` | `oxi-op` | Linux and Mac | OP files and the six Pool modules loaded by its native-task fixture select the package suite. |
| `oxi-thread-list` | `session-tree` | Linux | Runs for Session Tree changes and full plans. Otherwise its job reports an unchanged plugin. No hosted Mac job or Session Tree job in Extended compatibility. |
| `oxi-provider-icons` | `provider-icons` | Linux | Provider Icons files select the package suite. No hosted Mac job. |

`plan`, `public-hygiene`, `secrets`, `session-tree` and `release-gate` always
run in CI. Linux and Mac `check` contexts for Pool and Catalog always exist
for branch protection. Unselected contexts report success on Linux without
checkout or build steps. A Mac runner is assigned only when the job runs tests.
Publication hygiene
checks tracked files, manifest identity, the VPN contract, release contracts and
doc links once per workflow. Secrets scans all fetched history. The separate `Plugin tracking migration`
workflow runs Linux tests on PRs touching its script, tests or workflow, and on
manual request.

## Event rules

| Event | Range and scope |
|---|---|
| Pull request | Compare the tested head with its merge base. Select affected plugin and auxiliary jobs. |
| Push to `main` | Select affected checks from the push's before-to-head range when it has a verified linear baseline. Missing or divergent baselines run all checks. |
| Plugin release tag | Compare against the highest lower reachable version of the same plugin. Select affected jobs and apply the metadata rules below. |
| Manual `CI` | Run all jobs, including Cursor on both platforms and Session Tree on Linux. |
| `Extended compatibility` | Run the cross-platform matrix, upgrade rehearsal, Cursor, Auto Archive, OP, hygiene and secrets on manual request and pushes to `release/account-pool-0.4.x`. The main push does not also trigger this workflow. |

Renames count as deletion and creation. Workflow, planner, shared and unknown
repository paths select full coverage. Markdown outside `.github/` generally
needs only the always-run jobs on PRs. Missing main or tag baselines retain the
full plan. Invalid PR ranges fail planning and therefore the release gate.

For Pool, UI/CSS and an explicit list of portable modules use Linux when CI
selects by path. The portable HTTP hub and its synthetic server suite use Linux.
Browser, host, native, launcher, dependency and unclassified backend changes
keep Mac. The upgrade rehearsal covers the upgrade scripts, Pool
backend and package changes, the update panel, and Pool releases. UI and CSS
changes elsewhere use the package suite. The rehearsal exercises the updater
against synthetic commands and a synthetic state database. The Cursor wrapper
selects the package and gateway suites.

## Cursor and release metadata

`cursor-gateway` imports `plugins/account-pool-balanced/scripts/cursor-route.py`
from `scripts/test_cursor_route.py`. The suite uses Python's standard library,
a synthetic `cursor-agent` and a localhost HTTP server. It needs no Cursor
account, BB process or live provider. Run it for the wrapper, its harness and
other Python files in Pool’s scripts directory that could be shared helpers.
The known Claude host diagnostics and upgrade tooling have their own checks.
Run the Pool package suite for TypeScript changes, including the Cursor HTTP
contract in both BB and standalone mode. Unknown paths, shared code and changes
to the planner or workflows retain the gateway suite. Manual full checks
retain both platforms. The standalone AGY Python helper tests have no hosted job.

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
Run `python3 scripts/ci_mutations.py` when reviewing changes to selection,
the release gate or gateway behavior. It injects representative regressions
and verifies that their targeted tests fail with assertions.
