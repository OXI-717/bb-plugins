# Scoped cached provider budgets

Generation routes and numeric budget evidence are separate capabilities. A working
model catalog, an enabled account or a successful request does not establish an
available numeric budget. The existing Codex and ZAI contracts are unchanged.

For the other seven providers, ordinary project clients and purpose-bound clients
can read `GET B/budget/{provider}` for `claude`, `kimi`, `opencode-go`, `cursor`,
`neuraldeep`, `agy` and `devin`. B is the existing pool HTTP mount. Authenticate
with the same scoped pool token used for generation, never a provider key. Server
stored token identity binds project, optional purpose and thread. Optional
`projectId` must match that identity; it grants no access. Unbound clients are
refused. No token, label, email or upstream response body is returned.

The schema is `bb-account-pool/provider-budget/1`. `provider`, `projectId`, optional
`purpose`, server `observedAt`, `maxAgeMs`, `eligibilityScope: "shared-policy-superset"`,
existing route flags and `accounts` are
returned. Each account has `accountId`, conservative `eligible`, `heldUntil`, `supported`,
`budgetReady`, `reason`, `coverage`, `usage` and `windows`. A ready window contains
`id`, `remainingPercent`, `resetAt` (epoch milliseconds, nullable when the source does not promise it), and `durationMinutes`
(null for Cursor's calendar billing cycle). Empty windows mean unknown, not 100%.
Antigravity uses opaque `group:GROUPHASH:BUCKETHASH` IDs; names and descriptions
are not copied into budget output. Group windows are not relabeled weekly, nor
are they mapped to arbitrary model IDs. A conservative consumer must check every
reported group; an absolute remaining amount without its denominator cannot
become a percentage. Empty/disabled/partial groups refuse strict proof.

A snapshot timestamp is not the evidence timestamp: use `usage.observedAt`.

| Provider | Numeric source | Required windows |
|---|---|---|
| Claude | Existing OAuth usage collector | `fiveHour`, `weekly`; all reported family windows are retained |
| Kimi | Existing usage collector | `weekly`, every reported `rolling:MINUTES` window |
| OpenCode Go | Existing usage collector | `fiveHour`, `weekly`, `monthly` |
| Cursor | Existing plan-usage collector | `billingCycle` (plan only, not on-demand spending) |
| NeuralDeep | Existing `/v1/limits` collector | `session`, `weekly` chat ratios and provider `can_request` decision |
| Antigravity | Native CCPA `retrieveUserQuotaSummary`, existing scheduler | All reported group/bucket fractions and resets |
| Devin | No numeric collector contract implemented | `supported:false`, unknown |

Do not treat a missing family window as proof that a model family has no limit.
Coverage is the provider's reported subscription windows, not every possible
model, spending or concurrency restriction. Cursor's billing cycle must not be
renamed weekly. Kimi's actual rolling duration must not be renamed five-hour.

NeuralDeep uses its documented effective `chat.session/week` remaining/limit
ratios and the server's `decision.can_request`, `key.status` and chat cooldown.
Its public response contract does not promise reset timestamps: those stay null,
and a reset-dependent consumer policy must refuse rather than invent them.
`providerAllowed` carries the provider decision; RPM counts are never presented
as a subscription percentage. No quota multiplier is applied again.

Proof starts only at a new complete valid collector response; old normalized
cache is never promoted. Out-of-range, missing, ambiguous duplicate or malformed
numeric windows refuse proof. New evidence lasts at most ten minutes (two existing
five-minute collection intervals), and never beyond any reported reset; missing resets remain explicit for NeuralDeep only. This
separate TTL changes neither Codex nor ZAI freshness. Collector failure clears
strict proof without changing old displayed utilization or account policy.
Inference headers do not renew proof age; observed quota updates invalidate proof
until a new complete collector result. Busy/failed collectors can leave evidence
unavailable. No new timer or on-demand refresh is added. Antigravity replaces its existing
no-op usage hook with one bounded native quota-summary request through the same
guarded transport and server-held subscription identity. Other collectors reuse
their existing payloads without additional requests.

`eligible` uses the existing shared-policy account set before model-family
filtering: project, purpose, enabled state, schedule, shared quota and reserve
membership gates remain intact. Every family-specific generation candidate is
in this conservative superset. A blocked `other` family cannot hide an account
which Sonnet or another family can select. The set can contain accounts blocked
for a particular model: this is not model authorization. Consumers must require
the declared eligibility scope and check every eligible account; actual dispatch
rechecks the selected family and all account policy.

Consumers must verify exact schema/provider/project/purpose, route readiness,
clock freshness, all **eligible** accounts, each required window and their own
budget floors/model restrictions. An unknown eligible account must not disappear
from an ALL-selectable check. `budgetReady` describes available evidence, not a
reservation or unconditional admission. The pool checks real policy again at
actual dispatch. Unsupported evidence must not become an unlimited budget or a
reason to disable an otherwise working interactive connection.

These endpoints are cached reads only: no quota refresh, secret read, model
request, account selection, credential issuance or settings mutation. Tests use
synthetic payloads and local fake hosts. Live source collection, installation and
consumer admission require their own evidence; source tests do not establish them.

Antigravity source: the native client documents [model quota usage](https://antigravity.google/docs/cli/commands/usage). Its CCPA quota-summary request uses the same server-bound personal subscription project and endpoint as generation; no local host login or paid API fallback is used.

NeuralDeep source: [Limits API](https://neuraldeep.ru/docs/limits-api.md). This integration starts parsing the payload already requested by the existing collector; it does not add a second request or send the provider key to clients.
