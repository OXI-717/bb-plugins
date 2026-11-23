# OXI Auto Archive

A tree-aware fork of [bb-plugin-auto-archive](https://github.com/slogsdon/bb-plugin-auto-archive)
0.1.0 by **Shane Logsdon**, released under MIT. The upstream copyright and
license are preserved in [LICENSE](LICENSE). OXI-717 maintains this fork.

Install on BB 0.46.1+ with Plugin SDK 0.6.49+:

```sh
bb plugin install git:https://github.com/OXI-717/bb-plugins.git@semver:auto-archive/:^0.2.1 --subdirectory plugins/auto-archive
bb plugin config auto-archive set dryRun true
bb auto-archive run --dry-run
```

The plugin **starts in dry-run mode**. It previews once on load, then hourly.
Real archiving requires explicitly setting `dryRun` to `false`.
`--dry-run` always forces a preview; a CLI invocation cannot override the safe
setting with a false flag. Preview changes no thread or relationship.

## Policy

The default threshold is **14 days**, inclusive. A root is a thread with no
parent, lifecycle owner or hidden-source owner. Activity is the maximum of
`latestAttentionAt` and actual turn start, input acceptance and completion
events across its entire descendant graph. Child turn activity is checked
explicitly because child `latestAttentionAt` can lag. Reading, renaming and
section changes do not count as activity.

Graph edges include `parentThreadId`, `lifecycleOwnerThreadId`, and hidden
forks' `sourceThreadId` (BB archives those with their source). Visible source
references alone do not establish archive ownership. Archived intermediary
nodes are included when following edges to live descendants. Cycles without
a root and dangling ownership references are not automatic candidates.

Pinned threads, names starting with `📌`, and `keepThreadIds` always protect
the thread and its ancestors. Hidden threads also protect their ancestors.
Running, pending, queued work, user interactions and background activity
protect the branch. There is no override to archive pinned or running work.
Unknown activity or workspace status prevents archiving.

The background sweep leaves the pre-install backlog untouched. Each remaining
tree's most recent activity must be at or after the saved installation time.
The timestamp persists across reloads and upgrades. Preview reports
`backlogRoots`: currently quiet roots older than the threshold whose entire
live tree was already inactive before installation, including protected roots.

Permanent metadata protects a thread and its ancestors (📌 protection uses the explicit-or-fallback title); `status` counts live pinned / 📌 prefix / permanent / keepThreadIds reasons independently (counts may overlap).

## Settings

```sh
bb plugin config auto-archive set inactivityDays 14
bb plugin config auto-archive set keepThreadIds '["thr_example"]'
bb plugin config auto-archive set detachActiveDescendants false
bb plugin config auto-archive set dryRun true
bb plugin config auto-archive set unarchiveGraceMultiplier 2
bb plugin config auto-archive set enableArchivedFileCleanup false
bb plugin config auto-archive set clearArchivedFilesAfterDays 14
bb plugin config auto-archive set enableAutomatedExportDelete false
bb plugin config auto-archive set exportDeleteAfterDays 30
bb plugin config auto-archive set exportDir /path/to/bb-exports
bb plugin config auto-archive set retentionMaxPerRun 50
bb auto-archive status
```

`keepThreadIds` is a JSON array in a string setting. Invalid settings fail
closed. `inactivityDays`, `clearArchivedFilesAfterDays`, and
`exportDeleteAfterDays` accept finite numbers from 1 through 36500.
`unarchiveGraceMultiplier` accepts 1 through 10 (default `2`).

## Unarchive grace extension

When a thread is returned from archive (`thread.unarchived`), the plugin
increments `unarchiveCount` and records `lastUnarchivedAt` in its thread
metadata (preserving `permanent`). Each unarchive multiplies the thread's
effective inactivity, file-cleanup, and export+delete thresholds by
`unarchiveGraceMultiplier` (capped at 5 extensions / 36500 days), and resets
the inactivity clock from `lastUnarchivedAt` so a freshly unarchived thread is
never re-archived immediately.

## Archived retention & verified export

Both destructive retention actions default to **off** (`false`) so upgrading an
existing installation with `dryRun=false` never deletes files or threads without
explicit opt-in. Always preview first:

```sh
bb auto-archive retention --dry-run --limit 200
```

1. **Archived thread-storage cleanup (`enableArchivedFileCleanup`):** For
   archived, stopped, unprotected threads older than
   `clearArchivedFilesAfterDays`, removes only their local
   `thread-storage/<threadId>` directory on the server host. Conversation
   history in `bb.db` stays intact. Permanent threads (**Постоянный тред**),
   pinned threads, `📌`-prefixed threads, `keepThreadIds`, symlinks, and
   remote-host directories are skipped.
2. **Verified automated export + delete (`enableAutomatedExportDelete`):**
   Only archived, stopped, unprotected **automated or child** threads older
   than `exportDeleteAfterDays` qualify:
   - `originPluginId` in `automatedOriginPluginIds` (default: `workflows`,
     `automations`, `automation-catalog`, `oxi-autopilot`, `aim-growth`),
   - `visibility === "hidden"`, or
   - child threads (`parentThreadId !== null`) whose parent is archived or
     missing.
   - Manually created visible root threads (and user-facing roots like
     `handoff` or `oxi-projects`) are **never** deleted.
   - Threads with any live, protected, manual, or younger descendant are
     blocked; eligible trees are processed strictly bottom-up (leaves first)
     with `childThreadsConfirmed: false`.
   - Before deleting a thread, the plugin exports its metadata and complete
     event history to `<exportDir>/YYYY-MM/<threadId>.jsonl.gz` (written
     atomically via `.tmp` + `fsync` + `rename`, mode `0600`), reads the
     compressed file back to verify gzip integrity, event count, and SHA-256,
     writes `<threadId>.jsonl.gz.sha256`, and revalidates the thread state.
     Any export or verification failure aborts deletion.

## Offloading exports to an external drive

Use [scripts/pull-exports.py](scripts/pull-exports.py) on a workstation with an
external archive volume attached (for example via `launchd` on macOS):

```sh
python3 plugins/auto-archive/scripts/pull-exports.py \
  --source user@bb-server.example:/var/lib/bb-exports \
  --dest-dir /Volumes/ArchiveDisk/bb-thread-exports \
  --require-mount-root /Volumes/ArchiveDisk \
  --require-sentinel .bb-archive-volume \
  --delete-remote
```

The script refuses to run if the external volume is not mounted or the sentinel
file is missing, syncs completed `.jsonl.gz` + `.sha256` pairs via `rsync`
(ignoring `*.tmp*`), verifies SHA-256 + gzip + event count locally on the
external drive, and removes ONLY verified files from the server outbox. A source
archive is removed only while it still hashes to the verified digest; a bundle
re-exported after the copy stays for the next run (`keptChangedSourceArchives`).
Pass `--dry-run` to preview without deleting source files, or `--verify-all` to
scrub the entire destination archive.

By default a fresh descendant keeps its old root alive. With
`detachActiveDescendants=true`, the plugin clears the parent of each active
branch before archiving a quiet root. All descendants of the retained branch
stay with it, even if another root also owns one of those descendants.
Retention is computed across the entire graph for planning and revalidation. Protected exceptions and dirty workspaces still block the root.

**Lifecycle ownership is immutable in BB's public API.** Neither
`threads.update` nor `bb thread update` can clear it. A branch still connected
through lifecycle ownership (or hidden source ownership) blocks the archive.
The plugin reports that limitation instead of changing BB's database.

## Manual pruning

```sh
bb auto-archive prune thr_example --dry-run
```

The given live thread and its descendants remain. The preview lists target
and branch parent links to clear, ancestor archive entry points, every live
thread those archives would affect, and blocking reasons. Only quiet
ancestors and quiet side branches qualify; the same 14-day threshold applies.
Explicit prune may include pre-install backlog. Young ancestors, protected
threads and active side branches stay. Quiet side branches can be archived
independently beneath a retained young ancestor. An active side branch may have its
parent cleared to preserve it. A pinned/kept/dirty target cannot be detached.
If the target itself has a lifecycle owner, the operation reports that it
cannot fully detach and changes nothing. Immutable dependencies elsewhere
block the affected ancestor; independent safe ancestors may still qualify.

Without `--dry-run`, prune still previews while the global `dryRun` setting
is true. Enable real actions only after reviewing the preview.

## Workspaces, races and partial operations

The plugin uses `sdk.environments.status` on the environment's owning host.
Any `workingTree.hasUncommittedChanges` (including untracked files) protects
that thread and its ancestors. This also protects ordinary Git checkouts.
Non-Git environments explicitly reported as non-worktrees need no Git guard.
Offline, missing or unknown workspace status protects the tree. No local
filesystem or worktree deletion is performed.

Operations are serialized within the plugin. Before writes, before each
archive entry point and after branch detachment, the plugin rechecks activity,
relationships, exceptions and workspace state. A change in an affected tree aborts further work. Unrelated trees may continue working.
**BB has no atomic conditional archive API:** a thread can still change between
the last check and archive. Detach and archive are separate API calls; failure
can leave links already detached or earlier roots already archived. Nothing
tries to silently restore links over concurrent edits. Review and rerun the
preview after an error. Disabling/reloading aborts work between API calls.

CLI results are JSON and previews are bounded; summary counts describe the
full plan, while detailed lists may be truncated. `bb plugin logs auto-archive`
shows background sweep summaries.

## Development

```sh
npm ci
npm run typecheck
npm test -- policy.test.ts runtime.test.ts server.test.ts
bb plugin build .
```

No account, service credential or live archive is needed for tests.


## Permanent threads

The thread header contains a **Постоянный тред** checkbox. Its boolean value is
stored in this plugin's thread metadata. Permanent threads protect their ancestors
from both the hourly sweep and manual prune. Pinning and 📌 title prefixes remain
independent protection; explicit `keepThreadIds` remains supported too.

On the first start of 0.2.2, live threads protected by uppercase explicit titles,
📌 prefixes or `keepThreadIds` receive permanent metadata before the sweeper starts.
A failed migration prevents startup and can be retried without losing prior writes.
After completion, uppercase titles no longer protect new threads. Unchecking a
migrated flag survives restart; independent pin/keep protections still apply.
