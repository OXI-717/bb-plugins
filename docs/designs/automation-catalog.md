# Automation Catalog

## Scope

Ship an independent BB plugin in this public multi-plugin repository. Keep the Account Pool Balanced package and runtime unchanged. The catalog displays personal and team jobs across schedulers without executing them. No model calls and no changes to the BB desktop application are required.

## Contracts

Use the published Plugin SDK, plugin-owned SQLite storage, validated RPC contracts, a namespaced CLI, a skill, and a navigation panel. Preserve the previous catalog's stable external identities, incremental run history, complete inventory snapshots, failure retention and source freshness. Declared state is separate from live state. Persist filters per browser tab.

Optional Python collectors publish BB schedules, explicitly selected local jobs, a configured registry or an external scheduler CLI. They contain no personal deployment defaults. The public package starts empty. Existing private source configurations and databases are not copied into Git or modified by building this package.

## Distribution

Package: plugins/automation-catalog. Plugin ID: automation-catalog. Independent immutable release tags: automation-catalog/vX.Y.Z. Keep collection and marketplace entries consistent. Preserve upstream MIT attribution. Use synthetic test fixtures. First publication requires the repository's local publication gate and review; local development does not publish or install.

## Verification

Typecheck, focused storage/lifecycle/filter tests, Python collector tests, official plugin build and manifest checks. CI runs both plugins on Linux and macOS. A live UI check and private-source migration remain deployment steps and must not be represented as completed by a build.
