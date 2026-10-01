# Per-account policy implementation plan

**Goal:** Account-specific quota protection and weekly availability, with explicit opt-in and field inheritance.
**Architecture:** Optional persisted policy on accounts; a pure resolver supplies quota thresholds and schedule eligibility to all selection paths. Existing priority, role and progressive caps remain compatible. Drain-once bypasses quota protection, never schedule availability.
**Tech Stack:** TypeScript, Zod, React, Vitest.

- [x] Add policy schema and pure policy tests in src/account-policy.test.ts: disabled overrides inherit; weekly and five-hour protection are independent; local weekday/overnight ranges respect an IANA timezone; drain-once retains schedule.
- [x] Implement src/account-policy.ts and contracts.ts validation: percentages 0..100, positive reserve lead hours <=168, unique weekdays, HH:mm ranges, validated timezone. Empty schedule means no availability; null means unrestricted/inherited.
- [x] Persist through store.ts, operations.ts and rpc.ts account.setPolicy. Missing policy preserves all current behavior.
- [x] Apply resolved thresholds to quota rejection and reset hints in quota.ts/hub.ts; apply schedule before reserve fallback; apply personal reserve lead hours in balancer.ts. Protect native and standalone clients equally.
- [x] Add a dedicated UI form with saved overrides, per-field inheritance, effective values, save errors and pending state. Account list shows custom-policy summary. Hide unsupported five-hour control.
- [x] Run focused policy, store, server and UI tests; typecheck and plugin build. Inspect diff and publication gate before push. Do not reload the live plugin.
