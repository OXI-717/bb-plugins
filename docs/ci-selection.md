# Required checks and extended compatibility

CI selects changed plugins and always keeps publication hygiene and secret scanning.
Every selected plugin runs its complete `npm test`, typecheck and build. Pooler
also runs the Linux upgrade/restore rehearsal. Authentication, account/project
scope, routing, quota/failover, VPN/proxy, browser isolation and data recovery tests
are never classified out. New root/UI/source tests are discovered automatically
and remain required; there is no test-name exclusion list.

For Pooler, UI/CSS and the small explicit portable-module list need Linux. Browser,
host, native, launcher, dependency and unknown backend changes also require macOS.
Other changed plugins retain their existing platforms. Shared code, workflow edits
and unknown repository paths conservatively select the complete matrix. Renames
include both old and new paths. Tags compare with the previous reachable version
of the same plugin; an absent baseline falls back to the full matrix.

The stable `release-gate` requires success from every selected check. A selected
check that is skipped, cancelled or failed is a failure. Hygiene and secret checks
must always succeed. This source change does not alter GitHub protection rules;
old required matrix contexts may still block merging until separately authorized
configuration adopts the stable gate. No bypass is implied.

The unchanged full cross-platform suite lives in `Extended compatibility`, on the release
branch, weekly and on manual request. Main already runs the full required CI,
so it does not also trigger the extended workflow. It is outside the PR release
DAG, keeping broad compatibility visible without repeating it on every PR fix.
Known safety failures still require investigation; background does not mean ignored.

| Example diff | Previous jobs | Selected jobs | Selected Mac jobs |
|---|---:|---:|---:|
| Pooler app.tsx / balancer.ts | 21 | 6 | 0 |
| Pooler browser-host.ts / unknown safety test | 21 | 8 | 2 |
| shared VPN evidence / workflow change | 21 | 23 | 9 |

Counts include the two new planning/aggregation jobs. No test count reduction is
claimed. Hosted elapsed time depends on runner availability; only job plans are
measured locally. Validate with `python3 -m unittest discover -s scripts -p test_ci_plan.py -v`.
