# Explicit registry and observed inventory

The existing `catalog_sync.py` cycle may specify `auditConfig`, an absolute local
configuration file path. This adds one model-free comparison to that cycle; it
does not create another scheduler. Never alter recovery, cleanup or intentional
holds merely to standardize display names.

Identity is the tuple host + scheduler + scope + unit/native ID. Technical IDs
remain unchanged. Human display names should follow `OXI · purpose · machine`.
Registry records require name, owner, project, purpose, source, limits, stop and
rollback. Schedule, observed state and execution history come from the source;
absence is unknown, not success. Long-running services have no invented schedule.

Configuration contains `host`, `hosts` (expected host IDs), `sourceId`, `name`,
`owner`, `staleAfterMs`, `registry`, `sources` (expected catalog source IDs), and
optional `inventoryFiles` mapping remote host IDs to protected local metadata
snapshots produced by `catalog_inventory.py`. Each snapshot needs `observedAt`.
A missing file, permission error or expired snapshot produces coverage findings.
Do not pretend one host's output belongs to another.

Each registry object has host, scheduler, scope, unit and the required metadata
above. `exclusions` must specify host, scheduler, scope, nonempty reason and exact
`units` or explicit `prefixes`. Use package/vendor-owned policy only for verified
OS entries; never exclude an entire scheduler or arbitrary application jobs.
Review the exclusion counts with the inventory. Configuration and real host
inventories belong outside the public source repository.

The comparison publishes blocked cards through existing `catalog_publish`.
Stable finding IDs allow the owner to revisit the same card. No raw commands,
environment, journal messages or credentials are published. The initial event
and bounded reminders appear in ordinary catalog history. `reminderMs` defaults
to one day, `maxEventsPerCycle` defaults to 20. Unchanged findings retain the card
without producing a new event on every poll. Dedup state advances only after
publication acknowledgement. Unknown coverage never resolves old findings.
Recovery is a new observation, not evidence that the underlying job executed.

Stopping unknown jobs is never automatic. The registry's `stop` and `rollback`
identify the original scheduler operation; use the existing catalog action draft
to inspect that source before changing it. Native BB stop remains the supported
native action. Audit results belong in the existing durable per-task journal.

Remote collection may instead use `remoteHosts` (at most two connected BB hosts)
through the official read-only terminal transport. `coverageRequirements` maps
host IDs to required scheduler/scope pairs. Missing required pairs, malformed or
empty coverage do not establish recovery. `hostAliases` maps legacy display host
names for comparison only, without rewriting persisted catalog identities.

The collector's optional `--metadata-registry` applies that same explicit registry
to display names, ownership and the purpose/source/limits/stop/rollback text. It
never modifies technical IDs, state, schedules or native job definitions. Entries
without the necessary metadata remain visible compliance findings.

Selected systemd sources also accept standalone `.service` identities. An active
long-running service has no invented schedule or next run. A selected timer and
its companion service form one card; selecting both separately is rejected.
