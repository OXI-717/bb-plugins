# ACP pool authentication

Objective: restore Grok and Gemini ACP authentication through the existing pool hub without changing accounts, routing or exposing upstream credentials.

1. Trace the installed ACP/CLI authentication contract and reproduce the reported failures using existing evidence and synthetic fixtures.
2. Add focused regression tests before the minimum production correction. A pooled session must carry only a scoped hub token and route all requests through the hub; upstream subscription credentials remain server-side.
3. Validate focused tests, typecheck and official plugin build. Obtain independent review of the exact source before any live application.
4. Before live verification, qualify active requests, state backup and rollback. Verify a harmless ACP response and hub traffic for each provider. Stop the affected phase if it needs an architecture or product decision.

Findings: Grok and Gemini OAuth are both authenticated by the Pool hub, but their clients consume credentials differently. The Grok ACP route accepts scoped environment values. `agy` 1.5.0 ignored `ANTIGRAVITY_GEMINI_DIR` for ACP auth and reads its cached consumer token from `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`. The Pool now supplies a Pool-owned `HOME` containing only its scoped hub token and routes `CLOUD_CODE_URL` to the hub; it does not copy the user's Gemini settings or refresh token. A synthetic ACP session opened with eight requests to a loopback server and no prompt. A real Gemini call and live activation still require the separate backup, rollback, idle-window and one-call gates in the active task.
