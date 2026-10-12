# Automation discovery

The catalog accepts an automation name, prompt phrase, or target thread URL/ID in
its existing search field. Starting a search selects all lifecycle states; other
explicit filters remain visible and can be cleared with one action.

Metadata search works for all sources. Connected local BB definitions are queried
on demand without invoking a model. Agent prompts and literal `bb thread tell`
relays are supported. Arbitrary scripts are not evaluated or interpreted as jobs.
Only .md/.txt relay message files within the resolved script working directory,
including symlink resolution, are readable; files are limited to 64 KiB. Missing
files and unsupported scripts are reported as incomplete text-search coverage.

Prompt contents remain outside the persisted shared inventory. A plugin-local
30-second cache coalesces searches; search responses contain only matching keys
and bounded excerpts. Details read current settings and show the target thread,
target host, schedule host, full bounded prompt, native BB schedule link, and a
copyable catalog deep link. No schedules or messages are changed by discovery.

Verification covers literal parsing, rejected dynamic commands, file containment,
size bounds, identity checks, incomplete coverage, cache behavior, phrase/thread
matching, paused-task discovery, and detail navigation. Live acceptance uses an
existing automation without running or pausing it.
