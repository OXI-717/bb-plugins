# External pool implementation plan

**Goal:** Run the existing account pool without a BB server and connect ordinary coding-agent clients, including agents launched in Orca. Add Devin through its documented session API after confirming the desired Devin surface.

**Architecture:** Reuse the existing hub, adapters, quota database and affinity logic. A small portable storage interface replaces the type-only BB storage dependency. A standalone Node entrypoint owns SQLite, private account files, client tokens and HTTP lifecycle. BB keeps its current storage and lifecycle; no automatic migration of live accounts.

**Alternatives considered:** A gateway into BB is smaller but still requires BB; duplicating the balancer in a new server creates two implementations. Reusing the core with a second host avoids both problems. Physical package extraction can follow without changing the wire contract.

**Contracts:** Only explicitly supported model paths are served. Client credentials authenticate before forwarding; provider secrets stay on the server. Streaming responses and cancellation propagate. Bind to loopback by default; use a TLS reverse proxy for remote clients. Account administration is a local CLI, not an unauthenticated HTTP surface. Data paths are supplied by the operator. Never open BB's live data directory as standalone storage.

**Devin:** API v3 creates cloud sessions under an organization. It is not a model completion API. Select an account when creating a session, retain its binding, never automatically retry an ambiguous creation on another account. ACU caps are explicit. Local CLI subscription transport is a separate capability and must not be advertised as supported by the cloud adapter.

## Execution

- [x] Add standalone integration tests: authentication, real upstream forwarding/streaming, durable state, route allowlist, shutdown.
- [x] Introduce `src/core-storage.ts`; use it in `store.ts` without runtime BB imports.
- [x] Add `src/standalone/runtime.ts` (SQLite + hub) and `http.ts` (bounded HTTP bridge).
- [x] Add `src/standalone/cli.ts`: serve, local account import, client credential creation/revocation, private output files.
- [x] Document Claude and Codex process-scoped setup and Orca terminal use; verify against installed client contracts.
- [x] Implement the originally proposed Devin cloud API surface with session binding and failure tests. Local CLI scope remains separate.
- [ ] Run focused tests, typecheck, plugin build. Review diff and local publication gate before any public push. Keep live plugin unchanged until release verification.

Validation uses synthetic accounts and a loopback upstream, never production credentials. Report separately what was tested locally and what requires a real provider login.

Implementation also adds `bb pool client add/revoke`, so an external client can use existing BB accounts without a storage migration. Host tokens and external client tokens have separate stores. Native BB operation continues to use its current storage/lifecycle; BB remote-control UI for a standalone server is not included. Remaining-credit balancing for Devin and native Orca provider integration are outside this first increment.
