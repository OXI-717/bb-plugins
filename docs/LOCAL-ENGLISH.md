# English integration branch

This branch began as an English-only translation of upstream
`account-pool-balanced/v0.4.32` (`34267f033958d30e6e3658a990b48475cdfe3061`).
That is historical provenance, not a statement about the current source or any
installed instance.

## Current scope

The branch reconciles upstream `main` at
`5701ddc5f6e59aad99bd4f01595b830dea52ea8e`, whose plugin package declares
0.4.103, with the additional provider, quota and sign-in changes in this branch.
The latest published release checked during this qualification was 0.4.99.
A development package version is not a published release.

The delta now includes behavior as well as English text: Gemini authorization
and declared usage, additional provider adapters, quota recovery and compatibility
with upstream account-management contracts. The plugin ID remains
`account-pool-balanced`. Source integration alone does not prove preservation of
live accounts, routing, settings or authentication.

## Maintenance and validation

Merge upstream into the feature branch, resolve both behavior and textual
conflicts, then run focused tests, typecheck and the official plugin build.
Review the complete public diff and commit metadata before a normal fast-forward
push to the existing pull request. Do not rewrite published history, patch the
plugin cache, modify generated bundles or inject DOM content.

The manifest declares BB `>=0.46.1` and SDK `>=0.6.49 <0.7.0`; its development
SDK pin is 0.6.104. A host build may report a newer SDK. Neither a pin check nor
an earlier compatibility result proves every current runtime or visual scenario.
The BB 0.48.0 / SDK 0.6.94 and BB 0.48.1 / SDK 0.6.104 qualifications remain
historical evidence, not new executions for this branch.

Upstream's maintained English support or a supported plugin locale API would
supersede the translation portion of this delta. Provider and correctness changes
still need their own review and cannot be discarded as translation conflicts.

## Activation and rollback

Building or publishing this branch does not activate it. Published releases use
the standard updater required by the repository rules. Any separately authorized
source replacement must use supported native lifecycle commands, a fresh idle
window, a coherent verified state backup and a written source rollback command.

A stable plugin ID does not prove a safe transition. The effects of removal,
source moves and initialization depend on the installed BB version and must be
checked for the actual operation. A backup must cover the relevant plugin
SQLite database, protected files and persisted namespace; a live SQLite database
uses the backup API. Never assume that reinstalling an old tag restores data or
that a file integrity check proves working authentication. No live rollback or
new installation is claimed by this document.

Historical version references:

- https://github.com/get-bb/bb/blob/desktop-v0.48.0/packages/plugin-sdk/package.json
- https://github.com/get-bb/bb/blob/desktop-v0.48.1/packages/plugin-sdk/package.json
