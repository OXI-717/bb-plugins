# Project-bound Codex budget evidence

Account Pooler 0.4.34 adds `GET <pool-base>/budget/codex?projectId=<expected-project>`.
Use the same Bearer credential as the project's Codex inference route. The endpoint
is read-only: it does not start a model, read Google/local OAuth credentials,
refresh quota, select an account or change account policies. All responses use
`Cache-Control: no-store`.

Invalid credentials return 401. An unbound credential or a different expected
project returns 403. The project comes exclusively from the authenticated token;
the query cannot choose a different project. No email, account label or credential
is returned. A blocked route returns 200 with `route.ready=false`, never optimistic
availability.

## Version 1

The response contains:

- `schema`: exactly `bb-account-pool/codex-budget/1`.
- `projectId`, `observedAt` (Unix milliseconds), `maxAgeMs` (300000).
- `route`: `provider="codex"`, `path="/v1/responses"`, `accepting`,
  `routingEnabled`, `networkAllowed`, `threadBypassed`, `ready`.
- `accounts`: project-visible Codex accounts only, each with `accountId`,
  `eligible`, `heldUntil`, `budgetReady`, `usage`, `slots`, `windows`.
- `windows.fiveHour` and `windows.weekly`: `state` (`present`, `absent`, `unknown`),
  `remainingPercent`, `resetAt`, `observedAt`, `source` (`usage`, `header`, null).
- `slots`: primary/secondary presence with the normalized current window, or null.
- `usage`: the last authoritative usage-response observation, or null. It preserves
  `allowed`, `limitReached`, per-slot presence and its own observation timestamp.
  It is also exposed by normal status/RPC and persisted in the quota database.

`absent` is explicit evidence of no window, **not a fabricated 100% balance**.
Only complete fresh usage semantics, with both slots accounted for by explicit
null or actual duration, can prove absence. An omitted property remains unknown.
Unknown durations, duplicate canonical durations, nonintegral minutes, expired
resets, missing admission flags, denied/limited usage, future or stale observations,
and stored quota errors cannot produce `budgetReady=true`. Partial inference
headers describe actual observed windows but never establish completeness on their
own. Old database rows have unknown evidence until normal usage collection runs.

Windows are identified by duration: 300 minutes and 10080 minutes. Primary does
not mean five hours, and secondary does not mean weekly. Quota observations older
than five minutes are not suitable for new budget authorization; request time does
not refresh an old observation. Custom durations remain visible but budget readiness
fails closed for clients of this two-window contract.

## Consumer obligations

Verify the configured pool route, schema version, provider/path, expected project,
response timestamp and each observation timestamp. Clamp freshness to your own
maximum; do not let a response relax local headroom floors or launch accounting.
Require `route.ready=true`, a nonempty eligible set, and **every** eligible account
to have `budgetReady=true` and satisfy your configured floors for present windows.
An absent window does not consume that window's floor; unknown must refuse.
Never choose only the account with the most headroom: routing may select any
eligible account during fallback or affinity handling.

`eligible` uses the same project role, schedule, shared/family quota and progressive
cap membership as inference routing. It includes waitable held accounts because
existing affinity may select one; an active hold makes `budgetReady=false`.
Disabled, scoped-out or policy-ineligible accounts cannot authorize a budget.
Eligibility is a point-in-time observation, not a reservation or promise about a
future request. Keep the ordinary budget guard and error handling at launch.

Existing global status eligibility, direct OAuth and legacy proxy interfaces retain
their meaning. This endpoint does not turn global availability into project proof.

## Issued-client purpose attestation

For an authenticated project-bound credential issued with `purpose="autopilot"`,
version 1 additionally returns root `purpose: "autopilot"`. Ordinary credentials
retain their original response shape. The same account membership helper serves
inference and this endpoint: accounts without `autopilotAllowed` cannot be eligible,
even with drain or prior affinity. Project-visible denied accounts may be listed
with `eligible=false`; they cannot authorize a budget. Every actually eligible
account still has to satisfy the consumer's original conservative checks.

A purpose-opted consumer must require this exact attestation and reject an absent
or different purpose, while retaining project/schema/route/freshness/window/floor
checks. Legacy consumers can ignore this additive field. This is neither a selected
account reservation nor a new quota API for other providers.


## Collecting usage during active requests

Starting with Pooler 0.4.39, Codex usage reads may run while the same account is
serving inference. The Codex adapter opts into this capability; other providers
retain their busy-account refusal. Concurrent usage checks coalesce into the
existing per-account single flight. Usage and inference share the existing OAuth
refresh lock, persisted refresh-token ownership and network policy checks; this
does not create an independent token refresh owner or bypass authentication.
An upstream usage401 may request the existing guarded refresh and retry once.
A definitive refresh refusal remains an authorization error.

This removes the local busy guard before the usage endpoint is contacted. It
does not guarantee provider availability or a complete payload: unknown, stale,
malformed or contradictory evidence remains insufficient, and explicit absence
still requires complete successful usage evidence. Existing budgets, project and
trusted-purpose eligibility, account settings and all-eligible semantics do not
change. Ordinary responses continue updating header evidence as before.


## Neutral headers after an explicit absent slot

Starting with Pooler 0.4.40, a header slot with no duration, positive utilization,
rejection or future reset does not replace an absent slot already proven by
complete, still-valid usage evidence. The usage observation timestamp is retained;
headers cannot renew its five-minute lifetime. This is based on the normalized
observation and a valid usage proof, not an assumed raw zero sentinel. Without
that proof, the same headers remain insufficient to establish absence.

A newly supplied duration, positive utilization, rejection, future reset or
malformed header still refuses authorization. Malformed over-limit booleans and
explicit over-limit rejection also invalidate the prior allowance. Budget schema,
floors, project/purpose eligibility and all-eligible semantics are unchanged.
