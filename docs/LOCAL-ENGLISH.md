# Local English build

- **Source and version:** upstream `OXI-717/bb-plugins`, immutable tag `account-pool-balanced/v0.4.32`, commit `34267f033958d30e6e3658a990b48475cdfe3061`; installed BB plugin `account-pool-balanced` 0.4.32, BB `>=0.46.1`, plugin SDK `>=0.4.87 <0.5.0`.
- **Change:** translate the account pool plugin's manifest, UI, accessible labels, user-facing errors, documentation, and bundled skill into English. Keep plugin ID and behavior unchanged.
- **Maintenance:** keep translation changes as a small commit on a local branch against the immutable upstream base. For an upstream release, fetch the upstream tag, rebase/port this translation commit, resolve only textual conflicts, rebuild, and review the diff before switching the installed source. Do not patch generated bundles or inject DOM tags.
- **Alternatives:** edit the plugin cache (temporary and overwritten on update); inject translated text into the rendered UI (fragile and unsupported); contribute English/i18n upstream (best long term, but requires maintainer acceptance and an authorized public push).
- **What would refute this:** BB exposes a supported locale API for plugins, or upstream adds maintained English translations. In either case, drop the local text patch in favor of that native source.
- **Rollback limitation:** a stable plugin ID alone does not prove state-preserving source replacement. The BB 0.48.0 path-source move supports path-to-path moves; replacing a Git-pinned source with a path is not covered by that mechanism. Removing the plugin deletes persisted state, including settings and secrets. Reinstalling the upstream tag is therefore not a verified rollback procedure. Live replacement requires a supported source transition and a coherent, verified backup/restoration of global KV, plugin SQLite and secrets before activation.


## BB 0.48.1 compatibility qualification

The native `bb plugin types` command synchronizes the existing SDK and host-shim
dependency pins for BB 0.48.1 (SDK 0.6.104). The historical engine range above describes the upstream source. This local
compatibility candidate restricts its engines to BB 0.48.1 / SDK 0.6.104, the
actual target of focused tests, typecheck and bundle validation. The earlier BB 0.48.0 / SDK 0.6.94 candidate remains in Git history; its
199-test result is prior evidence, not a new execution for this target.

Initial npm queries returned E404, but explicit public-registry queries with
fresh process-local cache confirmed the target SDK is published. A passing pin
check alone does not establish API or bundle compatibility.
Live activation still requires independent source review and the state/source
restoration gates; previous SDK test/build results do not validate this candidate.

Primary version references:
- https://github.com/get-bb/bb/blob/desktop-v0.48.0/packages/plugin-sdk/package.json
- https://github.com/get-bb/bb/blob/desktop-v0.48.1/packages/plugin-sdk/package.json
