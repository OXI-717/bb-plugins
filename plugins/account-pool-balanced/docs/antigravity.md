# Antigravity personal subscriptions

Pooler 0.4.38 adds the native Antigravity GenAI gateway. When the existing Guard
integration is enabled, use VPN Guard 0.1.19 or later; the only Guard change is
accepting the provider identifier. Existing policy, defaults and saved settings
are preserved. Selecting VPN-only for this provider remains an operator choice.

## Server login

Use **Antigravity → Add → Sign in with Google** in Pooler. Open Google's consent
page, authorize the subscription, then paste the final loopback callback URL
(or its authorization code) into that same dialog. The remote browser may show
an unreachable loopback page; the address contains the result. Treat it as a
credential. Do not paste it into chat, an issue or a shell command.

The server validates callback origin/state, uses PKCE, and exchanges the code
itself. Login sessions expire after ten minutes and are consumed once. Google
access/refresh tokens and subscription project binding stay in server-side
secret storage. No browser RPC returns them. The app configuration comes from
the installed native Antigravity ACP 1.4.1 package, not an account profile;
Python 3 and that vendor package must exist on the pool server. Missing or unsafe
packages refuse login. The package is neither downloaded nor executed by login.

This first integration supports an already activated **personal** subscription.
Missing subscription projects and enterprise/GCP-managed authorization refuse
login; there is no automatic enrollment, paid API-key fallback or local token
import. Existing account admission, project policy and trusted-client purpose
checks apply. Adding an account does not opt it into automation.

## Client contract

For the existing BB provider `acp-agy`, Pooler contributes only:

- `OXI_AGY_POOL_BASE_URL`: the plugin HTTP root followed by `/agy`.
- `OXI_AGY_POOL_AUTH_TOKEN`: the scoped pool credential, never a Google token.

The accepted client launcher must translate these into the native gateway
configuration and explicitly select `auth.type=gateway`. URL/key environment
variables alone do **not** select that authentication mode. Deploy the compatible
repository-managed native launcher separately on every client host before
turning on pooled AGY sessions. A plugin-only update cannot replace that launcher.
Legacy sessions without pool contributions retain their existing native login.
Pooled launchers currently support unmanaged Linux/macOS hosts: any native OS
admin-policy file or uncertain metadata refuses startup rather than merging a
higher-priority gateway URL with the pool credential. Modern and legacy gateway
header overrides are removed. Managed gateway support is not implemented.

External trusted clients use the same scoped pool credential as other pool
routes. The native GenAI base is `B/agy`, where `B` is the plugin HTTP root.
Routes are `GET B/agy/v1beta/models` and
`POST B/agy/v1beta/models/{model}:generateContent` or `:streamGenerateContent`.
Models must come from the authenticated catalog. BB route registration is exact:
login and catalog responses register validated model IDs; only those IDs are
cached, up to 512 total. Unsupported actions or unknown model paths refuse.
The standalone host recognizes the same native paths directly.

The pool binds each native request to the selected server-side subscription
project, sends it to Code Assist and unwraps successful JSON/SSE response
frames. It does not expose outer account metadata. Refresh happens server-side
through the normal guarded transport. It does not translate local workspace
tools, provision enterprise projects or provide a general quota API.

## Evidence boundary

Automated tests use synthetic OAuth responses, a fake plugin host and native
launcher stubs. They cover central login, project/purpose denial, server-only
credentials, catalog registration, unary/SSE framing, refresh, cancellation and
unchanged legacy launcher behavior. These tests do not prove live Google consent,
subscription availability, a model response or vendor signature provenance.
No subscription windows are invented: quota headroom remains unknown until a
separately supported source exists. This is not the Codex budget endpoint.
