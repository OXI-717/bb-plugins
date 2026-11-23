# Grok API-key provider

Add `grok` to Account Pool Balanced the same way `zai` is added: one OpenAI-compatible API-key account, one mount, one env injection into `acp-grok`. The balancer, pin, cap, and failover stay as they are.

## Admitted

- Pool provider id: `grok`. BB provider id: `acp-grok`. Both stay stable.
- Secret: API key only, through `--api-key-stdin`. `--login` and `--import` refuse `grok`.
- Upstream default: `https://api.x.ai/v1`, config key `grokUpstreamBaseUrl`.
- Mount: `grok/v1/`. A `POST …/grok/v1/chat/completions` is forwarded to `{grokUpstreamBaseUrl}/chat/completions`.
- The hub token is what the thread sees. `XAI_API_KEY` receives that token. `GROK_XAI_API_BASE_URL` receives the hub path ending in `/grok/v1`. The stored key is sent upstream as `Authorization: Bearer <api key>`.
- Env is contributed only when routing is on, the thread is not bypassed, and a usable enabled `grok` account exists. Otherwise `acp-grok` keeps its own environment, including an existing `grok login`.
- No usage endpoint is called. Quota windows stay empty. Balanced mode then treats every such account as having the whole week free; failover still follows a quota rejection on the response.
- VPN: `grok` is not added to `vpnOnlyProviders`. `requiresGuardCheck("grok")` stays true, same as OpenCode Go. Kimi and Z.ai remain the only guard exemptions.
- Plugin version stays `0.4.32`. No tag, no publish, no reload of the live hub.

## Out of scope

- `grok login` / device OAuth, and any change to the `--login` flow.
- `GROK_CODE_BACKEND_URL`, `GROK_CODE_XAI_API_KEY`, and the other Grok CLI hosts. If a live `acp-grok` session does not send Chat Completions to `GROK_XAI_API_BASE_URL`, that gap is a later plan. This plan does not start it.
- A quota collector, a new dependency, a database migration, balancer edits.

## Manual check, after the tests

On a machine that has the Grok CLI, point one thread at the hub and confirm the hub receives `POST /grok/v1/chat/completions`. Until that request is seen, do not say that `acp-grok` threads are pooled. A unit test cannot prove the CLI honors the variable.
