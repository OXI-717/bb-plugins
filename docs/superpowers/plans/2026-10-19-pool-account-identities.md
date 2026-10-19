# Account identities for every pooled provider

The thread header should show the email of the account actually used by that thread, for every pooled provider. Use authenticated thread-scoped hub tokens to correlate successful requests without guessing from the host-wide last-used account. Retain the existing native session observation fallback for older running processes. No observation means no claimed account; a bypassed thread remains outside the pool.

Existing OAuth email is provider-supplied and read-only. API-key accounts can have a user-supplied contact email in account settings because an opaque key does not establish a registration address. Validate it, allow clearing it, and never claim it was verified by a provider. Without an address, retain the account label. Token rotation/pruning/reload must preserve host/project/thread binding; external clients are unchanged.

Verify isolation between two threads on the same host/project, account rotation, bypass, deleted/missing accounts, token lifecycle, manual email persistence/validation and header rendering. Focused tests and build locally; full suites in CI. Keep recovery PR separate.
