# NVIDIA NIM pool support

Use the existing OpenAI-compatible adapter for NVIDIA, independently of Kimi.
The official model page documents https://integrate.api.nvidia.com/v1 and
`deepseek-ai/deepseek-v4.1-flash` via Chat Completions:
https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash.

Expose Chat Completions (including streaming) and GET models only. Do not
translate Responses payloads or invent quota, plan, billing or renewal data.
Keep the provider key server-side and contribute only scoped hub credentials.
Use the native ACP custom-agent mechanism for model selection; inspect its
installed contract before configuration. No new dependency or parallel service.

Validate synthetic end-to-end account/route/auth/SSE, malformed bodies, error
handling, unchanged existing providers, UI, typecheck and official build. Freeze
and review before activation. A live change requires an idle pool, verified
state backup and a known prior source for rollback. Keep existing accounts and
policies intact. Credentials enter only through the native secret form.

The owner's additional request includes IFM (`IFM/K2-Horizon-375B-A23B`),
using the same isolated mechanism at https://api.ifm.ai/v1.
Official reference: https://docs.ifm.ai/ . Published daily allowances are
not observations of an account's remaining quota. Do not fabricate a balance.

The unified source pinned SDK 0.4.94 while using grouped queuedMessages.
Align the existing SDK to 0.6.104 for BB 0.48.1. Reuse the previously reviewed
native header action and overlay, preserving the dialogue and refresh behaviour.
