
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
