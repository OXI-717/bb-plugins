---
name: auto-archive
description: Preview quiet BB thread trees or prune old handoff ancestors while preserving a live thread.
---

Start with `bb auto-archive status` and `bb auto-archive run --dry-run`.
Default settings are 14 days, `dryRun=true`, `detachActiveDescendants=false`,
and `keepThreadIds='[]'` (JSON string array).

Use `bb auto-archive prune <live-thread-id> --dry-run` to keep that live thread
and preview detaching it and pruning quiet ancestors and side branches.
This explicit command can include pre-install backlog; the hourly sweep cannot.

Pinned, 📌-prefixed, permanent thread metadata, kept and dirty-workspace threads protect their ancestors.
`status` counts pinned / pinPrefix / permanent / keepThreadIds independently; overlaps count in each reason.
Active children preserve the tree unless parent-only detachment is enabled.
Lifecycle owner and hidden-source links cannot be cleared through the public
API: a blocking dependency must be reported, never bypassed with database edits.

A preview never changes thread links or archives. Real operations require
`dryRun=false` and can partially complete on API failure. BB has no atomic
conditional archive, so revalidation narrows but cannot eliminate races.
Do not enable real archiving without the user's authorization.


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
