# Bounded request observations

Account Pooler 0.4.35 adds `bb pool observations --json`, a local BB CLI inspection command. It does not contact providers, refresh quotas, select accounts or change policy. There is no new public HTTP endpoint. Use the existing BB CLI authorization; treat the output as private operational metadata.

The journal starts with authenticated requests that passed the hub's admission guards and reached `forward`. Invalid tokens, pre-forward refusals, model catalog/auxiliary quota calls, and specialized routes that bypass `forward` are outside coverage. It cannot reconstruct incidents before installation. Records correlate only what the server actually knows:

- A pool-generated random request ID identifies one logical forwarding operation. Its `attempt` is zero until the first upstream attempt, then increments on every upstream fetch, including retries to the same account. It is not a caller-supplied or upstream request ID.
- `clientHash` is a truncated SHA-256 of the authenticated context's host/client identifier, never of a token. For a machine's project/thread credentials this is the machine identity; for external credentials it is the external client identity. Labels, names, emails, token values and provider-side session identifiers are never recorded. Correlate with known authenticated contexts; the hash is not proof of a human identity.
- `projectId` and `threadId` come exclusively from the authenticated token context and must match canonical BB ID shapes; otherwise null. External clients often have no thread binding. Body/header session IDs are never interpreted as BB thread IDs.
- `model` is an exact allowlisted request model ID; unfamiliar aliases remain null. `modelFamily` is the adapter's existing classification, not proof of an upstream selected model. No request text or response model headers are logged.
- `accountId` is the selected account's internal UUID. `inFlight` is the total upstream count; `accountInFlight` is the selected account's count at that observation. Attempt events precede increment; stream-end events follow decrement. These are instantaneous counters, not a provider concurrency quota.

Event names distinguish causal observations:

| Event | Meaning |
| --- | --- |
| `request` | One logical operation entered forwarding |
| `attempt` | A fetch is about to be attempted; it may still fail a network guard |
| `upstream` | Headers arrived; status and time to headers are known |
| `hold` / `upstream429` | Non-quota upstream 429 created an account deadline |
| `local-held` / `existing-hold` | Pool formed a local 429 because the selected pinned account was already held |
| `hold` / `upstream403` | Recoverable upstream 403 created an account deadline |
| `result` | Forwarding returned response headers or threw; this is not stream completion |
| `stream-end` | Upstream resource released once, including completion, cancellation or read/fetch error |

`retryAfterMs` records the existing routing parser's effective delay, not a new policy. Missing/invalid Retry-After defaults to one second; `retryAfterSupplied` distinguishes presence only, not validity. No original header strings are retained. `quotaEvidence` records the adapter's quota rejection predicate for upstream 429: Codex window over-limit/used-percent headers or Claude rejected rate-limit status headers. False does not prove per-minute throttling, concurrency exhaustion or overload. There is no provider-side per-minute/concurrency evidence field because the current adapters do not establish that contract. `errorClass` is a fixed local classification, never an upstream error message. A local held event cannot recover the original hold's source once that earlier record has expired.

`result.failover` is `none`, `succeeded`, or `failed`, based on whether multiple distinct accounts were attempted and the final HTTP response was successful. `outcome=failed-over` means multiple accounts were attempted; check the status/failover fields to determine success. Retries on one account remain a single-account operation. Duration at result is time to returned headers; duration at stream-end is that attempt's full resource lifetime. An internally discarded failed attempt is canceled; cancellation alone does not identify which side ended the request.

## Retention, limits and failure behavior

At most 2,048 validated records from the last 24 hours remain in memory and in one private snapshot under the plugin's server data directory. The snapshot is limited to 2 MiB; one temporary replacement file can add at most another 2 MiB. The dedicated directory is mode 0700 and files 0600. This is a shared event cap, not 2,048 complete requests: requests may lose their earliest or latest events under load.

Recording performs no disk I/O. Once per second, a background task coalesces changes into an atomic asynchronous snapshot. Only one write is in flight; a slow write cannot create an unbounded queue. Storage/validation failure does not throw into forwarding or streaming. Data since the last snapshot can be lost on a crash. Failed writes increment a counter, without logging exception text; the next changed snapshot can try again. Disposal flushes the bounded snapshot. A periodic pass removes expired rows even without new traffic. Abandoned temporary files are removed at initialization and after failed writes. Filesystem refusal can prevent deletion or replacement; the failure counter reports that limitation and routing continues. Retention enforcement resumes when storage permits it.

The response declares `coverage=retained-events-only`, oldest retained timestamp, row/time caps, `truncated`, eviction and storage-failure counts since process start. Counts restart with the plugin process. Minute aggregates cover only retained events in the trailing hour: `logicalRequests` counts `request` events, `attempts` counts `attempt` events, and upstream 429, locally formed held 429 and upstream 403 holds have separate counters. Missing/evicted events make these lower bounds, not complete traffic rates. Raw per-token/chunk events are not emitted. Inspect per-record identity/provider fields to attribute repeated requests within this bounded sample; absence of a record is not evidence of absence of traffic.

The feature observes naturally occurring traffic. It requires no model smoke call, canary, quota refresh or account change. Install through normal accepted publication and a coordinated idle-only update; never hotpatch a running pool.
