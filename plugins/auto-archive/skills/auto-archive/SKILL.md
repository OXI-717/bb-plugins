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

Pinned, 📌-prefixed, uppercase titles (at least two Latin/Cyrillic letters,
explicit title only), kept and dirty-workspace threads protect their ancestors.
`status` counts pinned / pinPrefix / uppercase / keepThreadIds independently; overlaps count in each reason.
Active children preserve the tree unless parent-only detachment is enabled.
Lifecycle owner and hidden-source links cannot be cleared through the public
API: a blocking dependency must be reported, never bypassed with database edits.

A preview never changes thread links or archives. Real operations require
`dryRun=false` and can partially complete on API failure. BB has no atomic
conditional archive, so revalidation narrows but cannot eliminate races.
Do not enable real archiving without the user's authorization.
