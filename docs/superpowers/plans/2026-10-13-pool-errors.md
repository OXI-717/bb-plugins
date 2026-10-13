# Pooler error standardization

Scope: Pooler-owned refusals and failures, with native provider envelopes preserved. Distinguish policy quota threshold from provider exhaustion, pacing, authentication, VPN/Guard, project/schedule constraints, missing accounts and temporary upstream failures. Stable machine codes in x-bb-pool-error and JSON/message; no account identifiers or secrets in diagnostics.

Cursor must receive valid Connect unary errors or a framed EndStream error for streaming requests, according to https://connectrpc.com/docs/protocol/. Other adapters retain Anthropic/OpenAI envelope shapes. Quota policy refusals do not acquire Retry-After or start automatic quota retries.

1. Add failing protocol and quota classification regressions.
2. Introduce shared rendering and reason classification; route Hub errors through request-aware adapters.
3. Verify through isolated Hub requests, typecheck and managed build. No live reload or quota-policy changes.
4. Run privacy gate, public CI and independent exact-SHA acceptance; release a new immutable Pooler version.

Limit: external CLI/BB wrappers may still prepend their own error text. Midstream transport errors and upstream passthrough protocols remain separate from local refusal rendering.
