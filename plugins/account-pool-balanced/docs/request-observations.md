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

## Codex quota-header evidence (0.4.41)

Codex `upstream` events may additionally contain `codexQuota`, observed at the existing response-header/adapter boundary. No extra provider request is made. `primary` and `secondary` are fixed five-element tuples in this order: `used-percent`, `window-minutes`, `reset-at`, `reset-after-seconds`, `over-limit`, for the respective `x-codex-<slot>-` header prefix. Numeric fields are finite numbers within the safe integer magnitude; boolean fields are case-insensitive exact true/false. Missing, empty and unrepresentable values become the fixed strings `missing`, `empty`, `invalid`. Zero and negative finite numbers remain numbers: recording them does not declare them valid quota evidence. Arbitrary invalid strings and all other headers are discarded.

`priorUsage` records the existing complete/partial usage proof before the adapter call: observation time, signed age in milliseconds, primary/secondary states and allowed/limitReached flags; null means no proof existed. A future observation has negative age, not fresh proof. `priorDurations` lists primary/secondary durations before merging (null if unavailable). `evidencePreserved` reports whether that same proof survives the actual adapter call. These are diagnostic facts, not another validity evaluator; numeric fields and states do not authorize requests or imply fresh budget readiness. A missing diagnostic can mean an older record or isolated collection failure. Existing journal identity, retention, size, coverage and failure limits apply unchanged. Read only the target account/time when investigating; the journal cannot recover prior raw header values.

## Shared account admission (0.4.45)

`maxConcurrentRequestsPerAccount` is a server setting, default **2**, valid integers
1–32. It applies independently to each selected account and to every provider's
forwarded inference/RPC route, across native BB hosts and issued external clients.
It limits requests, not open threads. A slot remains occupied through stream end,
cancel or error, not merely until response headers arrive. Quota collectors and
OAuth calls retain their existing separate coalescing/ownership; they do not use
these inference slots or generate inference pressure observations.

Additional requests enter a FIFO admission queue, bounded to 64 waiting requests
per account and 1,024 across the server. Capacity and cooldown waits have a shared
15-minute deadline; disconnect or pool stop cancels waiting requests. Overflow or
deadline returns HTTP 503 with `POOL_QUEUE_FULL` or `POOL_QUEUE_TIMEOUT`, never a
fabricated upstream 429. Existing active streams drain under the normal stop
contract. Lowering the limit does not interrupt existing streams.

A generic upstream 429 sets an account cooldown from Retry-After. Header/usage
merges cannot shorten any still-active persisted cooldown, including a late 200
from an already-running request. Dispatch rechecks cooldown and current account,
project and purpose eligibility after asynchronous network guards and account
snapshot acquisition. Session affinity stays on its account. Unbound requests
may use another already-authorized eligible account under existing routing;
family-specific quota rejections retain their existing quota/reset behavior.
No new account is enabled or opted into any workload.

`status` adds per-account `queuedRequests` and `concurrencyLimit`. The settings UI
shows current active/queued requests by provider and edits the shared account
limit. `observations` returns only the last 100 rows plus aggregates over **all
retained rows**: provider and account attempts, upstream 429s, account peak active
requests, and provider queue waits/failures. `totalRetainedRows` and
`rowsTruncated` distinguish the returned page from retention eviction.
`attempt` events mark actual dispatch; `queue-wait` records a completed wait or
queue refusal. These remain lower bounds over the disclosed retained interval,
not permanent usage accounting. Local queue refusals, upstream failures and
historical local-held 429 records are separate.

Two concurrent requests is a conservative initial operator setting, not a
published provider guarantee. Concurrency alone cannot prevent variable provider
request/token limits or shared subscription consumption outside this server.
Respect provider cooldowns and observe natural traffic before adjusting it.


## Bounded hourly traffic history (0.4.48)

`bb pool history --json` inspects independently persisted hourly counters for up to
fourteen days. The existing `observations` output also includes `history`; the
short event ring remains unchanged. Both commands are local authorized inspection,
not new public endpoints. No provider, quota or model calls are made.

Each aggregate groups provider, selected account UUID (or null before selection),
authenticated client hash and project. There are no prompts, response bodies,
raw headers, credentials, request IDs, thread IDs, model strings or diagnostic
quota tuples in long-term storage. Machine labels are resolved on inspection
from the current trusted host directory, never recorded from request payloads or
persisted in history. External clients without a trusted machine mapping remain
hashes; they must not be presented as guessed machine names. Lookup failure sets
`identitiesAvailable=false` and preserves counters without guessing labels.

`requests` counts logical starts and therefore belongs to the null-account row.
`firstDispatches` counts the first actual upstream dispatch assigned to an account;
`attempts` includes retries and failover dispatches. Do not sum attempts as unique
requests or assign pre-selection refusals to an account. Upstream responses, 429,
401/403 and 5xx are counted only at upstream header events; pool-local held 429,
queue waits/refusals and completed/canceled/error stream lifetimes are separate.
Hold/result events do not count a second upstream failure. Latest 429/auth/queue
failure timestamps support the existing observer even after raw-event eviction.
Stream duration sums are recorded in the hour in which the stream ends, and may
include concurrent streams or ones begun earlier: they are not wall-clock busy
percentages. The account peak is an observed dispatch/header count, not a provider
limit. Missing ended streams after a process crash cannot be reconstructed.

The file cap is 8 MiB / 8,192 aggregate buckets, in addition to the existing raw
2 MiB / 2,048-event ring. At cardinality capacity the oldest hour is evicted as a
group for new hours; within a full single hour new keys are omitted while existing
keys continue counting. `capacityEvictedBuckets`, `capacityDroppedEvents` and
`truncated` disclose these limits. Hour buckets expire entirely after fourteen
days (the boundary may shorten coverage by less than an hour). There is no
append-only log or per-request file. One temporary atomic replacement adds at most
another 8 MiB. The containing directory is 0700 and files are 0600. Temporary files
are removed at startup or failed writes. Expiry runs on the journal's existing
background tick even with no traffic. Filesystem refusal may prevent replacement
or deletion; it increments the isolated history failure counter, never blocks or
fails forwarding. A single asynchronous write per file coalesces changes; failed
history writes retry on the next tick. No new service, timer or scheduler is added.

History starts on this version's installation and survives ordinary restarts; it
is never inferred from the truncated legacy ring. `startedAt`, `observedAt`, caps,
omission counters and `storageFailuresSinceStart` must accompany any report.
Unavailable/corrupt storage resets the new in-memory start boundary and reports
failure; crashes can lose the last coalesced snapshot. This is operational traffic
coverage through this pool's existing forward seam, not complete subscription
accounting or proof about independent applications. It cannot quantify ban risk.
Actual 429/auth/queue failures are reasons to investigate under existing policy,
not authorization to disable, reroute or rotate an account automatically.
