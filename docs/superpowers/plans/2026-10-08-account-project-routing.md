# Account Project Routing Implementation Plan

Goal: account project scopes and roles; drainOnce overrides routing policies.
Architecture: persisted project rules and project-bound host tokens. TypeScript/Zod/Vitest.
Execute inline, without replacing the installed pool.

- [x] Synthetic failing tests: tier order, inheritance, allowlist, drain override.
- [x] Schema, store, operations, RPC and CLI for project rules.
- [x] Opaque project-bound tokens: host identity, rotation/grace/pruning, Cursor exchange.
- [x] Hub filtering, tiers, affinity, project-local cursors and drain schedule bypass.
- [x] SDK project catalog and account routing form, autosave and unknown ID retention.
- [x] Focused policy/token/hub/UI tests, typecheck, build, local publication gate.
- [ ] Commit and PR; full suite in CI. Live update separately after safe idle checks.
