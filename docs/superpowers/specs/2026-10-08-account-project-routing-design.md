# Account project routing

Status: implemented candidate. Owner confirmed drainOnce overrides project restrictions; owner approved project-primary → project-reserve → general-primary → general-reserve.
No live account configuration or plugin installation changes have been made.

## Scope

Each account has optional projects settings: onlySelected and deduplicated role rules keyed by stable BB project IDs.
Missing or empty rules mean usable in all projects. Renaming a project preserves membership.
With onlySelected enabled, nonempty rules restrict use to those projects; matching rules also give routing preference.
No real project/account inventory or personal deployment details belong in fixtures/docs.

## Proposed settings after usage review

Use one account routing block instead of a parallel project policy engine:
- Default account role: primary/reserve (existing field).
- Scope: all projects (default) or selected projects only.
- Project rows: project ID and role inherit/primary/reserve.
  An override row in all-projects mode changes role/preference, not scope.
  In selected-only mode the same rows define the allowed projects.
- Quota preservation (5h/week), progressive cap and schedule remain account-wide;
  they represent a shared subscription allowance and are not copied per project.
- Existing individual-policy enable switch preserves saved values while disabled.
- Existing global balanced/sequential strategy remains; no extra project weights.

Show effective role, source of inheritance and applicable project list on the card.
Autosave consistently. Do not add a second enable switch for project settings:
empty overrides inherit the account role; empty selected-project list means all projects.
Use stable project IDs, never project name matching.

## Proposed precedence

Always require enabled account, valid authentication and unexhausted provider limits.
Eligible drainOnce accounts are first, ignoring project scope, role, account schedule,
custom quota preservation and progressive caps; stop and disable drainOnce at the first
exhausted provider limit. Disabled accounts are not silently enabled.

Otherwise apply project scope and account-wide eligibility, resolve role for this project,
then select in order:
1. Primary explicitly associated with this project.
2. Reserve explicitly associated with this project.
3. Unrestricted primary.
4. Unrestricted reserve.

Reserve drain-before-reset behavior retains its existing semantics: a reserve whose
configured drain window has opened becomes a primary-tier candidate in its own
project/general group. Balancing/priority operates within a tier.
Project reserve is fallback after project primary, ahead of unrestricted primary as explicitly requested.

Changes apply to the next request, including pinned sessions and parent affinity.
Keep affinity within the winning tier, but do not let a lower-tier pin defeat a currently
available higher-priority candidate. No eligible account returns a pool error, never
implicit direct-provider fallback. Active cursors must be scoped by project context.

## Project context

Current hub authenticates a host/client and extracts provider session affinity, not project identity.
Use BB context.projectId in provider env contributions to establish request-scoped project identity
on the hub. Opaque project-bound tokens retain the existing native-client token format.
Project identity must not be accepted from prompt text, cwd guesses, arbitrary body metadata or
an untrusted header alone. Do not mutate shared host environment per thread.
Ensure concurrent projects on one host and forked sessions cannot inherit each other's identity.
Project/transport context stays in pool infrastructure and is not forwarded upstream.

Unknown project (external clients, stale session, absent context) can use unrestricted accounts or eligible drainOnce accounts.
External clients should be capable of an explicitly configured, hub-authorized project identity;
never authorize project-restricted credentials merely because the caller claims a project ID.
Standalone operation must retain empty-list compatibility and a clear configured project context.

## Settings

Add the account routing block and editable project-role rows to the account detail card, independently of the individual quota/schedule
policy toggle. Empty selection shows "All projects". Persist immediately, matching existing UI.
Show a compact project badge/summary on accounts with a nonempty list. Resolve labels through
BB SDK project catalog. Preserve unknown/deleted IDs visibly until explicitly removed; never
convert a missing project to unrestricted use. Existing accounts need no manual migration.
Expose validated account.setProjects RPC and CLI equivalent with an explicit clear action.

## Validation

Focused tests for schema defaults/validation, persistence, RPC/CLI and UI selection/autosave.
Hub tests cover unrestricted defaults, project isolation, drain precedence, cross-project drain, drain outside schedule,
project preference over global active cursor/pin, family failover, reserve/schedule gates,
unknown project, changed allowlists, parent affinity and concurrent projects on one host.
Capture fake upstream requests to confirm project context is removed before provider forwarding.
Typecheck, focused tests and plugin build; full suite in public CI only.
Before release inspect staged changes with local publication gate and use immutable version tags.
Never replace/reload the live pool without backup, idle checks and rollback path.

## Implementation boundaries

contracts.ts/store.ts/operations.ts/rpc.ts/cli.ts: account field and configuration surfaces.
server.ts: reliable authenticated BB project context.
hub.ts: eligibility, priority tiers, affinity and project-local routing state.
app.tsx: account project selector and badges; source project catalog from SDK.
External transport/standalone: explicitly authorized project binding or unknown-context behavior.
