# Gemini declared usage

Preserve the existing quota aggregation and routing thresholds. Store optional display-only Gemini observations in the existing account JSON, without a database migration. Read per-model quota buckets from the existing quota response and enrich them through the already supported loadCodeAssist route. A failed auxiliary request must not discard valid quota. Only declared tier identifiers/names and GOOGLE_ONE_AI credit balances are retained; absent fields remain unknown. Provider Usage supports percentages but no absolute credit balance: show the declared balance in the existing account label, never manufacture a limit or monetary cost.

Validate synthetic positive, missing, malformed and auxiliary failure cases, persisted account compatibility, UI and Provider Usage, then typecheck and build. Obtain distinct review and the local publication gate before updating the existing PR. No live operation or authenticated probe.

Reference: Google Gemini CLI code_assist/types.ts (LoadCodeAssistResponse, GeminiUserTier, Credits, BucketInfo). Public types are evidence of optional fields, not a measured response for an account.
