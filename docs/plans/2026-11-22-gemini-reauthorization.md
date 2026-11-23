# Reauthorize an existing Gemini account

Add a native Gemini Sign in again action, bound to the selected OAuth account. Reuse the existing login session, authorization replacement lock and server-side secret storage. A successful login must match the selected account identity and preserve ID, policies, enabled state and routing. Removed accounts and unknown or different identities are rejected.

Use the CLI's documented --gemini-dir flag for isolated login state, retaining the default authentication subdirectory expected by the existing importer. No personal login file is read by the operator. Subscription-required errors remain access errors: signing in again does not grant a licence or clear a provider denial. Only the old credential expiry marker is cleared after a verified, same-account authorization replacement. Present a fixed explanatory message rather than raw provider JSON for this known case.

Validate synthetic identity, removed-account, persistence-failure, login isolation and UI cases; run typecheck and official build; obtain distinct review and audit the complete public delta and commit metadata before updating the existing upstream PR. No live login or deployment is part of this change.

Cancellation is accepted only before the save callback begins. A cancelled session cannot enter that callback after a delayed credential import. Once the callback starts, cancellation is declined even while it waits for authorization locks; closing the dialog does not undo a save already in progress.


Interactive Google code entry uses a masked input in the Gemini login dialog. Submit once to the existing session through the CLI stdin pipe, never through arguments, stored settings or logs. Validate expiry, cancellation and bounded single-line input. Clear the input on submission, restart and close; retain polling for completion and the existing same-account save boundary. Sessions launched before this change cannot acquire a stdin pipe and must be restarted by the user.


An explicit Gemini OAuth quota refresh may revalidate a stored, structurally recognised Google subscription refusal (403 PERMISSION_DENIED with SUBSCRIPTION_REQUIRED). This permission applies only to quota collection, never model requests or account eligibility. Periodic refreshes and other stored errors retain their guard. The account stays unavailable until a valid quota observation; non-success HTTP responses, malformed JSON and missing quota data fail visibly without clearing the stored denial. Reauthentication alone still grants no subscription.


The upstream reconciliation keeps API-key-only Grok accounts available for routing, while omitting their unsupported quota collector from Provider Usage. Grok OAuth accounts retain the existing subscription collector. This avoids presenting an unavailable API-key quota endpoint as a failed measurement; no missing value becomes zero. Both legacy and versioned Grok Pooler URLs remain accepted for existing sessions. The upstream native thread-account selection controls are retained in the host header action and shared overlay.
