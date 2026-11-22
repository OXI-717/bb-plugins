# Reauthorize an existing Gemini account

Add a native Gemini Sign in again action, bound to the selected OAuth account. Reuse the existing login session, authorization replacement lock and server-side secret storage. A successful login must match the selected account identity and preserve ID, policies, enabled state and routing. Removed accounts and unknown or different identities are rejected.

Use the CLI's documented --gemini-dir flag for isolated login state, retaining the default authentication subdirectory expected by the existing importer. No personal login file is read by the operator. Subscription-required errors remain access errors: signing in again does not grant a licence or clear a provider denial. Only the old credential expiry marker is cleared after a verified, same-account authorization replacement. Present a fixed explanatory message rather than raw provider JSON for this known case.

Validate synthetic identity, removed-account, persistence-failure, login isolation and UI cases; run typecheck and official build; obtain distinct review and audit the complete public delta and commit metadata before updating the existing upstream PR. No live login or deployment is part of this change.

Cancellation is accepted only before the save callback begins. A cancelled session cannot enter that callback after a delayed credential import. Once the callback starts, cancellation is declined even while it waits for authorization locks; closing the dialog does not undo a save already in progress.
