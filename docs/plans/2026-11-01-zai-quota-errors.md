# Z.AI quota failure diagnostics

Keep authentication, quota interpretation, timeouts, account eligibility and routing unchanged.
At the existing Z.AI failure boundary, expose only the existing transport code/category
allowlist, a fixed phase and elapsed milliseconds. DNS/connect/TLS codes identify those
failures; headers means awaiting the fetch response, not proof of a particular socket stage.
Classify response-read failures as body and invalid JSON as parse. Never include upstream
messages, headers, bodies, URLs or credentials. Preserve other compatible providers.

Validate each requested phase and a synthetic secret canary, then typecheck/build with
the current host SDK. Freeze for distinct review and a native MR. Runtime observation
requires a fresh zero-flight window, an opaque state backup and a written native
rollback command; no production activation before these concrete checks.

## Scoped retry after a persisted collection failure

First reproduce the explicit refresh being rejected before fetch after a stored
Z.AI network collection error. Permit secret retrieval only in the Z.AI API-key
quota refresh context for that exact legacy failure or its sanitized diagnostic
form. Do not clear the error, change routing eligibility, or admit other errors.
Only a measured valid quota response restores eligibility. Validate zero HTTP
calls before the fix, a fresh call afterward, and preserved HTTP 401/403 and
other-provider refusals. This source change requires a separate runtime grant.
