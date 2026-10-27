# Project-bound ZAI budget evidence

Account Pooler 0.4.43 adds `GET <plugin-http-root>/budget/zai?projectId=<expected-project>`.
The plugin HTTP root ends in `/api/v1/plugins/account-pool-balanced/http`;
the budget path has no `/v1` segment. Use the existing project-bound Bearer
credential used by `/zai/v1/chat/completions`. The endpoint never refreshes quota,
selects an account, reads provider credentials or starts inference. Authentication
is nonpersisting, including rejected project checks. Responses use `Cache-Control: no-store`.

Invalid credentials return 401; unbound credentials or a different expected
project return 403. An internal lookup failure returns a fixed sanitized 503.
A blocked route returns 200 with `route.ready=false`. The authenticated issued
context determines project and optional purpose; query parameters and headers
cannot grant a different authority. Legacy credentials remain legacy. Clients
opting into the issued `autopilot` purpose must require that exact attestation.

## Version 1

- `schema`: exactly `bb-account-pool/zai-budget/1`.
- `projectId`: authenticated project; `purpose`: issued purpose, omitted for legacy.
- `observedAt`: response time in Unix milliseconds; `maxAgeMs`: 300000.
- `route`: `provider="zai"`, `path="/zai/v1/chat/completions"`, and booleans
  `accepting`, `routingEnabled`, `networkAllowed`, `threadBypassed`, `ready`.
- `accounts`: project-visible ZAI accounts with `accountId`, `eligible`,
  `heldUntil` (Unix milliseconds or null), `budgetReady`, `usage`, `windows`.
- `usage`: null or `{source:"usage", complete:true, observedAt:<Unix milliseconds>}`.
- `windows.fiveHour` and `windows.weekly`: each contains `state` (`present` or
  `unknown`), `remainingPercent`, `resetAt`, `observedAt`, `source`.
  A present window has finite remaining percent within 0..100, future integer
  reset milliseconds, `source="usage"`, and **the same observedAt as usage**.
  An unknown window has null remaining/reset/observation/source. No absent state
  or provider admission flags are invented for this provider.

The existing successful usage collector creates proof directly from one payload,
before legacy normalization or clamping. It requires exactly two `TOKENS_LIMIT`
rows, uniquely identified by numeric unit 3 (five hours) and 6 (weekly). Percentages
must be finite numbers or nonempty decimal strings within 0..100. Resets must be
future integer Unix milliseconds (at least 1000000000000, at most the maximum
safe integer). Booleans, empty strings, hexadecimal strings, duplicate or additional
token windows, partial rows, malformed resets and provider refusal cannot create proof.
A payload with explicit code/success must indicate 200/true; transport success is
checked by the collector before parsing. Non-token limits remain unrelated.

Both windows must remain fresh, not future-dated, unexpired and error-free.
Request time and ordinary inference headers do not renew their age. Actual generic
quota-header changes invalidate the proof conservatively. A later malformed or
partial successful usage payload clears prior proof. Existing normalized cache
rows migrate as unknown, never as authoritative evidence: only a fresh valid
collector response can authorize budgets. The existing collection schedule and
account busy behavior remain unchanged. Persisted proof survives database reopen;
rollback uses the normal verified pre-upgrade database backup.

## Consumer obligations

Validate schema, expected project, issued purpose when required, exact provider
and inference path, route booleans, response/proof timestamps and both windows.
Require a nonempty eligible set and readiness for **every** eligible account;
use minimum remaining five-hour/weekly budget and maximum weekly reset across
that set. A stale, unknown, malformed, held or unready eligible account refuses
admission. Keep local floors, expiry reserves and launch accounting unchanged.

Eligibility uses the inference router's existing project, purpose, enabled,
schedule, role, cap and quota membership helper, independently of strict budget
readiness. Unknown budget proof does not hide a selectable account. Held accounts
remain represented as eligible when selectable, but their budget readiness is false.
This is a snapshot, not an account reservation or affinity guarantee. The endpoint
adds no policy, credential distribution, alternate inference route or direct fallback.

The executable contract and privacy/error/migration controls are in
`src/zai-budget.test.ts`; the existing Codex contract and consumer remain unchanged.
