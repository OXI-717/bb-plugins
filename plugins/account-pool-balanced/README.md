# Account quotas

Open an account’s **Details → Weekly rule** to keep the pool defaults, set a
fixed ceiling, or set steps relative to the provider’s weekly reset. Each
percentage is a cumulative share of the provider’s weekly allowance. For
example, 50% initially, 65% with 48 hours left, and 80% with 24 hours left.

On a configured rule, **Change ceiling now** applies until the next step or
the reset. The recurring rule stays in place for the next cycle. On Cursor,
steps follow the billing cycle reset reported by the provider. If the
reset is unknown, the initial ceiling applies to reported weekly usage and
temporary overrides are unavailable. The rule replaces the shared weekly
reserve and progressive weekly cap for that account while selected. Shorter
windows, model-specific quotas, other existing quota windows, and provider
limits still apply independently.

# Recovering a native lease

Use **Check process and release** in Pooler settings, or run
`bb pool native check-stopped <lease-id>`. Pooler checks the exact expired
lease on its assigned host. A live process, missing identity, or unavailable
host leaves the lease in place. The CLI returns JSON and exit code 2 when
the lease is kept.

Manual `attest-stopped --confirmed` still requires the existing operator
grant. Replacing this override requires a verified BB owner signal or another
explicit authorization capability. The general SDK client caller is not
sufficient to authorize an override.

# Optional automatic prepared-native unlock

A prepared executor can explicitly add `unlock` with a fixed Oxi Op access
`profile` and `operation: "prepared-native-keyring-unlock"`. Absence is the default;
existing executors, accounts and ordinary native admission are unchanged.
Only task admission can issue `unlock-start`. The server owns the operation
profile and full immutable execution tuple; the caller supplies only its existing
lease ID. One issued request and its consume state are persisted in the existing
native lease registry before lookup. The Oxi Op plugin must consume through the
verified plugin-only SDK RPC after the same actual policy checks. Client RPC,
catalog, expiry, policy revocation and a failed durable write cannot obtain it.

The finite operation uses a deadline at most 25 seconds and no later than the
issuing lease. Polling cannot extend that operation deadline. No retry or fallback
is performed. `unlock-cancel`, RPC loss, expiry and restart retain an uncertain
slot when cleanup cannot be proven. A caller's `stopped: true` alone cannot release
an unconfirmed operation. Existing operator attestation remains the recovery path.
BB must support verified plugin RPC caller and abort context (0.48.1+); otherwise
this optional RPC refuses. See [Oxi Op's fixed mapping and limits](../oxi-op/README.md#prepared-native-tasks-optional-linux-default-off).
This source path does not activate prepared isolation or prove a live provider.
