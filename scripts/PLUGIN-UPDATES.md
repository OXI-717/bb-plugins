# Plugin updates without loss of state

Install public releases with a compatible Git semver range and a per-plugin tag
prefix (for monorepos), or a tracking npm range. Do not pin a release tag or commit
unless a deliberate freeze is required and documented. All owner-maintained Git plugins use compatible release ranges. Never fall back
to a branch. If the installed commit has no verified release tag, prepare and
validate a release first; do not silently replace the installed code.
Local path plugins follow their source checkout and use `bb plugin reload`.

Use `bb plugin source <id> --json` to inspect tracking and `bb plugin update <id>`
for normal updates. Never remove/reinstall to update: removal deletes settings,
secrets and schedules. Keep immutable release tags.

## Existing pinned Git registrations on BB 0.49

BB 0.49 has no public operation for changing tracking policy. `plugin_tracking.py`
is a one-time administration migration, not a modification to BB core. It changes
only six source-selector columns in existing registrations. It does not update
running code, remove plugins, or touch settings, secrets, schedules or plugin KV.
Use only after confirming the installed database schema matches this version.

Run with `--database <bb-data>/bb.db --backup <private-artifacts>/tracking.json`
first, inspect the plan, then add `--apply`. Run Git remote queries with the
repository's authorized credentials. The backup is exclusive and mode 0600;
concurrent registration changes abort the transaction. No arbitrary source URLs
are accepted: existing repository URLs and subdirectories remain unchanged.

After migration inspect `bb plugin source` and `bb plugin outdated`. Update one
plugin at a time, verify its behavior and compare configuration before/after.
Do not mass-activate updates to a busy account pool. Local paths, builtins and
already-tracking registrations are not rewritten. Missing local checkouts need
separate recovery; never invent a repository based on a display name.

Owner plugin display names start with `OXI ` and use English. Descriptions explain
the actual user benefit in English. Preserve stable plugin IDs, settings and storage.
CI checks manifests/catalog consistency, source privacy, typechecking, focused
behavior and builds on supported platforms. Private repositories stay private
unless publication is explicitly authorized and inspected. Disabled plugins stay
disabled through migration and updates.
