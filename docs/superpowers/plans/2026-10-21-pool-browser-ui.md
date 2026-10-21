# Account browser actions implementation plan

**Goal:** Expose existing per-account browser profiles without changing account onboarding.

**Architecture:** A strict browser.open RPC selects an existing account by ID and delegates to the existing profile/VPN/IPv4 transport. Return only a launch acknowledgement. Account menu opens the provider homepage; account details also accept an optional HTTPS authorization link. Existing Claude reauthorization can open its current link in the selected account profile. Browser launch happens on the Pooler server. Browser sign-in does not connect an account to the pool.

**Tech stack:** TypeScript, Zod, React, BB SDK, Vitest.

- [x] Add failing UI tests for menu/card, default/custom link, pending, errors and bound reauthorization. Add RPC validation/delegation tests.
- [x] Register browser.open with UUID and optional bounded HTTPS URL. Wire to openAccountBrowser using current inventory and VPN configuration. Preserve profile reuse.
- [x] Add menu action and details browser section with optional URL, visible launch status/error and server-location explanation. Preserve existing add/login paths.
- [x] Verify focused UI/RPC/profile tests, typecheck and plugin build. Inspect layout and update user docs.
- [ ] Run publication gates, commit and open PR. Obtain independent review and CI before release. Use idle-safe live delivery.

**Visual refinement:** Natural-width controls, compact actions, optional URL disclosure, and a secondary actions menu keep the account card usable on narrow panels. Browser errors are cleared for subsequent mutations so they cannot mask OAuth failures.
