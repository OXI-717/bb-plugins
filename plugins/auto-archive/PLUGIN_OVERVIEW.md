## Keep working threads available

Auto Archive checks whole thread trees, including handoff lifecycle ownership,
before selecting quiet roots. The default inactivity window is 14 days.
Pinned threads, titles starting with 📌, permanent thread metadata, configured keep IDs and dirty Git
workspaces protect their ancestors. Active branches preserve the tree unless
parent-only detachment is explicitly enabled.

## Preview first

The plugin starts with `dryRun=true`. Use `bb auto-archive run --dry-run` to
see a sweep, or `bb auto-archive prune <thread-id> --dry-run` to preserve a live
thread and preview removing quiet ancestors. The hourly sweep leaves the
pre-install backlog untouched; explicit pruning can include it.

BB lifecycle ownership cannot be cleared through the public API. Such links
block unsafe archives. Archive and detach calls are separate and can partially
complete; concurrent changes cannot be excluded atomically.

## Requirements and attribution

BB 0.46.1 with Plugin SDK 0.6.49 or newer compatible 0.6 releases. No external
service or account is required. Fork of Shane Logsdon's MIT-licensed
[Auto Archive](https://github.com/slogsdon/bb-plugin-auto-archive).


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
